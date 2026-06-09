// src/index.ts — Gateway entry point

import { loadConfigFile, resolveConfigPath } from './config/loader.js'
import { GatewayRunner } from './core/gateway.js'
import { buildConnectors, buildAdapter } from './core/factory.js'
import { ConfigStore } from './admin/config-store.js'
import type { GatewayConfig } from './config/schema.js'
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
  const dataDir = config.gateway.dataDir
  const connectors = buildConnectors(config.connectors, dataDir)

  // Build adapter.
  const adapter = await buildAdapter(config.adapter)

  // Load the raw config store for the admin control plane (best-effort; the
  // admin surface stays off unless GATEWAY_ADMIN_TOKEN is also set).
  let configStore: ConfigStore | undefined
  try {
    configStore = await ConfigStore.load(configPath)
  } catch (err) {
    console.error(`[warn] Admin config store unavailable: ${String(err)}`)
  }

  const runner = new GatewayRunner({
    config,
    connectors,
    adapter,
    ...(configStore != null ? { configStore } : {}),
  })
  await runner.start()
}

main().catch((err) => {
  console.error('[fatal] Unhandled error during startup:', err)
  process.exit(1)
})
