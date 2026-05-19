// src/index.ts — Gateway entry point

import { loadConfigFile, resolveConfigPath } from './config/loader.js'
import { GatewayRunner } from './core/gateway.js'
import { TelegramConnector } from './connectors/telegram/index.js'
import { OpenAIApiConnector } from './connectors/openai-api/index.js'
import { HTTPHarness } from './harness/http.js'
import { EmbeddedHarness } from './harness/embedded.js'
import type { ConnectorInterface } from './connectors/types.js'
import type { AgentHarness } from './harness/types.js'
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
  for (const connectorConfig of config.connectors) {
    switch (connectorConfig['type']) {
      case 'telegram':
        connectors.push(new TelegramConnector(connectorConfig))
        break
      case 'openai-api':
        connectors.push(new OpenAIApiConnector(connectorConfig))
        break
      case 'slack':
        logger.warn({ accountId: connectorConfig['accountId'] }, 'Slack connector is v1 — not yet implemented')
        break
      case 'teams':
        logger.warn({ accountId: connectorConfig['accountId'] }, 'Teams connector is v1 — not yet implemented')
        break
    }
  }

  // Build harness.
  let harness: AgentHarness
  if (config.harness.type === 'http') {
    const harnessConfig = config.harness
    harness = new HTTPHarness(
      harnessConfig.url,
      harnessConfig.bearerTokenEnv != null
        ? async () => process.env[harnessConfig.bearerTokenEnv!] ?? ''
        : undefined,
    )
  } else {
    // embedded — dynamically import the module.
    const embeddedConfig = config.harness
    const mod = await import(embeddedConfig.module)
    const inner = (mod.default ?? mod) as AgentHarness
    harness = new EmbeddedHarness(inner)
  }

  const runner = new GatewayRunner({ config, connectors, harness })
  await runner.start()
}

main().catch((err) => {
  console.error('[fatal] Unhandled error during startup:', err)
  process.exit(1)
})
