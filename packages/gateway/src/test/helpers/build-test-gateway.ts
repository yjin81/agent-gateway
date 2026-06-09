// src/test/helpers/build-test-gateway.ts
// Factory that wires up a GatewayRunner with FakeConnector + EmbeddedAdapter
// and an in-memory SQLite DB — no file I/O, no network.

import { GatewayRunner } from '../../core/gateway.js'
import { EmbeddedAdapter } from '../../adapter/embedded/index.js'
import { FakeConnector } from './fake-connector.js'
import type { AgentAdapter, AgentRequest, AgentResponse } from '../../adapter/types.js'
import type { GatewayConfig } from '../../config/schema.js'

/** Minimal GatewayConfig sufficient for tests. */
export function makeConfig(overrides: Partial<GatewayConfig['gateway']> = {}): GatewayConfig {
  return {
    gateway: {
      idleTimeoutMs: 60_000,
      adapterTimeoutMs: 10_000,
      approvalTimeoutMs: 30_000,
      shutdownTimeoutMs: 5_000,
      pendingQueueCap: 1,
      dataDir: ':memory-test:',
      logLevel: 'silent',
      ...overrides,
    },
    http: { port: 0 },
    connectors: [],
    adapter: { type: 'http', url: 'http://localhost:9999/run', accountId: 'test' },
  } as unknown as GatewayConfig
}

export interface TestGateway {
  connector: FakeConnector
  runner: GatewayRunner
  stop: () => Promise<void>
}

/**
 * Build and start a minimal GatewayRunner for integration tests.
 * Uses an in-memory DB path so no files are created.
 */
export async function buildTestGateway(opts: {
  handler?: (req: AgentRequest) => Promise<AgentResponse>
  adapter?: AgentAdapter
  configOverrides?: Partial<GatewayConfig['gateway']>
} = {}): Promise<TestGateway> {
  const connector = new FakeConnector('test-account')

  const handler = opts.handler ?? (async (req) => ({
    text: `echo: ${req.message}`,
    media: [],
    interrupted: false,
  }))

  const adapter = opts.adapter ?? new EmbeddedAdapter({ run: handler })

  const config = makeConfig(opts.configOverrides)

  // Use OS temp dir for the data dir so SQLite files don't collide across tests.
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dataDir = mkdtempSync(join(tmpdir(), 'agw-test-'))
  config.gateway.dataDir = dataDir

  const runner = new GatewayRunner({
    config,
    connectors: [connector],
    adapter,
    skipSignalHandlers: true,
  })

  // start() also launches the HTTP server — use port 0 to bind to any free port.
  await runner.start()

  return {
    connector,
    runner,
    stop: () => runner.stop(),
  }
}
