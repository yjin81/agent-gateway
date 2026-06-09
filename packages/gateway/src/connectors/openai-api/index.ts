// connectors/openai-api/index.ts — OpenAI API compatibility connector
// Exposes POST /v1/chat/completions and POST /v1/responses via Hono.
// Stateless by default — session identity comes from X-Session-Id header.
//
// Streaming (v1):
//   When the request body includes "stream: true", the connector:
//     1. Returns a text/event-stream response immediately.
//     2. Sets supportsStreaming = true so the pipeline calls sendChunk().
//     3. sendChunk() enqueues SSE "data: ..." lines; the final chunk sends
//        "data: [DONE]\n\n" and closes the stream.
//
// Non-streaming path is unchanged — pendingResponses promise map.

import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { ConnectorInterface, NormalizedMessage, DeliveryTarget, DeliveryResult, MediaItem } from '../types.js'
import type { StreamChunk } from '../../adapter/types.js'
import type { OpenAIApiConnectorConfig } from '../../config/schema.js'
import { normalizeOpenAIRequest } from './normalize.js'
import { logger } from '../../lib/logger.js'

type NormalizedMessageWithKey = NormalizedMessage & { sessionKey: string }

interface SseWriter {
  enqueue(line: string): void
  close(): void
}

export class OpenAIApiConnector implements ConnectorInterface {
  readonly type = 'openai-api'
  readonly accountId: string
  readonly supportsStreaming = true

  private config: OpenAIApiConnectorConfig
  private messageCallback: ((msg: NormalizedMessage) => void) | null = null
  private healthy = false

  /** Pending responses keyed by session ID — pipeline calls send() to resolve them. */
  private pendingResponses = new Map<string, (text: string) => void>()

  /**
   * Pending SSE writers keyed by session ID.
   * Used when the client sent stream: true.
   * sendChunk() pushes SSE lines through the writer.
   */
  private pendingStreamWriters = new Map<string, SseWriter>()

  /** Hono app — mounted by GatewayRunner onto the shared HTTP server. */
  readonly app: Hono

  constructor(config: OpenAIApiConnectorConfig) {
    this.accountId = config.accountId
    this.config = config
    this.app = this.buildApp()
  }

  private buildApp(): Hono {
    const app = new Hono()
    const connector = this

    // Authentication middleware.
    app.use('*', async (c, next) => {
      if (connector.config.bearerToken != null) {
        const auth = c.req.header('Authorization')
        const expected = `Bearer ${connector.config.bearerToken}`
        if (auth !== expected) {
          return c.json({ error: { message: 'Unauthorized', type: 'auth_error', code: 401 } }, 401)
        }
      }
      await next()
    })

    // POST /v1/chat/completions
    app.post('/chat/completions', async (c) => {
      const sessionId =
        c.req.header('X-Session-Id') ??
        randomUUID()

      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400)
      }

      const normalized = normalizeOpenAIRequest(
        body as Parameters<typeof normalizeOpenAIRequest>[0],
        sessionId,
        connector.accountId,
      )
      if (normalized == null) {
        return c.json({ error: { message: 'No user message found', type: 'invalid_request_error' } }, 400)
      }

      const withKey = normalized as NormalizedMessageWithKey
      withKey.sessionKey = `v1:openai-api:${connector.accountId}:${sessionId}`

      const streamRequested = (body as { stream?: boolean }).stream === true

      if (streamRequested) {
        // ── Streaming path ────────────────────────────────────────────────────
        // Return a text/event-stream response immediately.
        // sendChunk() will push SSE data lines through the writer.
        const modelName = (body as { model?: string }).model ?? 'agent-gateway'
        const completionId = `chatcmpl-${Date.now()}`
        const created = Math.floor(Date.now() / 1000)

        const encoder = new TextEncoder()
        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
        const writer = writable.getWriter()

        const sseWriter: SseWriter = {
          enqueue(line: string) {
            void writer.write(encoder.encode(line))
          },
          close() {
            void writer.close()
          },
        }
        connector.pendingStreamWriters.set(sessionId, sseWriter)
        connector.messageCallback?.(withKey)

        // Helper: emit one SSE "data: ..." line.
        function emitChunk(delta: string, finishReason: string | null): void {
          const payload = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: modelName,
            choices: [
              {
                index: 0,
                delta: delta !== '' ? { role: 'assistant', content: delta } : {},
                finish_reason: finishReason,
              },
            ],
          }
          sseWriter.enqueue(`data: ${JSON.stringify(payload)}\n\n`)
        }

        // The pipeline will call sendChunk() as chunks arrive.
        // We need to relay those through emitChunk.
        // We do this by replacing the SseWriter after creation with one that
        // calls emitChunk — but emitChunk is defined after the writer.
        // Solution: store a richer object that has the emitChunk closure.
        const richWriter: SseWriter & { emitChunk: typeof emitChunk } = {
          enqueue: sseWriter.enqueue,
          close: sseWriter.close,
          emitChunk,
        }
        connector.pendingStreamWriters.set(sessionId, richWriter)

        return new Response(readable, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
          },
        })
      }

      // ── Non-streaming path (unchanged) ────────────────────────────────────
      // Wait for the pipeline to produce a response.
      const responseText = await new Promise<string>((resolve) => {
        connector.pendingResponses.set(sessionId, resolve)
        connector.messageCallback?.(withKey)
      })

      connector.pendingResponses.delete(sessionId)

      // Return OpenAI-compatible response.
      return c.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: (body as { model?: string }).model ?? 'agent-gateway',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: responseText },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })
    })

    return app
  }

  async startAccount(): Promise<void> {
    this.healthy = true
    logger.info({ accountId: this.accountId, listenPath: this.config.listenPath }, 'OpenAIApiConnector: ready')
  }

  async stopAccount(): Promise<void> {
    this.healthy = false
    // Reject any outstanding pending responses.
    for (const [sessionId, resolve] of this.pendingResponses) {
      resolve('Gateway is shutting down.')
      this.pendingResponses.delete(sessionId)
    }
    // Close any open SSE streams.
    for (const [sessionId, writer] of this.pendingStreamWriters) {
      writer.enqueue('data: [DONE]\n\n')
      writer.close()
      this.pendingStreamWriters.delete(sessionId)
    }
    logger.info({ accountId: this.accountId }, 'OpenAIApiConnector: stopped')
  }

  isHealthy(): boolean {
    return this.healthy
  }

  async send(target: DeliveryTarget, text: string, _media?: MediaItem[]): Promise<DeliveryResult> {
    const resolve = this.pendingResponses.get(target.chatId)
    if (resolve != null) {
      resolve(text)
      return { ok: true }
    }
    logger.warn({ chatId: target.chatId, accountId: this.accountId }, 'OpenAIApiConnector: send() called but no pending response')
    return { ok: false }
  }

  async sendChunk(
    target: DeliveryTarget,
    chunk: StreamChunk,
    accumulated: string,
  ): Promise<void> {
    type RichSseWriter = SseWriter & { emitChunk(delta: string, finishReason: string | null): void }
    const writer = this.pendingStreamWriters.get(target.chatId) as RichSseWriter | undefined

    if (writer != null) {
      // ── SSE streaming path ─────────────────────────────────────────────────
      if (chunk.done) {
        writer.emitChunk('', 'stop')
        writer.enqueue('data: [DONE]\n\n')
        writer.close()
        this.pendingStreamWriters.delete(target.chatId)
      } else if (chunk.delta !== '') {
        writer.emitChunk(chunk.delta, null)
      }
    } else if (chunk.done) {
      // ── Non-streaming client used stream:false but pipeline called sendChunk ─
      // Resolve the pending response promise with the fully accumulated text.
      const resolve = this.pendingResponses.get(target.chatId)
      if (resolve != null) {
        resolve(accumulated)
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async sendTyping(_chatId: string): Promise<void> {
    // No typing indicator for OpenAI API compat.
  }

  onMessage(callback: (msg: NormalizedMessage) => void): void {
    this.messageCallback = callback
  }
}
