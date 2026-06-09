// connectors/teams/index.ts — MS Teams connector via Azure Bot Service webhook
//
// Teams is webhook-only: Azure Bot Service calls POST /api/messages (or the
// configured webhookPath) for every inbound Activity. The connector:
//   1. Validates the Azure AD JWT (handled automatically by BotFrameworkAdapter).
//   2. Normalises the Activity into a NormalizedMessage and fires the callback.
//   3. On reply, if we are still inside the original turn (Path A), calls
//      TurnContext.sendActivity() directly. Otherwise (proactive, Path B),
//      looks up the stored ConversationReference and creates a new turn.
//
// Streaming: Teams does not support editing an in-flight message, so
//   supportsStreaming is false. The pipeline will buffer all chunks and call
//   send() exactly once with the complete response — same as WeChat.

import { Hono } from 'hono'
import {
  BotFrameworkAdapter,
  TurnContext,
  ActivityTypes,
  type Activity,
  type ConversationReference,
} from 'botbuilder'
import type { ConnectorInterface, NormalizedMessage, DeliveryTarget, DeliveryResult, MediaItem } from '../types.js'
import type { TeamsConnectorConfig } from '../../config/schema.js'
import { ConnectorStartupError, ConnectorSendError } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'

export class TeamsConnector implements ConnectorInterface {
  readonly type = 'teams'
  readonly accountId: string
  readonly supportsStreaming = false

  private config: TeamsConnectorConfig
  private adapter: BotFrameworkAdapter
  private messageCallback: ((msg: NormalizedMessage) => void) | null = null
  private healthy = false

  /**
   * Active TurnContext instances keyed by conversation.id.
   * Valid only during the synchronous turn handling; removed immediately after.
   * Used by send() for Path A (in-turn reply).
   */
  private activeTurns = new Map<string, TurnContext>()

  /**
   * Persistent ConversationReference per conversation.id.
   * Used by send() for Path B (proactive reply after turn ends).
   */
  private conversationRefs = new Map<string, Partial<ConversationReference>>()

  /** Hono sub-app mounted by GatewayRunner onto the shared HTTP server. */
  readonly app: Hono

  constructor(config: TeamsConnectorConfig) {
    this.accountId = config.accountId
    this.config = config
    this.adapter = new BotFrameworkAdapter({
      appId: config.appId,
      appPassword: config.appPassword,
    })

    // Log unhandled adapter errors rather than crashing the process.
    this.adapter.onTurnError = async (_ctx, err) => {
      logger.error({ accountId: this.accountId, err }, 'TeamsConnector: unhandled turn error')
    }

    this.app = this.buildApp()
  }

  private buildApp(): Hono {
    const app = new Hono()
    const connector = this

    // Teams sends all activities to the single webhook path.
    // The path registered here is relative to the mount point, so use '/'.
    app.post('/', async (c) => {
      // BotFrameworkAdapter.processActivity expects a Node.js-style req/res.
      // Hono wraps the standard Request; we need to bridge to the Bot SDK.
      const req = c.req.raw
      const body = await req.text()

      let respondCalled = false
      let respondStatus = 200

      // Build a minimal Node-compatible req/res shim for the Bot SDK.
      // The SDK only needs: headers, body, method on req; status + end on res.
      const nodeReq = {
        headers: Object.fromEntries(req.headers.entries()),
        body,
        method: req.method,
      }

      const nodeRes = {
        status(code: number) {
          respondStatus = code
          return this
        },
        end() {
          respondCalled = true
        },
      }

      await connector.adapter.processActivity(
        nodeReq as Parameters<BotFrameworkAdapter['processActivity']>[0],
        nodeRes as Parameters<BotFrameworkAdapter['processActivity']>[1],
        async (ctx: TurnContext) => {
          await connector._onActivity(ctx)
        },
      )

      if (!respondCalled) respondStatus = 200
      return new Response(null, { status: respondStatus })
    })

    return app
  }

  private async _onActivity(ctx: TurnContext): Promise<void> {
    const activity = ctx.activity

    // Only handle Message activities; ignore typing, reactions, etc.
    if (activity.type !== ActivityTypes.Message) {
      logger.debug(
        { accountId: this.accountId, activityType: activity.type },
        'TeamsConnector: ignoring non-message activity',
      )
      return
    }

    if (!this.messageCallback) return

    const conversationId = activity.conversation?.id ?? activity.id ?? 'unknown'

    // Store the TurnContext for Path A (in-turn reply).
    this.activeTurns.set(conversationId, ctx)

    // Store ConversationReference for Path B (proactive).
    const ref = TurnContext.getConversationReference(activity)
    this.conversationRefs.set(conversationId, ref)

    const normalized = this._normalize(activity, conversationId)
    if (normalized == null) {
      this.activeTurns.delete(conversationId)
      return
    }

    logger.debug(
      {
        accountId: this.accountId,
        conversationId,
        text: normalized.text.slice(0, 120),
      },
      'TeamsConnector: message received',
    )

    // Fire callback synchronously — the pipeline will call send() before this
    // async function returns only if the agent responds inline (EmbeddedAdapter).
    // For HttpAdapter the turn will likely end before the response arrives, so
    // Path B (proactive) will be used. Both paths are supported.
    try {
      this.messageCallback(normalized)
    } finally {
      // Remove active turn — after this point only Path B is available.
      // We do NOT await the pipeline here; the gateway wires the callback
      // via wireConnector() which calls runTurn() asynchronously, so by the
      // time messageCallback() returns the turn context is still valid only
      // if runTurn itself is synchronous (never in practice). We keep the
      // turn context alive for the entire duration of _onActivity by NOT
      // deleting it here — instead we delete it after the callback resolves.
      //
      // Actually: messageCallback fires runTurn via wireConnector, which is
      // async but NOT awaited by the connector — so the turn context is only
      // valid for the synchronous slice. We keep it in the map so that if
      // send() is called synchronously (e.g. unit tests) it still works.
      // The map entry will be overwritten on the next turn for this conversation.
    }
  }

  private _normalize(activity: Activity, conversationId: string): NormalizedMessage | null {
    const text = (activity.text ?? '').trim()
    const senderId = activity.from?.id ?? 'unknown'
    const senderName = activity.from?.name ?? 'Unknown'
    const botId = activity.recipient?.id ?? ''

    // Strip @mention of the bot from the text (Teams includes it in group chats).
    const cleanText = stripMention(text, activity.recipient?.name ?? '')

    const isSelf = senderId === botId

    // Determine chat kind.
    const conversationType = activity.conversation?.conversationType ?? 'personal'
    const chatKind: NormalizedMessage['chat']['kind'] =
      conversationType === 'personal' ? 'dm' : 'channel'

    const isAgentAddressed =
      chatKind === 'dm' ||
      text.toLowerCase().includes(`<at>${(activity.recipient?.name ?? '').toLowerCase()}</at>`) ||
      cleanText !== text

    return {
      id: activity.id ?? conversationId,
      sender: { id: senderId, name: senderName, isSelf },
      chat: { id: conversationId, kind: chatKind },
      text: cleanText || text,
      textRaw: text,
      media: [],
      content: { mentions: [] },
      routing: { isAgentAddressed, accountId: this.accountId },
      raw: activity,
    }
  }

  async startAccount(): Promise<void> {
    // Validate credentials by making a lightweight check.
    // BotFrameworkAdapter does not have a test() method, so we just mark healthy.
    // Credential errors surface on the first inbound message as a 401.
    if (!this.config.appId || !this.config.appPassword) {
      throw new ConnectorStartupError(
        `TeamsConnector: appId and appPassword are required for "${this.accountId}"`,
        false,
      )
    }
    this.healthy = true
    logger.info(
      { accountId: this.accountId, webhookPath: this.config.webhookPath },
      'TeamsConnector: ready (webhook)',
    )
  }

  async stopAccount(): Promise<void> {
    this.healthy = false
    this.activeTurns.clear()
    logger.info({ accountId: this.accountId }, 'TeamsConnector: stopped')
  }

  isHealthy(): boolean {
    return this.healthy
  }

  async send(
    target: DeliveryTarget,
    text: string,
    _media?: MediaItem[],
  ): Promise<DeliveryResult> {
    const conversationId = target.chatId

    // Path A: active turn context still available.
    const ctx = this.activeTurns.get(conversationId)
    if (ctx != null) {
      try {
        const result = await ctx.sendActivity({ type: ActivityTypes.Message, text })
        logger.debug(
          { accountId: this.accountId, conversationId, activityId: result?.id },
          'TeamsConnector: sent via active turn (Path A)',
        )
        return { ok: true, ...(result?.id != null ? { sentMessageId: result.id } : {}) }
      } catch (err) {
        logger.warn(
          { accountId: this.accountId, conversationId, err },
          'TeamsConnector: Path A failed, falling through to Path B',
        )
      }
    }

    // Path B: proactive reply via stored ConversationReference.
    const ref = this.conversationRefs.get(conversationId)
    if (ref == null) {
      logger.error(
        { accountId: this.accountId, conversationId },
        'TeamsConnector: no ConversationReference for proactive reply — dropping message',
      )
      throw new ConnectorSendError(
        `TeamsConnector: no ConversationReference for conversation "${conversationId}"`,
        { chatId: conversationId },
      )
    }

    try {
      let sentId: string | undefined
      await this.adapter.continueConversation(ref, async (ctx) => {
        const result = await ctx.sendActivity({ type: ActivityTypes.Message, text })
        sentId = result?.id
      })
      logger.debug(
        { accountId: this.accountId, conversationId, sentId },
        'TeamsConnector: sent via proactive continuation (Path B)',
      )
      return { ok: true, ...(sentId != null ? { sentMessageId: sentId } : {}) }
    } catch (err) {
      logger.error({ accountId: this.accountId, conversationId, err }, 'TeamsConnector: proactive send failed')
      throw new ConnectorSendError(
        `TeamsConnector: proactive send failed for "${conversationId}": ${String(err)}`,
        { cause: String(err), chatId: conversationId },
      )
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    const ctx = this.activeTurns.get(chatId)
    if (ctx != null) {
      try {
        await ctx.sendActivity({ type: ActivityTypes.Typing })
      } catch (err) {
        logger.debug({ accountId: this.accountId, chatId, err }, 'TeamsConnector: sendTyping failed')
      }
      return
    }

    const ref = this.conversationRefs.get(chatId)
    if (ref != null) {
      try {
        await this.adapter.continueConversation(ref, async (ctx) => {
          await ctx.sendActivity({ type: ActivityTypes.Typing })
        })
      } catch {
        // Best-effort typing indicator.
      }
    }
  }

  onMessage(callback: (msg: NormalizedMessage) => void): void {
    this.messageCallback = callback
  }
}

/**
 * Strip a bot @mention tag from Teams message text.
 * Teams encodes mentions as `<at>BotName</at>`.
 */
function stripMention(text: string, botName: string): string {
  if (!botName) return text
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`<at>${escaped}<\\/at>\\s*`, 'gi'), '').trim()
}
