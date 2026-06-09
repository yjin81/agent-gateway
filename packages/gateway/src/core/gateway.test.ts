// src/core/gateway.test.ts
// Layer 3 integration tests: full pipeline via runTurn() with FakeConnector + EmbeddedAdapter.
// These tests use the pipeline directly to avoid HTTP server lifecycle issues.
// Complex concurrency tests are in runTurn.test.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

import { runTurn, type RunTurnDeps } from './pipeline/index.js'
import { SessionRegistry } from './session/registry.js'
import { SessionRunRegistry } from './session/run-slot.js'
import { AuditLog } from './audit.js'
import { EmbeddedAdapter } from '../adapter/embedded/index.js'
import { FakeConnector, makeMsg } from '../test/helpers/fake-connector.js'
import { AdapterError } from '../lib/errors.js'
import type { AgentRequest, AgentResponse } from '../adapter/types.js'
import type { GatewayConfig } from '../config/schema.js'

let tmpDir: string
let sessionRegistry: SessionRegistry
let runRegistry: SessionRunRegistry
let auditLog: AuditLog
let connector: FakeConnector
let db: Database.Database

const config: GatewayConfig = {
  gateway: {
    idleTimeoutMs: 60_000,
    adapterTimeoutMs: 5_000,
    approvalTimeoutMs: 10_000,
    shutdownTimeoutMs: 5_000,
    pendingQueueCap: 1,
    dataDir: '/tmp',
    logLevel: 'silent',
  },
  http: { port: 0 },
  connectors: [],
  adapter: { type: 'http', url: 'http://localhost/run', accountId: 'test' },
} as unknown as GatewayConfig

function makeDeps(handler: (req: AgentRequest) => Promise<AgentResponse>): RunTurnDeps {
  return {
    connector,
    adapter: new EmbeddedAdapter({ run: handler }),
    sessionRegistry,
    runRegistry,
    auditLog,
    config,
    approvalMap: new Map(),
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agw-gw-test-'))
  db = new Database(join(tmpDir, 'test.db'))
  db.pragma('journal_mode = WAL')
  sessionRegistry = new SessionRegistry(join(tmpDir, 'test.db'))
  runRegistry = new SessionRunRegistry()
  auditLog = new AuditLog(db)
  connector = new FakeConnector('test-account')
})

afterEach(() => {
  sessionRegistry.close()
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('Gateway pipeline (integration)', () => {
  it('routes message end-to-end and delivers response', async () => {
    const deps = makeDeps(async (req) => ({ text: `echo: ${req.message}`, media: [], interrupted: false }))
    await runTurn(makeMsg({ text: 'hello world' }), deps)
    expect(connector.sent[0]?.text).toBe('echo: hello world')
  })

  it('delivers isNew=true on first message', async () => {
    let sawIsNew = false
    const deps = makeDeps(async (req) => { sawIsNew = req.isNew; return { text: 'ok', media: [], interrupted: false } })
    await runTurn(makeMsg(), deps)
    expect(sawIsNew).toBe(true)
  })

  it('sends error message to user when adapter throws', async () => {
    const deps = makeDeps(async () => { throw new AdapterError('simulated 500') })
    await runTurn(makeMsg(), deps)
    expect(connector.sent[0]?.text).toContain('went wrong')
  })

  it('/new resets session; next turn gets isNew=true', async () => {
    const isNewValues: boolean[] = []
    const deps = makeDeps(async (req) => {
      isNewValues.push(req.isNew)
      return { text: 'ok', media: [], interrupted: false }
    })

    await runTurn(makeMsg({ id: 'm1', text: 'first' }), deps)
    await runTurn(makeMsg({ id: 'new-cmd', text: '/new' }), deps)
    await runTurn(makeMsg({ id: 'm3', text: 'after reset' }), deps)

    expect(isNewValues[0]).toBe(true)   // first ever turn
    expect(isNewValues[1]).toBe(true)   // after /new
  })

  it('isNew=false on second turn after touch', async () => {
    const isNewValues: boolean[] = []
    const deps = makeDeps(async (req) => {
      isNewValues.push(req.isNew)
      return { text: 'ok', media: [], interrupted: false }
    })
    await runTurn(makeMsg({ id: 'm1' }), deps)
    await runTurn(makeMsg({ id: 'm2' }), deps)
    expect(isNewValues[1]).toBe(false)
  })

  it('drops messages not addressed to bot', async () => {
    const deps = makeDeps(async () => ({ text: 'should not run', media: [], interrupted: false }))
    const outcome = await runTurn(makeMsg({ routing: { isAgentAddressed: false, accountId: 'test-account' } }), deps)
    expect(outcome).toBe('observed')
    expect(connector.sent).toHaveLength(0)
  })
})
