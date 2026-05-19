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
  botToken: z.string().min(1),
  appToken: z.string().min(1),
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

const ConnectorSchema = z.discriminatedUnion('type', [
  TelegramConnectorSchema,
  SlackConnectorSchema,
  TeamsConnectorSchema,
  OpenAIApiConnectorSchema,
])

// ── Harness schemas ──────────────────────────────────────────────────────────

const HttpHarnessSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  bearerTokenEnv: z.string().optional(),
})

const EmbeddedHarnessSchema = z.object({
  type: z.literal('embedded'),
  module: z.string().min(1),
})

const HarnessSchema = z.discriminatedUnion('type', [HttpHarnessSchema, EmbeddedHarnessSchema])

// ── Top-level gateway config ─────────────────────────────────────────────────

export const GatewayConfigSchema = z
  .object({
    gateway: z
      .object({
        dataDir: z.string().default('./data'),
        shutdownTimeoutMs: z.number().int().positive().default(60_000),
        idleTimeoutMs: z.number().int().positive().default(3_600_000),
        pendingQueueCap: z.number().int().min(1).default(1),
        approvalTimeoutMs: z.number().int().positive().default(300_000),
        harnessTimeoutMs: z.number().int().min(1_000).default(300_000),
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

    harness: HarnessSchema,
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
export type HarnessConfig = z.infer<typeof HarnessSchema>
