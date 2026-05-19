// connectors/telegram/index.ts — TelegramConnector implementing ConnectorInterface

import { Bot } from 'grammy'
import type { ConnectorInterface, NormalizedMessage, DeliveryTarget, DeliveryResult, MediaItem } from '../types.js'
import type { TelegramConnectorConfig } from '../../config/schema.js'
import { normalize } from './normalize.js'
import { deriveSessionKey } from './session-key.js'
import { ConnectorStartupError, ConnectorSendError } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'

// Extend NormalizedMessage to carry sessionKey for the pipeline.
type NormalizedMessageWithKey = NormalizedMessage & { sessionKey: string }

export class TelegramConnector implements ConnectorInterface {
  readonly type = 'telegram'
  readonly accountId: string

  private bot: Bot
  private config: TelegramConnectorConfig
  private messageCallback: ((msg: NormalizedMessage) => void) | null = null
  private healthy = false
  private botId: number | null = null

  constructor(config: TelegramConnectorConfig) {
    this.accountId = config.accountId
    this.config = config
    this.bot = new Bot(config.token)
  }

  async startAccount(): Promise<void> {
    // Verify token by fetching bot info.
    try {
      const me = await this.bot.api.getMe()
      this.botId = me.id
      logger.info(
        { accountId: this.accountId, botUsername: me.username },
        'TelegramConnector: authenticated',
      )
    } catch (err) {
      // Auth failures are fatal; network failures are retryable.
      const isAuth = String(err).includes('401') || String(err).includes('Unauthorized')
      throw new ConnectorStartupError(
        `TelegramConnector: failed to authenticate bot "${this.accountId}": ${String(err)}`,
        !isAuth, // retryable if not auth error
        { cause: String(err) },
      )
    }

    // Register message handler.
    this.bot.on('message', (ctx) => {
      if (this.messageCallback == null || this.botId == null) return
      try {
        const normalized = normalize(ctx, this.accountId, this.botId)
        if (normalized == null) return
        // Attach session key.
        const withKey = normalized as NormalizedMessageWithKey
        withKey.sessionKey = deriveSessionKey(this.accountId, ctx.chat.id)
        this.messageCallback(withKey)
      } catch (err) {
        logger.warn({ accountId: this.accountId, err }, 'TelegramConnector: normalize() threw — dropping event')
      }
    })

    this.bot.on('channel_post', (ctx) => {
      if (this.messageCallback == null || this.botId == null) return
      try {
        const normalized = normalize(ctx, this.accountId, this.botId)
        if (normalized == null) return
        const withKey = normalized as NormalizedMessageWithKey
        withKey.sessionKey = deriveSessionKey(this.accountId, ctx.chat.id)
        this.messageCallback(withKey)
      } catch (err) {
        logger.warn({ accountId: this.accountId, err }, 'TelegramConnector: normalize() threw for channel_post')
      }
    })

    this.healthy = true

    if (this.config.mode === 'webhook' && this.config.webhookUrl != null) {
      // Webhook mode — hono HTTP server handles incoming updates.
      // The webhook path is registered separately by GatewayRunner.
      logger.info({ accountId: this.accountId, webhookUrl: this.config.webhookUrl }, 'TelegramConnector: webhook mode')
    } else {
      // Long-polling mode.
      this.bot.start({
        onStart: (info) => {
          logger.info({ accountId: this.accountId, botUsername: info.username }, 'TelegramConnector: polling started')
        },
      }).catch((err) => {
        this.healthy = false
        logger.error({ accountId: this.accountId, err }, 'TelegramConnector: polling loop crashed')
      })
    }
  }

  async stopAccount(): Promise<void> {
    this.healthy = false
    await this.bot.stop()
    logger.info({ accountId: this.accountId }, 'TelegramConnector: stopped')
  }

  isHealthy(): boolean {
    return this.healthy
  }

  async send(
    target: DeliveryTarget,
    text: string,
    _media?: MediaItem[],
  ): Promise<DeliveryResult> {
    // v0: text only. Media delivery deferred.
    if (!text.trim()) return { ok: true }
    try {
      const sent = await this.bot.api.sendMessage(Number(target.chatId), text, {
        ...(target.replyToMessageId != null
          ? { reply_parameters: { message_id: Number(target.replyToMessageId) } }
          : {}),
      })
      return { ok: true, sentMessageId: String(sent.message_id) }
    } catch (err) {
      throw new ConnectorSendError(
        `TelegramConnector: sendMessage failed: ${String(err)}`,
        { cause: String(err), chatId: target.chatId },
      )
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      await this.bot.api.sendChatAction(Number(chatId), 'typing')
    } catch {
      // Best-effort — do not propagate typing errors.
    }
  }

  onMessage(callback: (msg: NormalizedMessage) => void): void {
    this.messageCallback = callback
  }
}
