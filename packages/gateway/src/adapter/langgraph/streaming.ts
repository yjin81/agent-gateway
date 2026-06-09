// adapter/langgraph/streaming.ts
// Bridge: graph.streamEvents() → AsyncIterable<StreamChunk>
//
// LangGraph.js emits a stream of typed events via streamEvents(). We consume
// only the events that carry token text and translate them into the gateway's
// StreamChunk interface. Everything else is silently skipped.
//
// Relevant event types:
//   on_chat_model_stream  — fired per token by a ChatModel node; the token
//                           text lives at event.data.chunk.content (string or
//                           array of content blocks).
//
// All other events (on_tool_start, on_tool_end, on_chain_start, etc.) are
// skipped — they do not contribute text to the final response.

import type { StreamChunk } from '../types.js'
import type { CompiledStateGraph } from '@langchain/langgraph'
import type { RunnableConfig } from '@langchain/core/runnables'

/**
 * Consume graph.streamEvents() and yield StreamChunks.
 *
 * @param graph        The compiled LangGraph StateGraph.
 * @param input        The state to invoke the graph with.
 * @param config       RunnableConfig — should include signal for abort support.
 * @param abortSignal  Gateway AbortSignal — checked between events.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function* streamGraphEvents(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graph: CompiledStateGraph<any, any, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: Record<string, any>,
  config: RunnableConfig,
  abortSignal?: AbortSignal,
): AsyncIterable<StreamChunk> {
  let interrupted = false

  try {
    for await (const event of graph.streamEvents(input, { ...config, version: 'v2' })) {
      if (abortSignal?.aborted) {
        interrupted = true
        break
      }

      if (event.event !== 'on_chat_model_stream') continue

      const delta = extractDelta(event.data?.chunk?.content)
      if (delta) {
        yield { delta, done: false }
      }
    }
  } catch (err) {
    // If the abort signal fired, LangGraph may throw — treat as interrupted.
    if (abortSignal?.aborted) {
      interrupted = true
    } else {
      throw err
    }
  }

  yield { delta: '', done: true, interrupted, media: [] }
}

/**
 * Extract a text delta from a LangChain message content value.
 *
 * Content can be:
 *   - a plain string                          → return it directly
 *   - an array of content blocks, each being
 *     { type: 'text', text: string }          → concatenate all text blocks
 *   - anything else                           → return ''
 */
function extractDelta(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block != null && typeof block === 'object' && 'text' in block) {
          return typeof (block as Record<string, unknown>)['text'] === 'string'
            ? (block as Record<string, unknown>)['text']
            : ''
        }
        return ''
      })
      .join('')
  }
  return ''
}
