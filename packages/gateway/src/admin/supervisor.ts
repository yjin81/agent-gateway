// admin/supervisor.ts — ConnectorSupervisor: per-accountId connector lifecycle
// with graceful drain, health-watch reconnect, and config-diff hot-reload.
//
// Extracted from GatewayRunner so the admin control plane can mutate the running
// connector set safely (add / remove / restart changed connectors only) while
// unaffected connectors keep running untouched.

import type { ConnectorInterface, NormalizedMessage } from '../connectors/types.js'
import type { ConnectorConfig } from '../config/schema.js'
import { buildConnector } from '../core/factory.js'
import { logger } from '../lib/logger.js'

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 60_000
const HEALTH_CHECK_INTERVAL_MS = 5_000
const DRAIN_POLL_MS = 50

export type ConnectorStatus = 'running' | 'stopped' | 'error'

export interface ConnectorStatusInfo {
  accountId: string
  type: string
  status: ConnectorStatus
  lastError?: string
  supportsStreaming: boolean
  activeTurns: number
}

interface Supervised {
  connector: ConnectorInterface
  config: ConnectorConfig
  status: ConnectorStatus
  lastError?: string
  activeTurns: number
  healthTimer: ReturnType<typeof setTimeout> | null
}

export interface SupervisorDeps {
  dataDir: string
  /** Bound on graceful drain when stopping a connector. */
  shutdownTimeoutMs: number
  /** Invoked for each inbound message; the returned promise tracks the turn. */
  onMessage: (connector: ConnectorInterface, msg: NormalizedMessage) => Promise<unknown>
}

export interface ApplyResult {
  added: string[]
  removed: string[]
  changed: string[]
  /** Per-accountId errors encountered while applying. */
  errors: Record<string, string>
}

export class ConnectorSupervisor {
  private readonly map = new Map<string, Supervised>()
  private stopped = false

  constructor(private readonly deps: SupervisorDeps) {}

  /** Adopt pre-built connectors with their configs and start them. */
  async startAll(entries: { connector: ConnectorInterface; config: ConnectorConfig }[]): Promise<void> {
    for (const { connector, config } of entries) {
      const sup: Supervised = {
        connector,
        config,
        status: 'stopped',
        activeTurns: 0,
        healthTimer: null,
      }
      this.map.set(connector.accountId, sup)
      this.wire(sup)
      await this.startOne(sup)
    }
  }

  /** Snapshot of every connector's status. */
  getStatuses(): ConnectorStatusInfo[] {
    return [...this.map.values()].map((s) => ({
      accountId: s.connector.accountId,
      type: s.connector.type,
      status: s.status,
      ...(s.lastError != null ? { lastError: s.lastError } : {}),
      supportsStreaming: s.connector.supportsStreaming === true,
      activeTurns: s.activeTurns,
    }))
  }

  /** Webhook-capable connectors currently registered (for HTTP dispatch). */
  getConnectors(): ConnectorInterface[] {
    return [...this.map.values()].map((s) => s.connector)
  }

  /**
   * Diff the running connector set against `next` (by accountId + deep-equal of
   * config) and apply: stop removed, restart changed, start added. Failures are
   * isolated per-connector and surfaced in the result.
   */
  async applyConfig(next: ConnectorConfig[]): Promise<ApplyResult> {
    const result: ApplyResult = { added: [], removed: [], changed: [], errors: {} }
    const nextById = new Map(next.map((c) => [c.accountId, c]))

    // Removed: present now, absent in next.
    for (const accountId of [...this.map.keys()]) {
      if (!nextById.has(accountId)) {
        result.removed.push(accountId)
        try {
          await this.remove(accountId)
        } catch (err) {
          result.errors[accountId] = String(err)
        }
      }
    }

    // Added / changed.
    for (const cfg of next) {
      const existing = this.map.get(cfg.accountId)
      if (existing == null) {
        result.added.push(cfg.accountId)
        try {
          await this.add(cfg)
        } catch (err) {
          result.errors[cfg.accountId] = String(err)
        }
      } else if (!deepEqual(existing.config, cfg)) {
        result.changed.push(cfg.accountId)
        try {
          await this.replace(cfg)
        } catch (err) {
          result.errors[cfg.accountId] = String(err)
        }
      }
    }

    return result
  }

  /** Gracefully restart a single connector (drain → stop → start). */
  async restart(accountId: string): Promise<void> {
    const sup = this.map.get(accountId)
    if (sup == null) throw new Error(`No connector with accountId "${accountId}"`)
    await this.stopOne(sup)
    await this.startOne(sup)
  }

  /** Stop and dispose every connector (graceful shutdown). */
  async stopAll(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.map.values()].map((s) => this.stopOne(s)))
    this.map.clear()
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async add(cfg: ConnectorConfig): Promise<void> {
    const connector = buildConnector(cfg, this.deps.dataDir)
    const sup: Supervised = {
      connector,
      config: cfg,
      status: 'stopped',
      activeTurns: 0,
      healthTimer: null,
    }
    this.map.set(cfg.accountId, sup)
    this.wire(sup)
    await this.startOne(sup)
  }

  private async replace(cfg: ConnectorConfig): Promise<void> {
    await this.remove(cfg.accountId)
    await this.add(cfg)
  }

  private async remove(accountId: string): Promise<void> {
    const sup = this.map.get(accountId)
    if (sup == null) return
    await this.stopOne(sup)
    this.map.delete(accountId)
  }

  private wire(sup: Supervised): void {
    sup.connector.onMessage((msg) => {
      if (this.stopped) return
      sup.activeTurns += 1
      void this.deps
        .onMessage(sup.connector, msg)
        .catch((err) => {
          logger.error(
            { accountId: sup.connector.accountId, messageId: msg.id, err },
            'ConnectorSupervisor: unhandled error from onMessage',
          )
        })
        .finally(() => {
          sup.activeTurns -= 1
        })
    })
  }

  private async startOne(sup: Supervised): Promise<void> {
    await this.startWithReconnect(sup)
    this.watchHealth(sup)
  }

  private async stopOne(sup: Supervised): Promise<void> {
    if (sup.healthTimer != null) {
      clearTimeout(sup.healthTimer)
      sup.healthTimer = null
    }
    // Drain in-flight turns, bounded by shutdownTimeoutMs. In-flight turns hold
    // their own connector reference and complete even after stopAccount().
    await this.drain(sup)
    try {
      await sup.connector.stopAccount()
    } catch (err) {
      logger.warn(
        { accountId: sup.connector.accountId, err },
        'ConnectorSupervisor: connector stop error',
      )
    }
    sup.status = 'stopped'
  }

  private async drain(sup: Supervised): Promise<void> {
    const deadline = Date.now() + this.deps.shutdownTimeoutMs
    while (sup.activeTurns > 0 && Date.now() < deadline) {
      await sleep(DRAIN_POLL_MS)
    }
    if (sup.activeTurns > 0) {
      logger.warn(
        { accountId: sup.connector.accountId, activeTurns: sup.activeTurns },
        'ConnectorSupervisor: drain timed out',
      )
    }
  }

  private watchHealth(sup: Supervised): void {
    const check = async (): Promise<void> => {
      if (this.stopped) return
      if (!sup.connector.isHealthy()) {
        logger.warn(
          { accountId: sup.connector.accountId },
          'ConnectorSupervisor: connector unhealthy — reconnecting',
        )
        try {
          await sup.connector.stopAccount()
        } catch {
          // Best-effort cleanup before reconnect.
        }
        await this.startWithReconnect(sup)
      }
      if (!this.stopped && this.map.has(sup.connector.accountId)) {
        sup.healthTimer = setTimeout(() => void check(), HEALTH_CHECK_INTERVAL_MS)
      }
    }
    sup.healthTimer = setTimeout(() => void check(), HEALTH_CHECK_INTERVAL_MS)
  }

  private async startWithReconnect(sup: Supervised): Promise<void> {
    let backoff = RECONNECT_BASE_MS
    while (!this.stopped) {
      try {
        await sup.connector.startAccount()
        sup.status = 'running'
        delete sup.lastError
        return
      } catch (err: unknown) {
        const isRetryable =
          err != null &&
          typeof err === 'object' &&
          'retryable' in err &&
          (err as { retryable: boolean }).retryable === true

        sup.status = 'error'
        sup.lastError = err instanceof Error ? err.message : String(err)

        if (!isRetryable) {
          logger.error(
            { accountId: sup.connector.accountId, err },
            'ConnectorSupervisor: fatal connector startup error',
          )
          // Isolation: do not crash the gateway; leave this connector in error.
          return
        }

        logger.warn(
          { accountId: sup.connector.accountId, backoffMs: backoff, err },
          'ConnectorSupervisor: connector startup failed — retrying',
        )
        await sleep(backoff)
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

/** Recursively sort object keys so structural equality ignores key order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    )
  }
  return value
}
