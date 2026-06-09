// admin/index.ts — Mounts the admin control plane onto the shared Hono server.
//
// Secure by default: callers only invoke mountAdmin() when an admin token is
// configured (auth.enabled). When disabled, no /admin routes exist and the
// surface returns the gateway's default 404.

import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'

import { AdminAuth, SESSION_COOKIE_NAME } from './auth.js'
import { ConfigStore, type RawConfig } from './config-store.js'
import { EnvStore } from './env-store.js'
import { redactConfig, mergeSecrets } from './redact.js'
import { ConnectorSupervisor } from './supervisor.js'
import { AdapterManager } from './adapter-manager.js'
import { buildAdapter, isHotSwappableAdapter } from '../core/factory.js'
import { interpolateEnvVars } from '../config/loader.js'
import { renderDashboard } from './dashboard.js'
import type { SessionRegistry } from '../core/session/registry.js'
import type { AuditLog } from '../core/audit.js'
import type { GatewayConfig, AdapterConfig } from '../config/schema.js'
import { ConfigValidationError } from '../lib/errors.js'
import { logger } from '../lib/logger.js'

const PROBE_TIMEOUT_MS = 5_000

export interface AdminDeps {
  auth: AdminAuth
  configStore: ConfigStore
  envStore: EnvStore
  supervisor: ConnectorSupervisor
  adapterManager: AdapterManager
  sessionRegistry: SessionRegistry
  auditLog: AuditLog
  /** The currently-applied, validated config. Updated on each successful apply. */
  config: GatewayConfig
  bootTime: number
  version: string
  cookieSecure: boolean
}

/** Mount the admin SPA + management API under /admin onto the given root app. */
export function mountAdmin(root: Hono, deps: AdminDeps): void {
  const { auth } = deps
  // Mutable reference to the live applied config (adapter/gateway comparisons).
  let current = deps.config

  const admin = new Hono()

  // ── Static dashboard ──────────────────────────────────────────────────────
  // Served on the root app so both `/admin` and `/admin/` resolve regardless of
  // how the sub-route normalises the mount prefix.
  root.get('/admin', (c) => c.html(renderDashboard()))
  root.get('/admin/', (c) => c.html(renderDashboard()))

  // ── Auth: login / logout ──────────────────────────────────────────────────
  admin.post('/api/login', async (c) => {
    const ip = clientIp(c.req.raw, c.req.header('x-forwarded-for'))
    if (!auth.rateLimitOk(ip)) {
      return c.json({ error: 'Too many attempts. Try again later.' }, 429)
    }
    let body: { token?: string }
    try {
      body = (await c.req.json()) as { token?: string }
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    if (typeof body.token !== 'string' || !auth.verifyToken(body.token)) {
      auth.recordFailure(ip)
      return c.json({ error: 'Invalid token' }, 401)
    }
    auth.clearFailures(ip)
    setCookie(c, SESSION_COOKIE_NAME, auth.issueSession(), {
      httpOnly: true,
      sameSite: 'Strict',
      secure: deps.cookieSecure,
      path: '/admin',
      maxAge: 3600,
    })
    return c.json({ ok: true })
  })

  admin.post('/api/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE_NAME, { path: '/admin' })
    return c.json({ ok: true })
  })

  // ── Session-cookie guard for every other /api route ───────────────────────
  admin.use('/api/*', async (c, next) => {
    const path = c.req.path
    if (path === '/admin/api/login') return next()
    const session = getCookie(c, SESSION_COOKIE_NAME)
    if (!auth.verifySession(session)) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    // Sliding renewal.
    setCookie(c, SESSION_COOKIE_NAME, auth.issueSession(), {
      httpOnly: true,
      sameSite: 'Strict',
      secure: deps.cookieSecure,
      path: '/admin',
      maxAge: 3600,
    })
    return next()
  })

  // ── Config: get / validate / put ──────────────────────────────────────────
  admin.get('/api/config', (c) => {
    return c.json({ config: redactConfig(deps.configStore.getRaw()) })
  })

  admin.post('/api/config/validate', async (c) => {
    const candidate = (await c.req.json().catch(() => null)) as RawConfig | null
    if (candidate == null) return c.json({ error: 'Invalid JSON body' }, 400)
    const merged = mergeSecrets(candidate, deps.configStore.getRaw())
    try {
      deps.configStore.validate(merged)
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ ok: false, error: errorMessage(err) }, 400)
    }
  })

  admin.put('/api/config', async (c) => {
    const candidate = (await c.req.json().catch(() => null)) as RawConfig | null
    if (candidate == null) return c.json({ error: 'Invalid JSON body' }, 400)
    const merged = mergeSecrets(candidate, deps.configStore.getRaw())

    // Validate + persist (atomic, with .bak) before touching the running set.
    let validated: GatewayConfig
    try {
      validated = await deps.configStore.write(merged)
    } catch (err) {
      return c.json({ ok: false, error: errorMessage(err) }, 400)
    }

    const result = await commitValidated(validated)
    return c.json(result.body, result.status)
  })

  // ── Connectors ────────────────────────────────────────────────────────────
  admin.get('/api/connectors', (c) => {
    return c.json({ connectors: deps.supervisor.getStatuses() })
  })

  admin.post('/api/connectors/:accountId/restart', async (c) => {
    const accountId = c.req.param('accountId')
    try {
      await deps.supervisor.restart(accountId)
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ ok: false, error: errorMessage(err) }, 404)
    }
  })

  // Edit a single existing connector in place. The connector is spliced into the
  // full config, then run through the same validate → persist → apply → rollback
  // pipeline as PUT /api/config. `accountId` is the identity key and immutable.
  admin.put('/api/connectors/:accountId', async (c) => {
    const accountId = c.req.param('accountId')
    const incoming = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (incoming == null) return c.json({ error: 'Invalid JSON body' }, 400)

    const raw = deps.configStore.getRaw()
    const connectors = Array.isArray(raw['connectors'])
      ? (raw['connectors'] as Record<string, unknown>[])
      : []
    const idx = connectors.findIndex((conn) => isObject(conn) && conn['accountId'] === accountId)
    if (idx === -1) return c.json({ ok: false, error: `Unknown connector: ${accountId}` }, 404)

    if (incoming['accountId'] != null && incoming['accountId'] !== accountId) {
      return c.json({ ok: false, error: 'accountId cannot be changed' }, 400)
    }
    const edited = { ...incoming, accountId }

    const candidate: RawConfig = {
      ...raw,
      connectors: connectors.map((conn, i) => (i === idx ? edited : conn)),
    }
    const merged = mergeSecrets(candidate, raw)

    let validated: GatewayConfig
    try {
      validated = await deps.configStore.write(merged)
    } catch (err) {
      return c.json({ ok: false, error: errorMessage(err) }, 400)
    }

    const result = await commitValidated(validated)
    return c.json(result.body, result.status)
  })

  // ── Environment variables (data/.env) ─────────────────────────────────────
  // CRUD over the data/.env file. The gateway does not read this file at runtime
  // (Docker injects it at container-create time), so changes persist to disk but
  // only take effect after the container is recreated.
  admin.get('/api/env', (c) => {
    return c.json({ vars: deps.envStore.list() })
  })

  admin.put('/api/env/:key', async (c) => {
    const key = c.req.param('key')
    if (!EnvStore.isValidKey(key)) return c.json({ ok: false, error: `Invalid env var name: ${key}` }, 400)
    const body = (await c.req.json().catch(() => null)) as { value?: unknown } | null
    if (body == null || typeof body.value !== 'string') {
      return c.json({ ok: false, error: 'Body must be { value: string }' }, 400)
    }
    deps.envStore.set(key, body.value)
    deps.auditLog.appendConfigChange(`env set: ${key} (restart required to apply)`)
    return c.json({ ok: true, requiresRestart: true })
  })

  admin.delete('/api/env/:key', (c) => {
    const key = c.req.param('key')
    const removed = deps.envStore.delete(key)
    if (!removed) return c.json({ ok: false, error: `Unknown env var: ${key}` }, 404)
    deps.auditLog.appendConfigChange(`env deleted: ${key} (restart required to apply)`)
    return c.json({ ok: true, requiresRestart: true })
  })

  // ── Adapter ───────────────────────────────────────────────────────────────
  admin.get('/api/adapter', (c) => {
    const raw = deps.configStore.getRaw()
    return c.json({
      adapter: redactConfig(raw)['adapter'],
      hotSwappable: isHotSwappableAdapter(current.adapter),
    })
  })

  admin.post('/api/adapter/test', async (c) => {
    const candidate = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (candidate == null) return c.json({ error: 'Invalid JSON body' }, 400)
    if (candidate['type'] !== 'http') {
      return c.json({ reachable: false, error: 'Only http adapters support connectivity tests' }, 400)
    }
    const interp = interpolateEnvVars(mergeSecrets({ adapter: candidate } as RawConfig, deps.configStore.getRaw())['adapter']) as Record<string, unknown>
    const probe = await probeHttp(interp)
    return c.json(probe)
  })

  admin.post('/api/adapter/restart', async (c) => {
    if (!isHotSwappableAdapter(current.adapter)) {
      return c.json({ ok: false, requiresRestart: true })
    }
    try {
      const rebuilt = await buildAdapter(current.adapter)
      await deps.adapterManager.swap(rebuilt, current.gateway.adapterTimeoutMs)
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ ok: false, error: errorMessage(err) }, 500)
    }
  })

  // ── Status / sessions / audit ─────────────────────────────────────────────
  admin.get('/api/status', (c) => {
    return c.json({
      version: deps.version,
      bootTime: deps.bootTime,
      uptimeMs: Date.now() - deps.bootTime,
      connectors: deps.supervisor.getStatuses(),
      sessionCount: deps.sessionRegistry.list(10_000).length,
      adapterType: current.adapter.type,
    })
  })

  admin.get('/api/sessions', (c) => {
    return c.json({ sessions: deps.sessionRegistry.list() })
  })

  admin.get('/api/audit', (c) => {
    return c.json({ entries: deps.auditLog.recent() })
  })

  root.route('/admin', admin)
  logger.info('admin: control plane mounted at /admin')

  // ── helpers closed over deps ──────────────────────────────────────────────

  /**
   * Apply an already-validated+persisted config to the running set: hot-reload
   * connectors, then the adapter. Rolls back the file and the connector set on
   * any failure. Returns the HTTP status + JSON body for the caller to return.
   */
  async function commitValidated(
    validated: GatewayConfig,
  ): Promise<{ status: 200 | 500; body: Record<string, unknown> }> {
    const previous = current
    const requiresRestart = computeRestartRequired(previous, validated)

    // Apply connectors (hot-reload only the changed ones).
    const connectorResult = await deps.supervisor.applyConfig(validated.connectors)

    // Roll back if any connector failed to apply.
    if (Object.keys(connectorResult.errors).length > 0) {
      logger.warn({ errors: connectorResult.errors }, 'admin: connector apply failed — rolling back')
      await deps.configStore.rollback()
      await deps.supervisor.applyConfig(previous.connectors)
      deps.auditLog.appendConfigChange('config apply failed (rolled back)', 'error', JSON.stringify(connectorResult.errors))
      return { status: 500, body: { ok: false, error: 'Connector apply failed; rolled back', connectorResult } }
    }

    // Apply adapter.
    const adapterResult = await applyAdapter(validated.adapter)
    if (adapterResult.error != null) {
      await deps.configStore.rollback()
      await deps.supervisor.applyConfig(previous.connectors)
      deps.auditLog.appendConfigChange('adapter apply failed (rolled back)', 'error', adapterResult.error)
      return { status: 500, body: { ok: false, error: `Adapter apply failed: ${adapterResult.error}` } }
    }

    current = validated
    deps.config = validated
    deps.auditLog.appendConfigChange(
      `config applied: +${connectorResult.added.length} ~${connectorResult.changed.length} -${connectorResult.removed.length}`,
    )
    return { status: 200, body: { ok: true, connectorResult, adapterResult, requiresRestart } }
  }

  async function applyAdapter(
    next: AdapterConfig,
  ): Promise<{ applied?: boolean; unchanged?: boolean; requiresRestart?: boolean; error?: string }> {
    const prev = current.adapter
    if (deepEqual(prev, next)) return { unchanged: true }
    if (next.type === 'http' && prev.type === 'http') {
      let candidate
      try {
        candidate = await buildAdapter(next)
      } catch (err) {
        return { error: errorMessage(err) }
      }
      const probe = await probeHttp(next as unknown as Record<string, unknown>)
      if (!probe.reachable) {
        return { error: `connectivity probe failed: ${probe.error ?? 'unreachable'}` }
      }
      await deps.adapterManager.swap(candidate, current.gateway.adapterTimeoutMs)
      return { applied: true }
    }
    // Code-bound adapter or a type change → cannot hot-swap.
    return { requiresRestart: true }
  }
}

// ── module-level helpers ─────────────────────────────────────────────────────

interface ProbeResult {
  reachable: boolean
  status?: number
  error?: string
}

async function probeHttp(cfg: Record<string, unknown>): Promise<ProbeResult> {
  const url = typeof cfg['url'] === 'string' ? cfg['url'] : undefined
  if (url == null) return { reachable: false, error: 'missing url' }
  const tokenEnv = typeof cfg['bearerTokenEnv'] === 'string' ? cfg['bearerTokenEnv'] : undefined
  const token = tokenEnv != null ? process.env[tokenEnv] : undefined
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: token != null ? { Authorization: `Bearer ${token}` } : {},
      signal: ctrl.signal,
    })
    return { reachable: true, status: resp.status }
  } catch (err) {
    return { reachable: false, error: String(err) }
  } finally {
    clearTimeout(timer)
  }
}

/** Keys that cannot be hot-applied and require a process restart. */
function computeRestartRequired(prev: GatewayConfig, next: GatewayConfig): string[] {
  const out: string[] = []
  if (prev.http.port !== next.http.port) out.push('http.port')
  if (!deepEqual(prev.gateway, next.gateway)) out.push('gateway.*')
  return out
}

function clientIp(req: Request, forwarded: string | undefined): string {
  if (forwarded != null && forwarded.length > 0) return forwarded.split(',')[0]!.trim()
  return new URL(req.url).hostname || 'local'
}

function errorMessage(err: unknown): string {
  if (err instanceof ConfigValidationError) return err.message
  return err instanceof Error ? err.message : String(err)
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}
