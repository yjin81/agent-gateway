// adapter/langgraph/index.ts — LangGraphAdapter
//
// Wraps a compiled LangGraph.js StateGraph and implements AgentAdapter.
//
// Responsibilities:
//   - Load conversation history from SQLite before each turn.
//   - Clear history when isNew or wasAutoReset is true.
//   - Populate GatewayState (messages + gateway metadata) for the graph.
//   - Invoke the graph via run() (non-streaming) or stream() (streaming).
//   - Persist the new human + AI messages to history after each turn.
//   - Pass abortSignal via RunnableConfig.signal so LangGraph honours /stop.

import type { CompiledStateGraph } from '@langchain/langgraph'
import { HumanMessage } from '@langchain/core/messages'
import type { AgentAdapter, AgentRequest, AgentResponse, StreamChunk } from '../types.js'
import { MessageHistory } from './history.js'
import { streamGraphEvents } from './streaming.js'
import { GatewayAbortError } from './abort.js'

export interface LangGraphAdapterOptions {
  /**
   * Path to the SQLite database file for conversation history.
   * Defaults to './data/langgraph.db'.
   */
  dbPath?: string

  /**
   * Optional hook called before each graph invocation. Use this to inject
   * additional RunnableConfig fields (e.g. metadata, tags, callbacks).
   * The returned object is merged into the config passed to the graph.
   */
  buildConfig?: (request: AgentRequest) => Record<string, unknown>
}

export class LangGraphAdapter implements AgentAdapter {
  private readonly history: MessageHistory
  private readonly buildConfig: ((request: AgentRequest) => Record<string, unknown>) | undefined

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly graph: CompiledStateGraph<any, any, any>,
    opts: LangGraphAdapterOptions = {},
  ) {
    this.history = new MessageHistory(opts.dbPath ?? './data/langgraph.db')
    this.buildConfig = opts.buildConfig
  }

  async run(request: AgentRequest): Promise<AgentResponse> {
    const { input, config } = this._prepare(request)
    try {
      const result = await this.graph.invoke(input, config)
      const aiText = extractLastAIText(result)
      this.history.append(request.sessionKey, request.message, aiText)
      return {
        text: aiText,
        media: [],
        interrupted: request.abortSignal?.aborted ?? false,
      }
    } catch (err) {
      if (err instanceof GatewayAbortError || request.abortSignal?.aborted) {
        return { text: '', media: [], interrupted: true }
      }
      throw err
    }
  }

  async *stream(request: AgentRequest): AsyncIterable<StreamChunk> {
    const { input, config } = this._prepare(request)
    const chunks: string[] = []
    try {
      for await (const chunk of streamGraphEvents(this.graph, input, config, request.abortSignal)) {
        if (!chunk.done) {
          chunks.push(chunk.delta)
        }
        yield chunk
      }
    } catch (err) {
      if (err instanceof GatewayAbortError || request.abortSignal?.aborted) {
        yield { delta: '', done: true, interrupted: true, media: [] }
        return
      }
      throw err
    }
    // Persist history after the stream completes.
    const aiText = chunks.join('')
    this.history.append(request.sessionKey, request.message, aiText)
  }

  async onSessionReset(sessionKey: string): Promise<void> {
    this.history.clear(sessionKey)
  }

  /** Close the underlying SQLite database. Call in tests or on gateway shutdown. */
  close(): void {
    this.history.close()
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _prepare(request: AgentRequest): {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: Record<string, any>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: Record<string, any>
  } {
    const { sessionKey, message, isNew, wasAutoReset, platform, toolPolicy, abortSignal } = request

    // Clear history on new or reset sessions.
    if (isNew || wasAutoReset) {
      this.history.clear(sessionKey)
    }

    const pastMessages = this.history.load(sessionKey)

    const input = {
      messages: [...pastMessages, new HumanMessage(message)],
      sessionKey,
      isNew,
      wasAutoReset,
      platform,
      toolPolicy,
    }

    const extraConfig = this.buildConfig?.(request) ?? {}
    const config = {
      ...extraConfig,
      signal: abortSignal,
    }

    return { input, config }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the last AI message text from a graph invocation result.
 * The result is the final GatewayState — messages[] is the full history.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractLastAIText(result: Record<string, any>): string {
  const messages: unknown[] = result['messages'] ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg != null && typeof msg === 'object') {
      const m = msg as Record<string, unknown>
      // LangChain message objects have _getType() or a type field.
      const type =
        typeof (m as { _getType?: () => string })['_getType'] === 'function'
          ? (m as { _getType: () => string })['_getType']()
          : (m['type'] as string | undefined)
      if (type === 'ai') {
        const content = m['content']
        if (typeof content === 'string') return content
        if (Array.isArray(content)) {
          return content
            .map((b) =>
              b != null && typeof b === 'object' && typeof (b as Record<string, unknown>)['text'] === 'string'
                ? (b as Record<string, unknown>)['text']
                : '',
            )
            .join('')
        }
      }
    }
  }
  return ''
}

export { GatewayAbortError, checkAbort } from './abort.js'
