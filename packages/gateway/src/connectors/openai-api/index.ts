// connectors/openai-api/index.ts — OpenAI API compatibility connector
// Exposes POST /v1/chat/completions and POST /v1/responses via Hono.
// Stateless by default — session identity comes from X-Session-Id header.

import { Hono } from 'hono'
import type { ConnectorInterface, NormalizedMessage, DeliveryTarget, DeliveryResult, MediaItem } from '../types.js'
import type { OpenAIApiConnectorConfig } from '../../config/schema.js'
import { normalizeOpenAIRequest } from './normalize.js'
import { logger } from '../../lib/logger.js'

type NormalizedMessageWithKey = NormalizedMessage & { sessionKey: string }

export class OpenAIApiConnector implements ConnectorInterface {
  readonly type = 'openai-api'
  readonly accountId: string

  private config: OpenAIApiConnectorConfig
  private messageCallback: ((msg: NormalizedMessage) => void) | null = null
  private healthy = false

  /** Pending responses keyed by session ID — pipeline calls send() to resolve them. */
  private pendingResponses = new Map<string, (text: string) => void>()

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
        `openai-api:${connector.accountId}:anon:${Date.now()}`

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

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async sendTyping(_chatId: string): Promise<void> {
    // No typing indicator for OpenAI API compat.
  }

  onMessage(callback: (msg: NormalizedMessage) => void): void {
    this.messageCallback = callback
  }
}
