// admin/adapter-manager.test.ts — swap, drain, rollback, stream presence

import { describe, it, expect } from 'vitest'
import { AdapterManager } from './adapter-manager.js'
import type { AgentAdapter, AgentRequest, AgentResponse, StreamChunk } from '../adapter/types.js'

function fakeRequest(): AgentRequest {
  return { sessionKey: 's', message: 'hi' } as unknown as AgentRequest
}

function makeAdapter(label: string, runImpl?: () => Promise<AgentResponse>): AgentAdapter {
  return {
    run:
      runImpl ??
      (async () => ({ text: label, media: [], interrupted: false })),
  }
}

describe('AdapterManager — delegation', () => {
  it('run() delegates to the current adapter', async () => {
    const mgr = new AdapterManager(makeAdapter('first'))
    const res = await mgr.run(fakeRequest())
    expect(res.text).toBe('first')
  })

  it('getCurrent() returns the active adapter', () => {
    const a = makeAdapter('a')
    const mgr = new AdapterManager(a)
    expect(mgr.getCurrent()).toBe(a)
  })
})

describe('AdapterManager — stream presence (stable per process)', () => {
  it('exposes stream() only when the initial adapter streams', () => {
    const streaming: AgentAdapter = {
      run: async () => ({ text: '', media: [], interrupted: false }),
      async *stream(): AsyncIterable<StreamChunk> {
        yield { delta: 'x', done: false }
        yield { delta: '', done: true }
      },
    }
    expect(new AdapterManager(streaming).stream).toBeTypeOf('function')
    expect(new AdapterManager(makeAdapter('plain')).stream).toBeUndefined()
  })
})

describe('AdapterManager — swap', () => {
  it('swaps the current adapter so later turns use the new one', async () => {
    const mgr = new AdapterManager(makeAdapter('old'))
    await mgr.swap(makeAdapter('new'), 1000)
    const res = await mgr.run(fakeRequest())
    expect(res.text).toBe('new')
  })

  it('drains an in-flight turn before swapping', async () => {
    const order: string[] = []
    let releaseRun!: () => void
    const slow = makeAdapter('slow', async () => {
      await new Promise<void>((r) => (releaseRun = r))
      order.push('run-done')
      return { text: 'slow', media: [], interrupted: false }
    })
    const mgr = new AdapterManager(slow)

    const runPromise = mgr.run(fakeRequest())
    // Give run() a tick to register as active.
    await new Promise((r) => setTimeout(r, 10))

    const swapPromise = mgr.swap(makeAdapter('new'), 1000).then(() => order.push('swap-done'))
    // Swap should be blocked on drain until the run completes.
    await new Promise((r) => setTimeout(r, 30))
    expect(order).toEqual([])

    releaseRun()
    await Promise.all([runPromise, swapPromise])
    expect(order).toEqual(['run-done', 'swap-done'])
  })

  it('swaps anyway after the drain timeout elapses', async () => {
    let releaseRun!: () => void
    const stuck = makeAdapter('stuck', async () => {
      await new Promise<void>((r) => (releaseRun = r))
      return { text: 'stuck', media: [], interrupted: false }
    })
    const mgr = new AdapterManager(stuck)
    const runPromise = mgr.run(fakeRequest())
    await new Promise((r) => setTimeout(r, 10))

    const start = Date.now()
    await mgr.swap(makeAdapter('new'), 50)
    expect(Date.now() - start).toBeGreaterThanOrEqual(40)
    expect(mgr.getCurrent().run).toBeDefined()

    releaseRun()
    await runPromise
  })
})
