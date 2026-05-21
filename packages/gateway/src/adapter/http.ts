// adapter/http.ts — HttpAdapter: forwards AgentRequest to an HTTP endpoint
//
// Supports two wire protocols (configured via HttpAdapterConfig.protocol):
//
//   "agent-request"    — POST AgentRequest JSON, expect AgentResponse JSON (default).
//                        Use when the URL points to an agent-gateway SDK server.
//
//   "openai-responses" — Translate AgentRequest → OpenAI Responses API body
//                        ({ input, model }), POST to the endpoint, then parse the
//                        output[] back into AgentResponse.
//                        Use when the URL points directly to a Foundry / Azure OpenAI
//                        Responses endpoint.

import type { AgentAdapter, AgentRequest, AgentResponse } from './types.js'
import { AdapterError } from '../lib/errors.js'
import { logger } from '../lib/logger.js'

export type HttpAdapterProtocol = 'agent-request' | 'openai-responses'

export interface HttpAdapterOptions {
  /** Wire protocol to use. Defaults to 'agent-request'. */
  protocol?: HttpAdapterProtocol
  /**
   * Model name forwarded in the "model" field when protocol = "openai-responses".
   * The Foundry endpoint rejects requests whose model does not match the agent's
   * configured model, so this must match exactly.
   */
  model?: string
}

export class HttpAdapter implements AgentAdapter {
  private readonly protocol: HttpAdapterProtocol
  private readonly model: string

  constructor(
    private readonly endpointUrl: string,
    private readonly getToken?: () => Promise<string>,
    opts: HttpAdapterOptions = {},
  ) {
    this.protocol = opts.protocol ?? 'agent-request'
    this.model = opts.model ?? 'gpt-4o'
  }

  async run(request: AgentRequest): Promise<AgentResponse> {
    const token = await this.getToken?.()

    const body =
      this.protocol === 'openai-responses'
        ? buildOpenAIResponsesBody(request, this.model)
        : serializeRequest(request)

    logger.debug(
      { protocol: this.protocol, url: this.endpointUrl, sessionKey: request.sessionKey, body },
      'HttpAdapter → outbound request',
    )

    let resp: Response
    try {
      resp = await fetch(this.endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token != null ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: request.abortSignal,
      })
    } catch (err) {
      throw new AdapterError(`HttpAdapter: fetch failed: ${String(err)}`, { cause: String(err) })
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new AdapterError(`HttpAdapter: upstream returned ${resp.status}: ${text}`, {
        status: resp.status,
      })
    }

    let json: unknown
    try {
      json = await resp.json()
    } catch (err) {
      throw new AdapterError(`HttpAdapter: failed to parse response JSON: ${String(err)}`)
    }

    if (json == null || typeof json !== 'object') {
      throw new AdapterError('HttpAdapter: response is not an object')
    }

    if (this.protocol === 'openai-responses') {
      const agentResponse = parseOpenAIResponsesBody(json as Record<string, unknown>)
      logger.debug(
        { protocol: this.protocol, sessionKey: request.sessionKey, rawOutput: (json as Record<string, unknown>)['output'], agentResponse },
        'HttpAdapter ← inbound response',
      )
      return agentResponse
    }

    logger.debug(
      { protocol: this.protocol, sessionKey: request.sessionKey, json },
      'HttpAdapter ← inbound response',
    )

    return json as AgentResponse
  }
}

// ── agent-request protocol ────────────────────────────────────────────────────

/** Strip non-serializable fields before sending over the wire. */
function serializeRequest(
  request: AgentRequest,
): Omit<AgentRequest, 'abortSignal' | 'progressCallback' | 'approvalCallback'> {
  const { abortSignal: _a, progressCallback: _p, approvalCallback: _ap, ...rest } = request
  return rest
}

// ── openai-responses protocol ─────────────────────────────────────────────────

/**
 * Build an OpenAI Responses API request body from an AgentRequest.
 *
 * The Responses API body: { model, input, ... }
 *
 * Each input item must carry a `type` field. User and system turns use
 * type "message". Platform context and session metadata are injected as a
 * system message so the agent has full context.
 */
function buildOpenAIResponsesBody(
  request: AgentRequest,
  model: string,
): Record<string, unknown> {
  const { message, platform, sessionKey, isNew, wasAutoReset } = request

  // Compose a system turn carrying gateway metadata the agent may find useful.
  const systemParts: string[] = [
    `Platform: ${platform.name} (${platform.chatKind})`,
    `User: ${platform.userName} (id=${platform.userId})`,
    `Session: ${sessionKey}`,
  ]
  if (isNew) systemParts.push('This is the first message in this session.')
  if (wasAutoReset) systemParts.push('The session was reset due to inactivity.')

  const input: unknown[] = [
    { type: 'message', role: 'system', content: systemParts.join('\n') },
    { type: 'message', role: 'user', content: message },
  ]

  return { model, input }
}

/**
 * Parse an OpenAI Responses API response into an AgentResponse.
 *
 * The Responses API body: { output: [ { role: 'assistant', content: [ { type: 'output_text', text } ] } ] }
 */
function parseOpenAIResponsesBody(json: Record<string, unknown>): AgentResponse {
  const output = json['output']
  if (!Array.isArray(output) || output.length === 0) {
    throw new AdapterError(
      `HttpAdapter (openai-responses): response has no output array — got: ${JSON.stringify(json).slice(0, 200)}`,
    )
  }

  // Collect all output_text content items across all assistant messages.
  const textParts: string[] = []
  for (const item of output as unknown[]) {
    if (item == null || typeof item !== 'object') continue
    const msg = item as Record<string, unknown>
    if (msg['role'] !== 'assistant') continue
    const content = msg['content']
    if (!Array.isArray(content)) continue
    for (const block of content as unknown[]) {
      if (block == null || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (b['type'] === 'output_text' && typeof b['text'] === 'string') {
        textParts.push(b['text'])
      }
    }
  }

  const text = textParts.join('\n\n').trim()
  if (!text) {
    throw new AdapterError(
      `HttpAdapter (openai-responses): no output_text found in response output`,
    )
  }

  return { text, media: [], interrupted: false }
}
