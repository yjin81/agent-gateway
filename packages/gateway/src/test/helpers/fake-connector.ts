// src/test/helpers/fake-connector.ts
// FakeConnector — in-process ConnectorInterface implementation for tests.
// Supports injecting messages, capturing sent replies, and streaming chunks.

import type {
  ConnectorInterface,
  NormalizedMessage,
  DeliveryTarget,
  DeliveryResult,
  MediaItem,
} from '../../connectors/types.js'
import type { StreamChunk } from '../../adapter/types.js'

export interface SentMessage {
  chatId: string
  text: string
  media: MediaItem[]
}

export interface SentChunk {
  chatId: string
  chunk: StreamChunk
  accumulated: string
}

export class FakeConnector implements ConnectorInterface {
  readonly type = 'fake'
  readonly accountId: string

  private messageCallback: ((msg: NormalizedMessage) => void) | null = null
  private _healthy = true
  private _sent: SentMessage[] = []
  private _chunks: SentChunk[] = []
  private _sendError: Error | null = null

  /** Set to true to enable streaming in tests. */
  readonly supportsStreaming: boolean

  constructor(accountId = 'test-account', opts: { supportsStreaming?: boolean } = {}) {
    this.accountId = accountId
    this.supportsStreaming = opts.supportsStreaming ?? false
  }

  // ── ConnectorInterface ─────────────────────────────────────────────────────

  async startAccount(): Promise<void> {
    this._healthy = true
  }

  async stopAccount(): Promise<void> {
    this._healthy = false
  }

  isHealthy(): boolean {
    return this._healthy
  }

  async send(target: DeliveryTarget, text: string, media: MediaItem[] = []): Promise<DeliveryResult> {
    if (this._sendError) throw this._sendError
    this._sent.push({ chatId: target.chatId, text, media })
    return { ok: true, sentMessageId: `fake-msg-${this._sent.length}` }
  }

  async sendTyping(_chatId: string): Promise<void> {
    // no-op
  }

  async sendChunk(target: DeliveryTarget, chunk: StreamChunk, accumulated: string): Promise<void> {
    this._chunks.push({ chatId: target.chatId, chunk, accumulated })
  }

  onMessage(callback: (msg: NormalizedMessage) => void): void {
    this.messageCallback = callback
  }

  // ── Test helpers ───────────────────────────────────────────────────────────

  /** Inject a NormalizedMessage as if received from the platform. */
  inject(msg: NormalizedMessage): void {
    if (!this.messageCallback) throw new Error('FakeConnector: no messageCallback registered')
    this.messageCallback(msg)
  }

  /** All messages sent via send() so far. */
  get sent(): readonly SentMessage[] {
    return this._sent
  }

  /** All chunks delivered via sendChunk() so far. */
  get chunks(): readonly SentChunk[] {
    return this._chunks
  }

  /** Clear the sent log and chunk log. */
  clearSent(): void {
    this._sent = []
    this._chunks = []
  }

  /** Make the next send() throw an error. */
  setSendError(err: Error | null): void {
    this._sendError = err
  }

  /** Mark connector as unhealthy (simulates a crash). */
  setHealthy(value: boolean): void {
    this._healthy = value
  }

  /**
   * Wait until at least `count` messages have been sent, or timeout.
   * Polls every 5ms.
   */
  waitForSent(count: number, timeoutMs = 5_000): Promise<SentMessage[]> {
    return new Promise((resolve, reject) => {
      const start = Date.now()
      const check = () => {
        if (this._sent.length >= count) return resolve([...this._sent])
        if (Date.now() - start > timeoutMs) return reject(new Error(`waitForSent(${count}) timed out after ${timeoutMs}ms — got ${this._sent.length}`))
        setTimeout(check, 5)
      }
      check()
    })
  }
}

/** Build a minimal NormalizedMessage for tests. */
export function makeMsg(overrides: Partial<NormalizedMessage> & { sessionKey?: string } = {}): NormalizedMessage & { sessionKey: string } {
  const base: NormalizedMessage & { sessionKey: string } = {
    id: 'msg-1',
    sender: { id: 'user-1', name: 'Test User', isSelf: false },
    chat: { id: 'chat-1', kind: 'dm' },
    text: 'hello',
    textRaw: 'hello',
    media: [],
    content: { mentions: [] },
    routing: { isAgentAddressed: true, accountId: 'test-account' },
    raw: {},
    sessionKey: 'v1:fake:test-account:chat-1',
    ...overrides,
  }
  return base
}
