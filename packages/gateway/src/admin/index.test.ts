// admin/index.test.ts — management API route wiring (auth gate, config get/put)

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import yaml from 'js-yaml'

import { mountAdmin } from './index.js'
import { AdminAuth } from './auth.js'
import { ConfigStore, type RawConfig } from './config-store.js'
import { EnvStore } from './env-store.js'
import { ConnectorSupervisor } from './supervisor.js'
import { AdapterManager } from './adapter-manager.js'
import { SessionRegistry } from '../core/session/registry.js'
import { AuditLog } from '../core/audit.js'
import { SECRET_MASK } from './redact.js'
import type { AgentAdapter } from '../adapter/types.js'

let dir: string
let app: Hono
let sessionRegistry: SessionRegistry
let supervisor: ConnectorSupervisor
let db: Database.Database

const rawConfig: RawConfig = {
  connectors: [{ type: 'telegram', accountId: 't', token: 'literal-secret' }],
  adapter: { type: 'http', url: 'http://localhost:9/run' },
}

async function setup(token: string | undefined, opts: { cfg?: RawConfig; preStart?: boolean } = {}): Promise<void> {
  const cfg = opts.cfg ?? rawConfig
  const cfgPath = join(dir, 'gateway.config.yaml')
  writeFileSync(cfgPath, yaml.dump(cfg), 'utf8')
  const configStore = await ConfigStore.load(cfgPath)
  const config = configStore.validate(configStore.getRaw())

  db = new Database(join(dir, 'gateway.db'))
  sessionRegistry = new SessionRegistry(join(dir, 'gateway.db'))
  const auditLog = new AuditLog(db)
  supervisor = new ConnectorSupervisor({ dataDir: dir, shutdownTimeoutMs: 1000, onMessage: async () => {} })
  const fakeAdapter: AgentAdapter = { run: async () => ({ text: '', media: [], interrupted: false }) }

  // Pre-start connectors so an edit is diffed as "changed" (not "added").
  if (opts.preStart) await supervisor.applyConfig(config.connectors)

  const auth = new AdminAuth({ token })
  app = new Hono()
  if (auth.enabled) {
    mountAdmin(app, {
      auth,
      configStore,
      envStore: new EnvStore(join(dir, '.env')),
      supervisor,
      adapterManager: new AdapterManager(fakeAdapter),
      sessionRegistry,
      auditLog,
      config,
      bootTime: Date.now(),
      version: 'test',
      cookieSecure: false,
    })
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agw-adminapi-'))
})
afterEach(async () => {
  await supervisor?.stopAll()
  sessionRegistry?.close()
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

function cookieFrom(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? ''
  return setCookie.split(';')[0] ?? ''
}

describe('admin API — auth gate', () => {
  it('serves the dashboard HTML at /admin', async () => {
    await setup('admin-token')
    const res = await app.request('/admin/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Agent Gateway')
  })

  it('rejects /api/config without a session cookie', async () => {
    await setup('admin-token')
    const res = await app.request('/admin/api/config')
    expect(res.status).toBe(401)
  })

  it('rejects login with a wrong token', async () => {
    await setup('admin-token')
    const res = await app.request('/admin/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong' }),
    })
    expect(res.status).toBe(401)
  })

  it('issues a session cookie on correct login', async () => {
    await setup('admin-token')
    const res = await app.request('/admin/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'admin-token' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('gw_admin_session=')
  })
})

describe('admin API — config (authenticated)', () => {
  it('returns the config with secrets redacted', async () => {
    await setup('admin-token')
    const login = await app.request('/admin/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'admin-token' }),
    })
    const cookie = cookieFrom(login)

    const res = await app.request('/admin/api/config', { headers: { cookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { config: RawConfig }
    const token = (body.config['connectors'] as Record<string, unknown>[])[0]!['token']
    expect(token).toBe(SECRET_MASK)
  })

  it('validates a candidate config (dry-run)', async () => {
    await setup('admin-token')
    const login = await app.request('/admin/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'admin-token' }),
    })
    const cookie = cookieFrom(login)

    const bad = await app.request('/admin/api/config/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ connectors: [], adapter: rawConfig['adapter'] }),
    })
    expect(bad.status).toBe(400)
    const badBody = (await bad.json()) as { ok: boolean }
    expect(badBody.ok).toBe(false)
  })
})

describe('admin API — edit single connector (authenticated)', () => {
  // Use an openai-api connector: it starts cleanly offline (no network auth),
  // and carries a bearerToken secret so masking/restore can be asserted.
  const oaiConfig: RawConfig = {
    connectors: [{ type: 'openai-api', accountId: 'o', bearerToken: 'literal-secret', listenPath: '/v1' }],
    adapter: { type: 'http', url: 'http://localhost:9/run' },
  }

  async function authed(opts: { cfg?: RawConfig; preStart?: boolean } = {}): Promise<string> {
    await setup('admin-token', opts)
    const login = await app.request('/admin/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'admin-token' }),
    })
    return cookieFrom(login)
  }

  it('applies an edit to an existing connector and keeps its masked secret', async () => {
    const cookie = await authed({ cfg: oaiConfig, preStart: true })
    const res = await app.request('/admin/api/connectors/o', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ type: 'openai-api', accountId: 'o', bearerToken: SECRET_MASK, listenPath: '/v2' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; connectorResult: { changed: string[] } }
    expect(body.ok).toBe(true)
    expect(body.connectorResult.changed).toContain('o')

    // The masked secret was restored to the original literal on persist, and the
    // non-secret edit (listenPath) was applied.
    const cfg = await app.request('/admin/api/config', { headers: { cookie } })
    const cfgBody = (await cfg.json()) as { config: RawConfig }
    const conn = (cfgBody.config['connectors'] as Record<string, unknown>[])[0]!
    expect(conn['listenPath']).toBe('/v2')
    expect(conn['bearerToken']).toBe(SECRET_MASK)
  })

  it('returns 404 for an unknown connector', async () => {
    const cookie = await authed()
    const res = await app.request('/admin/api/connectors/nope', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ type: 'telegram', accountId: 'nope', token: 'x' }),
    })
    expect(res.status).toBe(404)
  })

  it('rejects changing the accountId', async () => {
    const cookie = await authed()
    const res = await app.request('/admin/api/connectors/t', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ type: 'telegram', accountId: 'renamed', token: SECRET_MASK }),
    })
    expect(res.status).toBe(400)
  })

  it('requires a session cookie', async () => {
    await setup('admin-token')
    const res = await app.request('/admin/api/connectors/t', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'telegram', accountId: 't', token: SECRET_MASK }),
    })
    expect(res.status).toBe(401)
  })
})

describe('admin API — environment variables (authenticated)', () => {
  async function authed(): Promise<string> {
    await setup('admin-token')
    writeFileSync(join(dir, '.env'), 'FOO=bar\n', 'utf8')
    const login = await app.request('/admin/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'admin-token' }),
    })
    return cookieFrom(login)
  }

  it('lists env vars', async () => {
    const cookie = await authed()
    const res = await app.request('/admin/api/env', { headers: { cookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { vars: { key: string; value: string }[] }
    expect(body.vars).toEqual([{ key: 'FOO', value: 'bar' }])
  })

  it('adds / updates a var via PUT', async () => {
    const cookie = await authed()
    const res = await app.request('/admin/api/env/NEW_KEY', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ value: 'hello' }),
    })
    expect(res.status).toBe(200)
    const list = await (await app.request('/admin/api/env', { headers: { cookie } })).json() as { vars: { key: string; value: string }[] }
    expect(list.vars).toContainEqual({ key: 'NEW_KEY', value: 'hello' })
  })

  it('rejects an invalid key name', async () => {
    const cookie = await authed()
    const res = await app.request('/admin/api/env/bad-key', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ value: 'x' }),
    })
    expect(res.status).toBe(400)
  })

  it('deletes a var', async () => {
    const cookie = await authed()
    const res = await app.request('/admin/api/env/FOO', { method: 'DELETE', headers: { cookie } })
    expect(res.status).toBe(200)
    const list = await (await app.request('/admin/api/env', { headers: { cookie } })).json() as { vars: unknown[] }
    expect(list.vars).toEqual([])
  })

  it('returns 404 deleting an unknown var', async () => {
    const cookie = await authed()
    const res = await app.request('/admin/api/env/NOPE', { method: 'DELETE', headers: { cookie } })
    expect(res.status).toBe(404)
  })

  it('requires a session cookie', async () => {
    await setup('admin-token')
    const res = await app.request('/admin/api/env')
    expect(res.status).toBe(401)
  })
})
