// src/index.ts — Gateway entry point

import { loadConfigFile, resolveConfigPath } from './config/loader.js'
import { GatewayRunner } from './core/gateway.js'
import { TelegramConnector } from './connectors/telegram/index.js'
import { OpenAIApiConnector } from './connectors/openai-api/index.js'
import { WechatConnector } from './connectors/wechat/index.js'
import { SlackConnector } from './connectors/slack/index.js'
import { HttpAdapter } from './adapter/http.js'
import { EmbeddedAdapter } from './adapter/embedded.js'
import type { AgentAdapter } from './adapter/types.js'
import type { ConnectorInterface } from './connectors/types.js'
import type { GatewayConfig } from './config/schema.js'
import { logger } from './lib/logger.js'
import { ConfigValidationError } from './lib/errors.js'

async function main(): Promise<void> {
  const configPath = resolveConfigPath()

  let config: GatewayConfig
  try {
    config = await loadConfigFile(configPath)
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      console.error(`[fatal] ${err.message}`)
    } else {
      console.error(`[fatal] Failed to load config: ${String(err)}`)
    }
    process.exit(1)
  }

  // Build connectors.
  const connectors: ConnectorInterface[] = []
  const dataDir = config.gateway.dataDir
  for (const connectorConfig of config.connectors) {
    switch (connectorConfig['type']) {
      case 'telegram':
        connectors.push(new TelegramConnector(connectorConfig))
        break
      case 'openai-api':
        connectors.push(new OpenAIApiConnector(connectorConfig))
        break
      case 'wechat':
        connectors.push(new WechatConnector(connectorConfig, dataDir))
        break
    case 'slack':
        connectors.push(new SlackConnector(connectorConfig))
        break
      case 'teams':
        logger.warn({ accountId: connectorConfig['accountId'] }, 'Teams connector is v1 — not yet implemented')
        break
    }
  }

  // Build adapter.
  let adapter: AgentAdapter
  if (config.adapter.type === 'http') {
    const adapterConfig = config.adapter
    adapter = new HttpAdapter(
      adapterConfig.url,
      adapterConfig.bearerTokenEnv != null
        ? async () => process.env[adapterConfig.bearerTokenEnv!] ?? ''
        : undefined,
      { protocol: adapterConfig.protocol, ...(adapterConfig.model != null ? { model: adapterConfig.model } : {}) },
    )
  } else {
    // embedded — dynamically import the module.
    const embeddedConfig = config.adapter
    const mod = await import(embeddedConfig.module)
    const inner = (mod.default ?? mod) as AgentAdapter
    adapter = new EmbeddedAdapter(inner)
  }

  const runner = new GatewayRunner({ config, connectors, adapter })
  await runner.start()
}

main().catch((err) => {
  console.error('[fatal] Unhandled error during startup:', err)
  process.exit(1)
})
