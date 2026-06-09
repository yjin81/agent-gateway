// core/gateway.ts — GatewayRunner: lifecycle, HTTP server, supervisor + admin wiring

import Database from 'better-sqlite3'
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

import type { ConnectorInterface } from '../connectors/types.js'
import type { AgentAdapter } from '../adapter/types.js'
import type { GatewayConfig, ConnectorConfig } from '../config/schema.js'
import { SessionRegistry } from './session/registry.js'
import { SessionRunRegistry } from './session/run-slot.js'
import { AuditLog } from './audit.js'
import { runTurn } from './pipeline/index.js'
import { ConnectorSupervisor } from '../admin/supervisor.js'
import { AdapterManager } from '../admin/adapter-manager.js'
import { AdminAuth } from '../admin/auth.js'
import { mountAdmin } from '../admin/index.js'
import type { ConfigStore } from '../admin/config-store.js'
import { EnvStore } from '../admin/env-store.js'
import { logger, setLogLevel } from '../lib/logger.js'

const GATEWAY_VERSION = '1.0.0'

/** Connectors that expose a Hono sub-app for webhook/HTTP handling. */
interface WebhookConnector extends ConnectorInterface {
  readonly app: Hono
}

function isWebhookConnector(c: ConnectorInterface): c is WebhookConnector {
  return 'app' in c && (c as WebhookConnector).app instanceof Hono
}

/** Resolve a webhook connector's mount path from its config (duck-typed). */
function mountPathFor(connector: ConnectorInterface): string {
  const cfg = (connector as unknown as { config?: { webhookPath?: string; listenPath?: string } }).config
  return cfg?.webhookPath ?? cfg?.listenPath ?? `/${connector.type}`
}

export interface GatewayRunnerOptions {
  config: GatewayConfig
  connectors: ConnectorInterface[]
  adapter: AgentAdapter
  /** Enables the admin control plane (hot-reload). When absent, admin is off. */
  configStore?: ConfigStore
  /** If true, skip registering SIGTERM/SIGINT handlers. Useful in tests. */
  skipSignalHandlers?: boolean
}

export class GatewayRunner {
  private config: GatewayConfig
  private readonly initialConnectors: ConnectorInterface[]
  private adapterManager: AdapterManager
  private sessionRegistry!: SessionRegistry
  private runRegistry: SessionRunRegistry
  private auditLog!: AuditLog
  private supervisor!: ConnectorSupervisor
  private approvalMap = new Map<string, (result: 'approved' | 'denied') => void>()
  private stopped = false
  private httpServer: ReturnType<typeof serve> | null = null
  private readonly configStore: ConfigStore | undefined
  private readonly skipSignalHandlers: boolean
  private readonly bootTime = Date.now()

  constructor(opts: GatewayRunnerOptions) {
    this.config = opts.config
    this.initialConnectors = opts.connectors
    this.adapterManager = new AdapterManager(opts.adapter)
    this.runRegistry = new SessionRunRegistry()
    this.configStore = opts.configStore
    this.skipSignalHandlers = opts.skipSignalHandlers ?? false
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

    // Build the connector supervisor with the turn dispatch handler.
    this.supervisor = new ConnectorSupervisor({
      dataDir,
      shutdownTimeoutMs: this.config.gateway.shutdownTimeoutMs,
      onMessage: (connector, msg) =>
        runTurn(msg, {
          connector,
          adapter: this.adapterManager,
          sessionRegistry: this.sessionRegistry,
          runRegistry: this.runRegistry,
          auditLog: this.auditLog,
          config: this.config,
          approvalMap: this.approvalMap,
        }),
    })

    // Build the shared Hono HTTP server (webhook dispatch + admin).
    this.startHttpServer()

    // Start connectors (paired with their config by index — index.ts builds
    // connectors from config.connectors in order).
    const entries = this.initialConnectors.map((connector, i) => ({
      connector,
      config: this.config.connectors[i] as ConnectorConfig,
    }))
    await this.supervisor.startAll(entries)

    // Boot fail-fast: a connector left in `error` after startup is fatal at boot.
    const failed = this.supervisor.getStatuses().filter((s) => s.status === 'error')
    if (failed.length > 0 && !this.skipSignalHandlers) {
      logger.fatal({ failed }, 'GatewayRunner: connector(s) failed to start')
      process.exit(1)
    }

    logger.info('GatewayRunner: all connectors started')

    if (!this.skipSignalHandlers) {
      process.on('SIGTERM', () => void this.stop())
      process.on('SIGINT', () => void this.stop())
    }
  }

  private startHttpServer(): void {
    const root = new Hono()
    const port = process.env['PORT'] != null
      ? parseInt(process.env['PORT'], 10)
      : this.config.http.port

    if (port === 0) {
      logger.debug('GatewayRunner: HTTP server skipped (port=0)')
      return
    }

    root.get('/health', (c) => c.json({ status: 'ok' }))

    // Admin control plane (secure by default — only when a token is configured).
    const auth = new AdminAuth({
      token: process.env['GATEWAY_ADMIN_TOKEN'],
      sessionSecret: process.env['GATEWAY_ADMIN_SESSION_SECRET'],
    })
    if (auth.enabled && this.configStore != null) {
      mountAdmin(root, {
        auth,
        configStore: this.configStore,
        envStore: new EnvStore(resolve(this.config.gateway.dataDir, '.env')),
        supervisor: this.supervisor,
        adapterManager: this.adapterManager,
        sessionRegistry: this.sessionRegistry,
        auditLog: this.auditLog,
        config: this.config,
        bootTime: this.bootTime,
        version: GATEWAY_VERSION,
        cookieSecure: process.env['GATEWAY_ADMIN_COOKIE_SECURE'] !== 'false',
      })
    } else if (auth.enabled && this.configStore == null) {
      logger.warn('GatewayRunner: GATEWAY_ADMIN_TOKEN set but no ConfigStore — admin disabled')
    }

    // Dynamic webhook dispatch: resolve the matching connector per request so
    // hot-added/removed webhook connectors route correctly without a restart.
    root.all('/*', async (c, next) => {
      const path = c.req.path
      for (const connector of this.supervisor.getConnectors()) {
        if (!isWebhookConnector(connector)) continue
        const mp = mountPathFor(connector)
        if (path === mp || path.startsWith(mp + '/')) {
          const url = new URL(c.req.url)
          url.pathname = path.slice(mp.length) || '/'
          return connector.app.fetch(new Request(url, c.req.raw))
        }
      }
      return next()
    })

    this.httpServer = serve({ fetch: root.fetch, port }, (info) => {
      logger.info({ port: info.port }, 'GatewayRunner: HTTP server listening')
    })
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    logger.info({ shutdownTimeoutMs: this.config.gateway.shutdownTimeoutMs }, 'GatewayRunner: shutting down')

    this.httpServer?.close()
    if (this.httpServer && 'closeAllConnections' in this.httpServer) {
      (this.httpServer as unknown as { closeAllConnections: () => void }).closeAllConnections()
    }

    await this.supervisor.stopAll()

    this.sessionRegistry.close()
    logger.info('GatewayRunner: shutdown complete')
  }
}
