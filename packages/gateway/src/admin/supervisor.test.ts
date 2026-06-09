// admin/supervisor.test.ts — lifecycle, status, drain, diff/apply

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConnectorSupervisor, type SupervisorDeps } from './supervisor.js'
import { FakeConnector, makeMsg } from '../test/helpers/fake-connector.js'
import type { ConnectorConfig } from '../config/schema.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let dir: string
function deps(over: Partial<SupervisorDeps> = {}): SupervisorDeps {
  return {
    dataDir: dir,
    shutdownTimeoutMs: 2000,
    onMessage: async () => {},
    ...over,
  }
}

const cfgA = { type: 'openai-api', accountId: 'a', listenPath: '/a' } as unknown as ConnectorConfig
const cfgB = { type: 'openai-api', accountId: 'b', listenPath: '/b' } as unknown as ConnectorConfig
const cfgC = { type: 'openai-api', accountId: 'c', listenPath: '/c' } as unknown as ConnectorConfig

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agw-sup-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ConnectorSupervisor — startAll + status', () => {
  it('starts adopted connectors and reports running status', async () => {
    const sup = new ConnectorSupervisor(deps())
    const fa = new FakeConnector('a', { supportsStreaming: true })
    await sup.startAll([{ connector: fa, config: cfgA }])
    const statuses = sup.getStatuses()
    expect(statuses).toHaveLength(1)
    expect(statuses[0]).toMatchObject({ accountId: 'a', status: 'running', supportsStreaming: true })
    expect(sup.getConnectors()).toContain(fa)
    await sup.stopAll()
  })
})

describe('ConnectorSupervisor — restart', () => {
  it('stops then restarts a single connector', async () => {
    const sup = new ConnectorSupervisor(deps())
    const fa = new FakeConnector('a')
    await sup.startAll([{ connector: fa, config: cfgA }])
    fa.setHealthy(false)
    await sup.restart('a')
    expect(fa.isHealthy()).toBe(true)
    expect(sup.getStatuses()[0]!.status).toBe('running')
    await sup.stopAll()
  })

  it('throws restarting an unknown connector', async () => {
    const sup = new ConnectorSupervisor(deps())
    await expect(sup.restart('nope')).rejects.toThrow()
  })
})

describe('ConnectorSupervisor — drain', () => {
  it('waits for in-flight turns before stopping', async () => {
    let release!: () => void
    const sup = new ConnectorSupervisor(
      deps({ onMessage: () => new Promise<void>((r) => (release = r)) }),
    )
    const fa = new FakeConnector('a')
    await sup.startAll([{ connector: fa, config: cfgA }])

    fa.inject(makeMsg()) // begins an in-flight turn (activeTurns = 1)
    await sleep(10)
    expect(sup.getStatuses()[0]!.activeTurns).toBe(1)

    let stopped = false
    const stopP = sup.stopAll().then(() => (stopped = true))
    await sleep(60)
    expect(stopped).toBe(false) // blocked draining

    release()
    await stopP
    expect(stopped).toBe(true)
  })
})

describe('ConnectorSupervisor — applyConfig diff', () => {
  it('adds new, removes absent, leaves unchanged connectors', async () => {
    const sup = new ConnectorSupervisor(deps())
    const fa = new FakeConnector('a')
    const fb = new FakeConnector('b')
    await sup.startAll([
      { connector: fa, config: cfgA },
      { connector: fb, config: cfgB },
    ])

    // Keep a (unchanged), drop b, add c.
    const result = await sup.applyConfig([cfgA, cfgC])
    expect(result.added).toEqual(['c'])
    expect(result.removed).toEqual(['b'])
    expect(result.changed).toEqual([])

    const ids = sup.getStatuses().map((s) => s.accountId).sort()
    expect(ids).toEqual(['a', 'c'])
    await sup.stopAll()
  })

  it('detects a changed connector config', async () => {
    const sup = new ConnectorSupervisor(deps())
    const fa = new FakeConnector('a')
    await sup.startAll([{ connector: fa, config: cfgA }])

    const changedA = { type: 'openai-api', accountId: 'a', listenPath: '/different' } as unknown as ConnectorConfig
    const result = await sup.applyConfig([changedA])
    expect(result.changed).toEqual(['a'])
    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
    await sup.stopAll()
  })
})
