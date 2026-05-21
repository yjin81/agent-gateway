// connectors/wechat/index.ts — WeChat personal account connector via iLink Bot API
//
// API reference: hermes-agent/gateway/platforms/weixin.py
//
// Design:
//   - Long-poll via POST ilink/bot/getupdates (35 s server-side timeout)
//   - Every outbound message must echo the peer's latest context_token
//   - cursor (get_updates_buf) is persisted to disk between restarts
//   - Error code -14 (session expired) → 10-minute back-off
//   - Typing indicator requires typing_ticket from ilink/bot/getconfig
//   - Media upload/download via AES-128-ECB encrypted CDN (v0: inbound descriptors only)

import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ConnectorInterface, NormalizedMessage, DeliveryTarget, DeliveryResult, MediaItem } from '../types.js'
import type { WechatConnectorConfig } from '../../config/schema.js'
import { normalize, type ILinkMessage } from './normalize.js'
import { ContextTokenStore } from './context-token.js'
import { ConnectorStartupError, ConnectorSendError } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'

// ── iLink constants ──────────────────────────────────────────────────────────

const CHANNEL_VERSION = '2.2.0'
const ILINK_APP_ID = 'bot'
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0 // 2.2.0 packed

const EP_GET_UPDATES = 'ilink/bot/getupdates'
const EP_SEND_MESSAGE = 'ilink/bot/sendmessage'
const EP_SEND_TYPING = 'ilink/bot/sendtyping'
const EP_GET_CONFIG = 'ilink/bot/getconfig'

const LONG_POLL_TIMEOUT_MS = 35_000
const API_TIMEOUT_MS = 15_000
const CONFIG_TIMEOUT_MS = 10_000

const SESSION_EXPIRED_ERRCODE = -14
const MAX_CONSECUTIVE_FAILURES = 3
const RETRY_DELAY_MS = 2_000
const BACKOFF_DELAY_MS = 30_000
const SESSION_EXPIRED_BACKOFF_MS = 600_000 // 10 min

const ITEM_TEXT = 1
const MSG_TYPE_BOT = 2
const MSG_STATE_FINISH = 2
const TYPING_START = 1

const MAX_MESSAGE_LENGTH = 4000
const MESSAGE_DEDUP_TTL_MS = 300_000

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function baseInfo() {
  return { channel_version: CHANNEL_VERSION }
}

function randomWechatUin(): string {
  // Mirrors Python: base64(str(uint32))
  const num = (Math.random() * 0xffffffff) >>> 0
  return Buffer.from(String(num), 'utf-8').toString('base64')
}

function buildHeaders(token: string, bodyBytes: number): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'Content-Length': String(bodyBytes),
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
    'Authorization': `Bearer ${token}`,
  }
}

async function apiPost(
  baseUrl: string,
  endpoint: string,
  payload: Record<string, unknown>,
  token: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ ...payload, base_info: baseInfo() })
  const url = `${baseUrl.replace(/\/$/, '')}/${endpoint}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  // Merge with external abort signal
  signal?.addEventListener('abort', () => ctrl.abort(), { once: true })
  try {
    const res = await fetch(url, {
      method: 'POST',
      body,
      headers: buildHeaders(token, Buffer.byteLength(body, 'utf-8')),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`iLink POST ${endpoint} HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    return JSON.parse(text) as Record<string, unknown>
  } finally {
    clearTimeout(timer)
  }
}

// ── Message dedup ────────────────────────────────────────────────────────────

class MessageDedup {
  private readonly seen = new Map<string, number>() // messageId -> expiry timestamp

  isDuplicate(messageId: string): boolean {
    const exp = this.seen.get(messageId)
    if (exp == null) return false
    if (Date.now() > exp) {
      this.seen.delete(messageId)
      return false
    }
    return true
  }

  record(messageId: string): void {
    this.seen.set(messageId, Date.now() + MESSAGE_DEDUP_TTL_MS)
  }
}

// ── Typing ticket cache ──────────────────────────────────────────────────────

class TypingTicketCache {
  private readonly cache = new Map<string, { ticket: string; exp: number }>()
  private readonly ttlMs: number

  constructor(ttlMs = 600_000) {
    this.ttlMs = ttlMs
  }

  get(userId: string): string | undefined {
    const entry = this.cache.get(userId)
    if (!entry) return undefined
    if (Date.now() > entry.exp) {
      this.cache.delete(userId)
      return undefined
    }
    return entry.ticket
  }

  set(userId: string, ticket: string): void {
    this.cache.set(userId, { ticket, exp: Date.now() + this.ttlMs })
  }
}

// ── Sync-buf persistence ─────────────────────────────────────────────────────

function syncBufPath(dataDir: string, accountId: string): string {
  return path.join(dataDir, 'weixin', `${accountId}.sync.json`)
}

function loadSyncBuf(dataDir: string, accountId: string): string {
  const fp = syncBufPath(dataDir, accountId)
  if (!fs.existsSync(fp)) return ''
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8')) as Record<string, unknown>
    return typeof parsed['get_updates_buf'] === 'string' ? parsed['get_updates_buf'] : ''
  } catch {
    return ''
  }
}

function saveSyncBuf(dataDir: string, accountId: string, syncBuf: string): void {
  const fp = syncBufPath(dataDir, accountId)
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true })
    const tmp = fp + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ get_updates_buf: syncBuf }), 'utf-8')
    fs.renameSync(tmp, fp)
  } catch {
    // Best-effort — cursor loss only causes message replay, not data loss.
  }
}

// ── Text splitting ────────────────────────────────────────────────────────────

/** Split text into chunks at paragraph boundaries, keeping each chunk ≤ maxLen. */
function splitText(content: string, maxLen = MAX_MESSAGE_LENGTH): string[] {
  if (!content) return []
  if (content.length <= maxLen) return [content]
  const chunks: string[] = []
  const paragraphs = content.split(/\n\n+/)
  let current = ''
  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para
    if (candidate.length <= maxLen) {
      current = candidate
    } else {
      if (current) chunks.push(current)
      // Para itself may exceed maxLen — hard-split by maxLen
      if (para.length > maxLen) {
        for (let i = 0; i < para.length; i += maxLen) {
          chunks.push(para.slice(i, i + maxLen))
        }
        current = ''
      } else {
        current = para
      }
    }
  }
  if (current) chunks.push(current)
  return chunks.filter(Boolean)
}

// ── Connector ────────────────────────────────────────────────────────────────

export class WechatConnector implements ConnectorInterface {
  readonly type = 'wechat'
  readonly accountId: string

  private readonly config: WechatConnectorConfig
  private readonly dataDir: string
  private readonly ctxStore: ContextTokenStore
  private readonly typingCache = new TypingTicketCache()
  private readonly dedup = new MessageDedup()

  private messageCallback: ((msg: NormalizedMessage) => void) | null = null
  private healthy = false
  private running = false
  private pollAbort: AbortController | null = null

  /** Used to find a dataDir; injected from GatewayRunner via constructor second param. */
  constructor(config: WechatConnectorConfig, dataDir: string) {
    this.config = config
    this.accountId = config.accountId
    this.dataDir = dataDir
    this.ctxStore = new ContextTokenStore(dataDir)
  }

  onMessage(callback: (msg: NormalizedMessage) => void): void {
    this.messageCallback = callback
  }

  async startAccount(): Promise<void> {
    if (!this.config.token) {
      throw new ConnectorStartupError(
        `WechatConnector [${this.accountId}]: token is required`,
        false, // not retryable
      )
    }

    this.ctxStore.restore(this.accountId)
    this.running = true
    this.healthy = true
    this.pollAbort = new AbortController()

    // Start poll loop in background (do not await)
    void this.pollLoop(this.pollAbort.signal)

    logger.info(
      { accountId: this.accountId, baseUrl: this.config.baseUrl },
      'WechatConnector: started',
    )
  }

  async stopAccount(): Promise<void> {
    this.running = false
    this.healthy = false
    this.pollAbort?.abort()
    this.pollAbort = null
    logger.info({ accountId: this.accountId }, 'WechatConnector: stopped')
  }

  isHealthy(): boolean {
    return this.healthy
  }

  async send(
    target: DeliveryTarget,
    text: string,
    _media?: MediaItem[],
  ): Promise<DeliveryResult> {
    if (!text.trim()) return { ok: true }

    const contextToken = this.ctxStore.get(this.accountId, target.chatId)
    const chunks = splitText(text)
    let lastId: string | undefined

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      if (!chunk?.trim()) continue
      const clientId = `agw-wechat-${randomUUID().replace(/-/g, '')}`
      try {
        await this.sendTextChunk(target.chatId, chunk, contextToken, clientId)
        lastId = clientId
      } catch (err) {
        throw new ConnectorSendError(
          `WechatConnector: send failed to ${target.chatId}: ${String(err)}`,
          { cause: String(err), chatId: target.chatId },
        )
      }
      if (i < chunks.length - 1 && this.config.chunkDelayMs > 0) {
        await sleep(this.config.chunkDelayMs)
      }
    }

    return { ok: true, ...(lastId != null ? { sentMessageId: lastId } : {}) }
  }

  async sendTyping(chatId: string): Promise<void> {
    const ticket = this.typingCache.get(chatId)
    if (!ticket) return
    try {
      await apiPost(
        this.config.baseUrl,
        EP_SEND_TYPING,
        { ilink_user_id: chatId, typing_ticket: ticket, status: TYPING_START },
        this.config.token,
        CONFIG_TIMEOUT_MS,
      )
    } catch {
      // Best-effort — typing errors must never propagate
    }
  }

  // ── Private: poll loop ─────────────────────────────────────────────────────

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let syncBuf = loadSyncBuf(this.dataDir, this.accountId)
    let timeoutMs = LONG_POLL_TIMEOUT_MS
    let consecutiveFailures = 0

    while (this.running && !signal.aborted) {
      try {
        const response = await apiPost(
          this.config.baseUrl,
          EP_GET_UPDATES,
          { get_updates_buf: syncBuf },
          this.config.token,
          timeoutMs + 5_000, // outer timeout slightly longer than server-side
          signal,
        )

        // Honour server's preferred poll timeout
        const suggestedMs = response['longpolling_timeout_ms']
        if (typeof suggestedMs === 'number' && suggestedMs > 0) {
          timeoutMs = suggestedMs
        }

        const ret = response['ret'] ?? 0
        const errcode = response['errcode'] ?? 0

        if (ret !== 0 || errcode !== 0) {
          if (ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE) {
            logger.error(
              { accountId: this.accountId },
              'WechatConnector: session expired; pausing for 10 minutes',
            )
            await sleep(SESSION_EXPIRED_BACKOFF_MS, signal)
            consecutiveFailures = 0
            continue
          }
          consecutiveFailures++
          logger.warn(
            { accountId: this.accountId, ret, errcode, errmsg: response['errmsg'], consecutiveFailures },
            'WechatConnector: getupdates error',
          )
          const delay = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS
          await sleep(delay, signal)
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0
          continue
        }

        consecutiveFailures = 0

        const newSyncBuf = typeof response['get_updates_buf'] === 'string' ? response['get_updates_buf'] : ''
        if (newSyncBuf) {
          syncBuf = newSyncBuf
          saveSyncBuf(this.dataDir, this.accountId, syncBuf)
        }

        const msgs = Array.isArray(response['msgs']) ? response['msgs'] as ILinkMessage[] : []
        logger.debug(
          { accountId: this.accountId, msgCount: msgs.length },
          'WechatConnector: poll cycle ok',
        )
        for (const msg of msgs) {
          logger.debug(
            { accountId: this.accountId, fromUserId: msg.from_user_id, toUserId: msg.to_user_id, messageId: msg.message_id, itemCount: msg.item_list?.length ?? 0, raw: msg },
            'WechatConnector: raw iLink message received',
          )
          void this.processMessageSafe(msg)
        }
      } catch (err) {
        if (signal.aborted) break
        // fetch timeout manifests as an AbortError
        const isTimeout = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
        if (isTimeout) {
          // Normal long-poll timeout — retry immediately with no error count
          continue
        }
        consecutiveFailures++
        logger.error(
          { accountId: this.accountId, err, consecutiveFailures },
          'WechatConnector: poll error',
        )
        const delay = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS
        await sleep(delay, signal)
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0
      }
    }

    this.healthy = false
    logger.info({ accountId: this.accountId }, 'WechatConnector: poll loop exited')
  }

  private async processMessageSafe(message: ILinkMessage): Promise<void> {
    try {
      await this.processMessage(message)
    } catch (err) {
      logger.error(
        { accountId: this.accountId, fromUserId: message.from_user_id, err },
        'WechatConnector: unhandled error processing message',
      )
    }
  }

  private async processMessage(message: ILinkMessage): Promise<void> {
    // Dedup by message_id
    const messageId = String(message.message_id ?? '').trim()
    if (messageId) {
      if (this.dedup.isDuplicate(messageId)) return
      this.dedup.record(messageId)
    }

    const result = normalize(message, this.accountId, this.config.ilinkBotId, this.config.cdnBaseUrl)
    if (!result) return

    const { normalized, contextToken } = result

    // Enforce DM/group policies
    if (normalized.chat.kind === 'group') {
      if (this.config.groupPolicy === 'disabled') return
      // groupPolicy === 'open' → allowed
    } else {
      // DM
      if (this.config.dmPolicy === 'disabled') return
      if (this.config.dmPolicy === 'allowlist') {
        const allowed = (this.config.allowFrom ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        if (!allowed.includes(normalized.sender.id)) return
      }
    }

    // Persist context_token
    if (contextToken) {
      this.ctxStore.set(this.accountId, normalized.chat.id, contextToken)
    }

    // Fetch typing ticket in background (best-effort)
    void this.maybeFetchTypingTicket(normalized.sender.id, contextToken)

    logger.info(
      { accountId: this.accountId, chatKind: normalized.chat.kind, chatId: normalized.chat.id, messageId },
      'WechatConnector: inbound message',
    )

    logger.debug(
      { accountId: this.accountId, sessionKey: normalized.sessionKey, senderId: normalized.sender.id, text: normalized.text, mediaCount: normalized.media.length, isAgentAddressed: normalized.routing.isAgentAddressed },
      'WechatConnector: normalized message → pipeline',
    )

    this.messageCallback?.(normalized)
  }

  private async maybeFetchTypingTicket(userId: string, contextToken: string | undefined): Promise<void> {
    if (this.typingCache.get(userId)) return
    try {
      const payload: Record<string, unknown> = { ilink_user_id: userId }
      if (contextToken) payload['context_token'] = contextToken
      const response = await apiPost(
        this.config.baseUrl,
        EP_GET_CONFIG,
        payload,
        this.config.token,
        CONFIG_TIMEOUT_MS,
      )
      const ticket = String(response['typing_ticket'] ?? '')
      if (ticket) this.typingCache.set(userId, ticket)
    } catch {
      // Typing is best-effort — do not surface errors
    }
  }

  private async sendTextChunk(
    chatId: string,
    text: string,
    contextToken: string | undefined,
    clientId: string,
  ): Promise<void> {
    const message: Record<string, unknown> = {
      from_user_id: '',
      to_user_id: chatId,
      client_id: clientId,
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: [{ type: ITEM_TEXT, text_item: { text } }],
    }
    if (contextToken) message['context_token'] = contextToken
    await apiPost(
      this.config.baseUrl,
      EP_SEND_MESSAGE,
      { msg: message },
      this.config.token,
      API_TIMEOUT_MS,
    )
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return }
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}
