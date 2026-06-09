// adapter/http/index.ts — HttpAdapter: forwards AgentRequest to an HTTP endpoint
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

import type { AgentAdapter, AgentRequest, AgentResponse, StreamChunk } from '../types.js'
import { AdapterError, AdapterAbortedError } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'

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
  /**
   * Returns an API key to send as the `apiKeyHeader` header. Use for Azure
   * OpenAI / Foundry key auth (long-lived) instead of a short-lived AAD bearer
   * token. If both a bearer token and an API key are present, both headers are
   * sent.
   */
  getApiKey?: () => Promise<string>
  /** Header name for the API key. Defaults to 'api-key'. */
  apiKeyHeader?: string
}

export class HttpAdapter implements AgentAdapter {
  private readonly protocol: HttpAdapterProtocol
  private readonly model: string
  private readonly getApiKey: (() => Promise<string>) | undefined
  private readonly apiKeyHeader: string

  constructor(
    private readonly endpointUrl: string,
    private readonly getToken?: () => Promise<string>,
    opts: HttpAdapterOptions = {},
  ) {
    this.protocol = opts.protocol ?? 'agent-request'
    this.model = opts.model ?? 'gpt-4o'
    this.getApiKey = opts.getApiKey
    this.apiKeyHeader = opts.apiKeyHeader ?? 'api-key'
  }

  /**
   * Build auth headers from the configured credentials. A bearer token (if any)
   * is sent as `Authorization: Bearer …`; an API key (if any) is sent as the
   * configured `apiKeyHeader`. Empty values are treated as absent so an unset
   * env var does not send a useless empty credential.
   */
  private async authHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {}
    const token = await this.getToken?.()
    if (token != null && token !== '') headers['Authorization'] = `Bearer ${token}`
    const apiKey = await this.getApiKey?.()
    if (apiKey != null && apiKey !== '') headers[this.apiKeyHeader] = apiKey
    return headers
  }

  async run(request: AgentRequest): Promise<AgentResponse> {
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
          ...(await this.authHeaders()),
        },
        body: JSON.stringify(body),
        signal: request.abortSignal,
      })
    } catch (err) {
      if (request.abortSignal?.aborted) {
        throw new AdapterAbortedError('HttpAdapter: request aborted')
      }
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

  /**
   * Streaming path — only available for the `openai-responses` protocol.
   *
   * Sends `stream: true` to the Foundry / Azure OpenAI Responses endpoint and
   * consumes the `text/event-stream` response, yielding a `StreamChunk` per
   * `response.output_text.delta` event and a final done chunk on
   * `response.completed` / `response.failed` / `response.incomplete`.
   *
   * Falls back silently to undefined (no stream()) for the `agent-request`
   * protocol — that path does not have a standardised SSE format.
   */
  async *stream(request: AgentRequest): AsyncIterable<StreamChunk> {
    if (this.protocol !== 'openai-responses') {
      // agent-request protocol has no SSE format — fall back to run().
      // The pipeline will not call stream() on this adapter because we only
      // attach the method for openai-responses below, but guard here for safety.
      const response = await this.run(request)
      yield { delta: response.text, done: false }
      yield { delta: '', done: true, interrupted: response.interrupted, media: response.media }
      return
    }

    const body = { ...buildOpenAIResponsesBody(request, this.model), stream: true }

    logger.debug(
      { protocol: this.protocol, url: this.endpointUrl, sessionKey: request.sessionKey, streaming: true },
      'HttpAdapter → outbound SSE request',
    )

    let resp: Response
    try {
      resp = await fetch(this.endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(await this.authHeaders()),
        },
        body: JSON.stringify(body),
        signal: request.abortSignal,
      })
    } catch (err) {
      if (request.abortSignal?.aborted) {
        throw new AdapterAbortedError('HttpAdapter: SSE request aborted')
      }
      throw new AdapterError(`HttpAdapter: SSE fetch failed: ${String(err)}`, { cause: String(err) })
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new AdapterError(`HttpAdapter: upstream returned ${resp.status}: ${text}`, {
        status: resp.status,
      })
    }

    if (resp.body == null) {
      throw new AdapterError('HttpAdapter: SSE response has no body')
    }

    yield* parseSSEStream(resp.body, request.abortSignal)
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

// ── SSE stream parser ─────────────────────────────────────────────────────────

/**
 * Parse a Foundry / Azure OpenAI Responses API SSE stream into StreamChunks.
 *
 * Relevant event types:
 *   response.output_text.delta  → { delta: string }   — yield a text chunk
 *   response.completed          → {}                   — yield final done chunk
 *   response.failed             → { response.error }   — throw AdapterError
 *   response.incomplete         → {}                   — yield done+interrupted
 *
 * All other event types are silently skipped.
 */
async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal,
): AsyncIterable<StreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''

  try {
    while (true) {
      if (abortSignal?.aborted) {
        yield { delta: '', done: true, interrupted: true, media: [] }
        return
      }

      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // SSE lines are separated by \n. A blank line terminates a message.
      const lines = buffer.split('\n')
      // Keep the last (potentially incomplete) line in the buffer.
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice('event:'.length).trim()
        } else if (line.startsWith('data:')) {
          const raw = line.slice('data:'.length).trim()
          if (raw === '[DONE]') {
            // Some endpoints emit a trailing [DONE] sentinel — treat as completed.
            yield { delta: '', done: true, interrupted: false, media: [] }
            return
          }

          let payload: Record<string, unknown>
          try {
            payload = JSON.parse(raw) as Record<string, unknown>
          } catch {
            // Malformed data line — skip.
            continue
          }

          const eventType = currentEvent || (payload['type'] as string | undefined) || ''

          if (eventType === 'response.output_text.delta') {
            const delta = (payload['delta'] as string | undefined) ?? ''
            yield { delta, done: false }
          } else if (eventType === 'response.completed') {
            yield { delta: '', done: true, interrupted: false, media: [] }
            return
          } else if (eventType === 'response.incomplete') {
            yield { delta: '', done: true, interrupted: true, media: [] }
            return
          } else if (eventType === 'response.failed') {
            const errMsg =
              (((payload['response'] as Record<string, unknown> | undefined)?.['error'] as Record<string, unknown> | undefined)?.['message'] as string | undefined)
              ?? 'Foundry response failed'
            throw new AdapterError(`HttpAdapter (openai-responses SSE): ${errMsg}`)
          }
          // All other event types are silently skipped.
          currentEvent = ''
        } else if (line === '') {
          // Blank line — end of SSE message; reset event name.
          currentEvent = ''
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  // Stream ended without a terminal event — treat as complete.
  yield { delta: '', done: true, interrupted: false, media: [] }
}
