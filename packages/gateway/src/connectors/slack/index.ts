// connectors/slack/index.ts — SlackConnector using Bolt Socket Mode
//
// Socket Mode: Slack pushes events over a WebSocket to the gateway.
// No public URL or inbound firewall rules required — ideal for local dev.
// Requires an App-Level Token (xapp-...) with connections:write scope,
// and a Bot Token (xoxb-...) with the event/chat scopes.

import { App, LogLevel } from '@slack/bolt'
import type { ConnectorInterface, NormalizedMessage, DeliveryTarget, DeliveryResult, MediaItem } from '../types.js'
import type { SlackConnectorConfig } from '../../config/schema.js'
import { normalize, type SlackMessageEvent } from './normalize.js'
import { deriveSessionKey } from './session-key.js'
import { ConnectorStartupError, ConnectorSendError } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'

type NormalizedMessageWithKey = NormalizedMessage & { sessionKey: string }

// Slack message length limit (in characters). Messages longer than this are split.
const SLACK_MAX_MSG_LENGTH = 3000

export class SlackConnector implements ConnectorInterface {
  readonly type = 'slack'
  readonly accountId: string

  private app: App
  private config: SlackConnectorConfig
  private messageCallback: ((msg: NormalizedMessage) => void) | null = null
  private healthy = false
  private botUserId: string | null = null

  constructor(config: SlackConnectorConfig) {
    this.accountId = config.accountId
    this.config = config
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
      // Suppress Bolt's own console logger — we use pino.
      logLevel: LogLevel.ERROR,
    })
  }

  async startAccount(): Promise<void> {
    // Verify bot token and capture bot user ID.
    try {
      const auth = await this.app.client.auth.test()
      if (!auth.ok || !auth.user_id) {
        throw new Error(`auth.test returned ok=false: ${auth.error ?? 'unknown'}`)
      }
      this.botUserId = auth.user_id as string
      logger.info(
        { accountId: this.accountId, botUserId: this.botUserId, team: auth.team },
        'SlackConnector: authenticated',
      )
    } catch (err) {
      const isAuth = String(err).includes('invalid_auth') || String(err).includes('not_authed')
      throw new ConnectorStartupError(
        `SlackConnector: failed to authenticate "${this.accountId}": ${String(err)}`,
        !isAuth,
        { cause: String(err) },
      )
    }

    // Catch-all: log every raw Bolt event before any filtering — useful to confirm
    // Socket Mode is receiving events at all. Remove once connectivity is confirmed.
    this.app.use(async ({ payload, next }) => {
      logger.debug(
        { accountId: this.accountId, payload },
        'SlackConnector: [catch-all] raw Bolt event',
      )
      await next()
    })

    // Register message event handler.
    // Bolt automatically acknowledges events; we process after ack.
    this.app.message(async ({ event }) => {
      if (this.messageCallback == null || this.botUserId == null) return
      const msgEvent = event as SlackMessageEvent
      logger.debug(
        {
          accountId: this.accountId,
          channel: msgEvent.channel,
          channelType: msgEvent.channel_type,
          user: msgEvent.user,
          ts: msgEvent.ts,
          threadTs: msgEvent.thread_ts,
          subtype: msgEvent.subtype,
          textPreview: (msgEvent.text ?? '').slice(0, 120),
          fileCount: msgEvent.files?.length ?? 0,
        },
        'SlackConnector: raw event received',
      )
      try {
        const normalized = normalize(msgEvent, this.accountId, this.botUserId)
        if (normalized == null) {
          logger.debug(
            { accountId: this.accountId, ts: msgEvent.ts, subtype: msgEvent.subtype },
            'SlackConnector: event dropped by normalize()',
          )
          return
        }

        const isDm = msgEvent.channel_type === 'im' || msgEvent.channel_type === 'mpim'
        const withKey = normalized as NormalizedMessageWithKey
        withKey.sessionKey = deriveSessionKey(
          this.accountId,
          msgEvent.channel,
          msgEvent.user ?? '',
          msgEvent.thread_ts,
          isDm,
        )
        logger.debug(
          {
            accountId: this.accountId,
            sessionKey: withKey.sessionKey,
            chatKind: normalized.chat.kind,
            isAgentAddressed: normalized.routing.isAgentAddressed,
            text: normalized.text,
            mediaCount: normalized.media?.length ?? 0,
          },
          'SlackConnector: normalized message',
        )
        this.messageCallback(withKey)
      } catch (err) {
        logger.warn({ accountId: this.accountId, err }, 'SlackConnector: normalize() threw — dropping event')
      }
    })

    // Start the Socket Mode connection.
    try {
      await this.app.start()
      this.healthy = true
      logger.info({ accountId: this.accountId }, 'SlackConnector: Socket Mode connected')
    } catch (err) {
      throw new ConnectorStartupError(
        `SlackConnector: failed to start Socket Mode for "${this.accountId}": ${String(err)}`,
        true,
        { cause: String(err) },
      )
    }
  }

  async stopAccount(): Promise<void> {
    this.healthy = false
    try {
      await this.app.stop()
    } catch {
      // Best-effort stop.
    }
    logger.info({ accountId: this.accountId }, 'SlackConnector: stopped')
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

    // Split long messages to stay under Slack's limit.
    const chunks = splitText(text, SLACK_MAX_MSG_LENGTH)
    logger.debug(
      { accountId: this.accountId, chatId: target.chatId, chunks: chunks.length, totalLen: text.length },
      'SlackConnector: sending message',
    )

    let lastMessageTs: string | undefined
    for (const chunk of chunks) {
      try {
        const result = await this.app.client.chat.postMessage({
          channel: target.chatId,
          text: chunk,
          // Reply in-thread if the original message had a thread_ts.
          ...(target.replyToMessageId != null
            ? { thread_ts: target.replyToMessageId }
            : {}),
        })
        lastMessageTs = result.ts as string | undefined
        logger.debug(
          { accountId: this.accountId, chatId: target.chatId, ts: lastMessageTs },
          'SlackConnector: message sent',
        )
      } catch (err) {
        logger.error(
          { accountId: this.accountId, chatId: target.chatId, err },
          'SlackConnector: chat.postMessage failed',
        )
        throw new ConnectorSendError(
          `SlackConnector: chat.postMessage failed: ${String(err)}`,
          { cause: String(err), chatId: target.chatId },
        )
      }
    }

    return { ok: true, ...(lastMessageTs != null ? { sentMessageId: lastMessageTs } : {}) }
  }

  async sendTyping(_chatId: string): Promise<void> {
    // Slack does not expose a public typing indicator API for bots.
    // The Web API has no equivalent of sendChatAction('typing').
  }

  onMessage(callback: (msg: NormalizedMessage) => void): void {
    this.messageCallback = callback
  }
}

/**
 * Split text into chunks of at most maxLen characters.
 * Prefers splitting on newlines, then spaces, then hard-cuts.
 */
function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n', maxLen)
    if (cut <= 0) cut = remaining.lastIndexOf(' ', maxLen)
    if (cut <= 0) cut = maxLen
    chunks.push(remaining.slice(0, cut).trimEnd())
    remaining = remaining.slice(cut).trimStart()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}
