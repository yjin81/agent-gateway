// core/gateway.ts — GatewayRunner: lifecycle, connector wiring, reconnect loop

import Database from 'better-sqlite3'
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

import type { ConnectorInterface } from '../connectors/types.js'
import type { AgentHarness } from '../harness/types.js'
import type { GatewayConfig } from '../config/schema.js'
import { SessionRegistry } from './session/registry.js'
import { SessionRunRegistry } from './session/run-slot.js'
import { AuditLog } from './audit.js'
import { runTurn } from './pipeline/index.js'
import { logger, setLogLevel } from '../lib/logger.js'

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 60_000

export interface GatewayRunnerOptions {
  config: GatewayConfig
  connectors: ConnectorInterface[]
  harness: AgentHarness
}

export class GatewayRunner {
  private config: GatewayConfig
  private connectors: ConnectorInterface[]
  private harness: AgentHarness
  private sessionRegistry!: SessionRegistry
  private runRegistry: SessionRunRegistry
  private auditLog!: AuditLog
  private approvalMap = new Map<string, (result: 'approved' | 'denied') => void>()
  private stopped = false

  constructor(opts: GatewayRunnerOptions) {
    this.config = opts.config
    this.connectors = opts.connectors
    this.harness = opts.harness
    this.runRegistry = new SessionRunRegistry()
  }

  async start(): Promise<void> {
    setLogLevel(
      (process.env['GATEWAY_LOG_LEVEL'] as import('../lib/logger.js').LogLevel | undefined) ??
        this.config.gateway.logLevel,
    )

    const dataDir = resolve(this.config.gateway.dataDir)
    mkdirSync(dataDir, { recursive: true })

    const dbPath = resolve(dataDir, 'gateway.db')
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')

    this.sessionRegistry = new SessionRegistry(dbPath)
    this.auditLog = new AuditLog(db)

    logger.info({ dataDir, dbPath }, 'GatewayRunner: starting')

    // Start connectors with reconnect loop.
    for (const connector of this.connectors) {
      this.wireConnector(connector)
      await this.startWithReconnect(connector)
    }

    // Graceful shutdown handler.
    process.on('SIGTERM', () => void this.stop())
    process.on('SIGINT', () => void this.stop())

    logger.info('GatewayRunner: all connectors started')
  }

  private wireConnector(connector: ConnectorInterface): void {
    connector.onMessage((msg) => {
      if (this.stopped) return
      runTurn(msg, {
        connector,
        harness: this.harness,
        sessionRegistry: this.sessionRegistry,
        runRegistry: this.runRegistry,
        auditLog: this.auditLog,
        config: this.config,
        approvalMap: this.approvalMap,
      }).catch((err) => {
        logger.error(
          { accountId: connector.accountId, messageId: msg.id, err },
          'GatewayRunner: unhandled error from runTurn',
        )
      })
    })
  }

  private async startWithReconnect(connector: ConnectorInterface): Promise<void> {
    let backoff = RECONNECT_BASE_MS
    while (!this.stopped) {
      try {
        await connector.startAccount()
        backoff = RECONNECT_BASE_MS // reset on success
        return
      } catch (err: unknown) {
        const isRetryable =
          err != null &&
          typeof err === 'object' &&
          'retryable' in err &&
          (err as { retryable: boolean }).retryable === true

        if (!isRetryable) {
          logger.fatal({ accountId: connector.accountId, err }, 'GatewayRunner: fatal connector startup error')
          process.exit(1)
        }

        logger.warn(
          { accountId: connector.accountId, backoffMs: backoff, err },
          'GatewayRunner: connector startup failed — retrying',
        )
        await sleep(backoff)
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    logger.info({ shutdownTimeoutMs: this.config.gateway.shutdownTimeoutMs }, 'GatewayRunner: shutting down')

    // Stop accepting new messages — connectors will stop their polling loops.
    await Promise.allSettled(
      this.connectors.map((c) =>
        c.stopAccount().catch((err) =>
          logger.warn({ accountId: c.accountId, err }, 'GatewayRunner: connector stop error'),
        ),
      ),
    )

    this.sessionRegistry.close()
    logger.info('GatewayRunner: shutdown complete')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
