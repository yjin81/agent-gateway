// config/schema.ts — Zod schema for gateway.config.yaml (Section 16)

import { z } from 'zod'

// ── Connector schemas ────────────────────────────────────────────────────────

const BaseConnectorSchema = z.object({
  accountId: z.string().min(1),
  /** Optional idle-timeout override in milliseconds. */
  idleTimeoutMs: z.number().int().positive().optional(),
})

const TelegramConnectorSchema = BaseConnectorSchema.extend({
  type: z.literal('telegram'),
  token: z.string().min(1),
  mode: z.enum(['poll', 'webhook']).default('poll'),
  webhookUrl: z.string().url().optional(),
})

const SlackConnectorSchema = BaseConnectorSchema.extend({
  type: z.literal('slack'),
  /** Bot token (xoxb-...) — requires chat:write, im:history, channels:history, groups:history scopes. */
  botToken: z.string().min(1),
  /** App-level token (xapp-...) — requires connections:write scope. Used for Socket Mode. */
  appToken: z.string().min(1),
  /** Signing secret from the app's Basic Information page. Used to verify webhook payloads (webhook mode only). */
  signingSecret: z.string().min(1),
})

const TeamsConnectorSchema = BaseConnectorSchema.extend({
  type: z.literal('teams'),
  appId: z.string().min(1),
  appPassword: z.string().min(1),
  webhookPath: z.string().startsWith('/').default('/connectors/teams'),
})

const OpenAIApiConnectorSchema = BaseConnectorSchema.extend({
  type: z.literal('openai-api'),
  listenPath: z.string().startsWith('/').default('/v1'),
  bearerToken: z.string().optional(),
})

/**
 * WeChat personal account connector via Tencent iLink Bot API.
 * Credentials are obtained by running the QR login flow once and storing them
 * in the gateway data directory. Use ${ENV_VAR} interpolation for the token.
 *
 * Required fields come from the iLink QR login response:
 *   token      — bot_token from the confirmed QR login
 *   ilinkBotId — ilink_bot_id (the bot's WeChat user ID, used as accountUserId)
 *   baseUrl    — baseurl returned on login (region-specific iLink endpoint)
 */
const WechatConnectorSchema = BaseConnectorSchema.extend({
  type: z.literal('wechat'),
  /** Bearer token from the iLink QR login — supply via ${ENV_VAR} */
  token: z.string().min(1),
  /** The bot's own WeChat iLink user ID (ilink_bot_id from QR login response). Used to filter self-messages. */
  ilinkBotId: z.string().min(1),
  /** Region-specific iLink base URL from the QR login response. Default: https://ilinkai.weixin.qq.com */
  baseUrl: z.string().url().default('https://ilinkai.weixin.qq.com'),
  /** WeChat CDN base URL for encrypted media download/upload. Default: https://novac2c.cdn.weixin.qq.com/c2c */
  cdnBaseUrl: z.string().url().default('https://novac2c.cdn.weixin.qq.com/c2c'),
  /**
   * "open" — accept DMs from anyone (default)
   * "allowlist" — only accept DMs from ilinkUserIds listed in allowFrom
   * "disabled" — no DMs
   */
  dmPolicy: z.enum(['open', 'allowlist', 'disabled']).default('open'),
  /**
   * "open" — accept group messages where the bot is @mentioned
   * "disabled" — ignore all group messages (default)
   */
  groupPolicy: z.enum(['open', 'disabled']).default('disabled'),
  /** Comma-separated iLink user IDs allowed when dmPolicy/groupPolicy = allowlist */
  allowFrom: z.string().optional(),
  /** Delay in ms between sequential message chunks. Default: 350 */
  chunkDelayMs: z.number().int().min(0).default(350),
})

const ConnectorSchema = z.discriminatedUnion('type', [
  TelegramConnectorSchema,
  SlackConnectorSchema,
  TeamsConnectorSchema,
  OpenAIApiConnectorSchema,
  WechatConnectorSchema,
])

// ── Adapter schemas ──────────────────────────────────────────────────────────

const HttpAdapterSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  bearerTokenEnv: z.string().optional(),
  /**
   * Wire protocol used when posting to the adapter URL.
   *
   * "agent-request"     — POST AgentRequest JSON, expect AgentResponse JSON (default).
   *                       Use this when the URL points to an agent server built with
   *                       the agent-gateway SDK.
   *
   * "openai-responses"  — Translate AgentRequest → OpenAI Responses API format
   *                       ({ input, model }), then parse the response output back to
   *                       AgentResponse. Use this when the URL points directly to a
   *                       Foundry / Azure OpenAI Responses endpoint.
   */
  protocol: z.enum(['agent-request', 'openai-responses']).default('agent-request'),
  /**
   * Model name sent in the "model" field when protocol = "openai-responses".
   * Required for openai-responses; ignored for agent-request.
   */
  model: z.string().optional(),
})

const EmbeddedAdapterSchema = z.object({
  type: z.literal('embedded'),
  module: z.string().min(1),
})

const AdapterSchema = z.discriminatedUnion('type', [HttpAdapterSchema, EmbeddedAdapterSchema])

// ── Top-level gateway config ─────────────────────────────────────────────────

export const GatewayConfigSchema = z
  .object({
    gateway: z
      .object({
        dataDir: z.string().default('.'),
        shutdownTimeoutMs: z.number().int().positive().default(60_000),
        idleTimeoutMs: z.number().int().positive().default(3_600_000),
        pendingQueueCap: z.number().int().min(1).default(1),
        approvalTimeoutMs: z.number().int().positive().default(300_000),
        adapterTimeoutMs: z.number().int().min(1_000).default(300_000),
        logLevel: z
          .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
          .default('info'),
      })
      .default({}),

    connectors: z.array(ConnectorSchema).min(1),

    http: z
      .object({
        port: z.number().int().min(1).max(65_535).default(3000),
      })
      .default({}),

    adapter: AdapterSchema,
  })
  .superRefine((val, ctx) => {
    // Validate: each connector accountId must be unique.
    const seen = new Set<string>()
    for (const [i, connector] of val.connectors.entries()) {
      const aid = connector['accountId'] as string
      if (seen.has(aid)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate accountId "${aid}" — session keys would be corrupted`,
          path: ['connectors', i, 'accountId'],
        })
      }
      seen.add(aid)
      // Webhook validation for Telegram
      if (connector['type'] === 'telegram' && connector['mode'] === 'webhook' && connector['webhookUrl'] == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'webhookUrl is required when mode is "webhook"',
          path: ['connectors', i, 'webhookUrl'],
        })
      }
    }
  })

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>
export type ConnectorConfig = z.infer<typeof ConnectorSchema>
export type TelegramConnectorConfig = z.infer<typeof TelegramConnectorSchema>
export type SlackConnectorConfig = z.infer<typeof SlackConnectorSchema>
export type TeamsConnectorConfig = z.infer<typeof TeamsConnectorSchema>
export type OpenAIApiConnectorConfig = z.infer<typeof OpenAIApiConnectorSchema>
export type WechatConnectorConfig = z.infer<typeof WechatConnectorSchema>
export type AdapterConfig = z.infer<typeof AdapterSchema>
