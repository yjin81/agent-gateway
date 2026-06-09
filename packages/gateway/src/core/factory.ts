// core/factory.ts — Build connectors and adapters from validated config.
//
// Extracted from index.ts so the same construction logic is reused by the
// admin control plane's hot-reload path (ConnectorSupervisor, AdapterManager).

import { TelegramConnector } from '../connectors/telegram/index.js'
import { OpenAIApiConnector } from '../connectors/openai-api/index.js'
import { WechatConnector } from '../connectors/wechat/index.js'
import { SlackConnector } from '../connectors/slack/index.js'
import { TeamsConnector } from '../connectors/teams/index.js'
import { HttpAdapter } from '../adapter/http/index.js'
import { EmbeddedAdapter } from '../adapter/embedded/index.js'
import type { AgentAdapter } from '../adapter/types.js'
import type { ConnectorInterface } from '../connectors/types.js'
import type { ConnectorConfig, AdapterConfig } from '../config/schema.js'

/**
 * Build a single connector instance from its validated config.
 * Throws if the connector type is unknown (should be unreachable — Zod's
 * discriminated union guarantees a known type).
 */
export function buildConnector(cfg: ConnectorConfig, dataDir: string): ConnectorInterface {
  switch (cfg.type) {
    case 'telegram':
      return new TelegramConnector(cfg)
    case 'openai-api':
      return new OpenAIApiConnector(cfg)
    case 'wechat':
      return new WechatConnector(cfg, dataDir)
    case 'slack':
      return new SlackConnector(cfg)
    case 'teams':
      return new TeamsConnector(cfg)
    default: {
      const exhaustive: never = cfg
      throw new Error(`Unknown connector type: ${JSON.stringify(exhaustive)}`)
    }
  }
}

/** Build all connectors from a config's connector list. */
export function buildConnectors(
  connectors: ConnectorConfig[],
  dataDir: string,
): ConnectorInterface[] {
  return connectors.map((c) => buildConnector(c, dataDir))
}

/**
 * Build an agent adapter from its validated config.
 *
 * `http` is constructed synchronously and is hot-swappable; `embedded`
 * dynamically imports an in-process module and is code-bound (requires a
 * process restart to change — see AdapterManager).
 */
export async function buildAdapter(cfg: AdapterConfig): Promise<AgentAdapter> {
  if (cfg.type === 'http') {
    return new HttpAdapter(
      cfg.url,
      cfg.bearerTokenEnv != null
        ? async () => process.env[cfg.bearerTokenEnv!] ?? ''
        : undefined,
      {
        protocol: cfg.protocol,
        ...(cfg.model != null ? { model: cfg.model } : {}),
        ...(cfg.apiKeyEnv != null
          ? { getApiKey: async () => process.env[cfg.apiKeyEnv!] ?? '' }
          : {}),
        apiKeyHeader: cfg.apiKeyHeader,
      },
    )
  }
  // embedded — dynamically import the module.
  const mod = await import(cfg.module)
  const inner = (mod.default ?? mod) as AgentAdapter
  return new EmbeddedAdapter(inner)
}

/** True if an adapter of this type can be rebuilt and swapped live (no restart). */
export function isHotSwappableAdapter(cfg: AdapterConfig): boolean {
  return cfg.type === 'http'
}
