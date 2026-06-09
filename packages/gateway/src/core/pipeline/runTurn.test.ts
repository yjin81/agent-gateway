// src/core/pipeline/runTurn.test.ts
// Integration-unit tests for runTurn() using FakeConnector + EmbeddedAdapter + real SQLite.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runTurn, type RunTurnDeps } from './index.js'
import { SessionRegistry } from '../session/registry.js'
import { SessionRunRegistry } from '../session/run-slot.js'
import { AuditLog } from '../audit.js'
import { EmbeddedAdapter } from '../../adapter/embedded/index.js'
import { FakeConnector, makeMsg } from '../../test/helpers/fake-connector.js'
import { AdapterError } from '../../lib/errors.js'
import type { AgentRequest, AgentResponse, StreamChunk, AgentAdapter } from '../../adapter/types.js'
import Database from 'better-sqlite3'
import type { GatewayConfig } from '../../config/schema.js'

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
  const adapter = new EmbeddedAdapter({ run: handler })
  return {
    connector,
    adapter,
    sessionRegistry,
    runRegistry,
    auditLog,
    config,
    approvalMap: new Map(),
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agw-pipeline-test-'))
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

describe('runTurn', () => {
  describe('happy path', () => {
    it('dispatches message and delivers response to connector', async () => {
      const deps = makeDeps(async (req) => ({ text: `echo: ${req.message}`, media: [], interrupted: false }))
      const outcome = await runTurn(makeMsg(), deps)
      expect(outcome).toBe('dispatched')
      expect(connector.sent[0]?.text).toBe('echo: hello')
    })

    it('sets isNew=true on first turn', async () => {
      let capturedIsNew: boolean | undefined
      const deps = makeDeps(async (req) => {
        capturedIsNew = req.isNew
        return { text: 'hi', media: [], interrupted: false }
      })
      await runTurn(makeMsg(), deps)
      expect(capturedIsNew).toBe(true)
    })

    it('sets isNew=false on second turn', async () => {
      let capturedIsNew: boolean | undefined
      const deps = makeDeps(async (req) => {
        capturedIsNew = req.isNew
        return { text: 'hi', media: [], interrupted: false }
      })
      await runTurn(makeMsg(), deps)
      await runTurn(makeMsg({ id: 'msg-2' }), deps)
      expect(capturedIsNew).toBe(false)
    })
  })

  describe('not-addressed message', () => {
    it('returns observed for unaddressed group message', async () => {
      const deps = makeDeps(async () => ({ text: 'hi', media: [], interrupted: false }))
      const msg = makeMsg({ routing: { isAgentAddressed: false, accountId: 'test-account' } })
      const outcome = await runTurn(msg, deps)
      expect(outcome).toBe('observed')
      expect(connector.sent).toHaveLength(0)
    })
  })

  describe('self-message drop', () => {
    it('returns dropped for self-messages', async () => {
      const deps = makeDeps(async () => ({ text: 'hi', media: [], interrupted: false }))
      const msg = makeMsg({ sender: { id: 'bot', name: 'bot', isSelf: true } })
      const outcome = await runTurn(msg, deps)
      expect(outcome).toBe('dropped')
    })
  })

  describe('adapter error handling', () => {
    it('sends error message to user when adapter throws', async () => {
      const deps = makeDeps(async () => { throw new AdapterError('boom') })
      await runTurn(makeMsg(), deps)
      expect(connector.sent[0]?.text).toContain('went wrong')
    })

    it('sends timeout message when adapter exceeds timeout', async () => {
      const slowConfig = { ...config, gateway: { ...config.gateway, adapterTimeoutMs: 50 } }
      let clearSlowTimer: (() => void) | undefined
      const adapter = new EmbeddedAdapter({
        run: () => new Promise<import('../../adapter/types.js').AgentResponse>((resolve) => {
          const t = setTimeout(() => resolve({ text: 'late', media: [], interrupted: false }), 500)
          clearSlowTimer = () => clearTimeout(t)
        }),
      })
      const deps: RunTurnDeps = {
        connector, adapter, sessionRegistry, runRegistry, auditLog,
        config: slowConfig as unknown as GatewayConfig,
        approvalMap: new Map(),
      }
      await runTurn(makeMsg(), deps)
      clearSlowTimer?.()
      expect(connector.sent[0]?.text).toContain('too long')
    })
  })

  describe('/stop command', () => {
    it('sends stopped message and sends no extra error message', async () => {
      // Start a slow run then immediately stop it
      let resolveRun!: () => void
      const blocker = new Promise<void>((res) => { resolveRun = res })

      const deps = makeDeps(async () => {
        await blocker
        return { text: 'done', media: [], interrupted: false }
      })

      const slowMsg = makeMsg({ id: 'slow-msg' })
      const runPromise = runTurn(slowMsg, deps)

      // Give the run time to start
      await new Promise((r) => setTimeout(r, 20))

      const stopMsg = makeMsg({ text: '/stop', id: 'stop-msg' })
      await runTurn(stopMsg, deps)

      resolveRun()
      await runPromise

      // Only "⏹ Stopped." should be sent — no "Something went wrong"
      const texts = connector.sent.map((s) => s.text)
      expect(texts.some((t) => t.includes('Stopped'))).toBe(true)
      expect(texts.some((t) => t.includes('went wrong'))).toBe(false)
    })
  })

  describe('/new command', () => {
    it('resets session so next turn has isNew=true', async () => {
      const isNewValues: boolean[] = []
      const deps = makeDeps(async (req) => {
        isNewValues.push(req.isNew)
        return { text: 'hi', media: [], interrupted: false }
      })

      await runTurn(makeMsg({ id: 'msg-1' }), deps)
      // /new is a priority command — handled directly, does not call adapter
      await runTurn(makeMsg({ text: '/new', id: 'new-cmd' }), deps)
      await runTurn(makeMsg({ id: 'msg-3' }), deps)

      // isNewValues[0] = first turn (new session → true)
      // isNewValues[1] = third turn (after /new reset → true)
      expect(isNewValues[0]).toBe(true)
      expect(isNewValues[1]).toBe(true)
    })
  })

  describe('idle timeout', () => {
    it('sets wasAutoReset=true when idle timeout has elapsed', async () => {
      let capturedWasAutoReset: boolean | undefined
      const zeroTimeoutConfig = { ...config, gateway: { ...config.gateway, idleTimeoutMs: -1 } }
      const adapter = new EmbeddedAdapter({
        run: async (req) => {
          capturedWasAutoReset = req.wasAutoReset
          return { text: 'ok', media: [], interrupted: false }
        },
      })
      const deps: RunTurnDeps = {
        connector, adapter, sessionRegistry, runRegistry, auditLog,
        config: zeroTimeoutConfig as unknown as GatewayConfig,
        approvalMap: new Map(),
      }

      await runTurn(makeMsg({ id: 'msg-1' }), deps)
      await runTurn(makeMsg({ id: 'msg-2' }), deps)

      expect(capturedWasAutoReset).toBe(true)
    })
  })
})

// ── Streaming tests ───────────────────────────────────────────────────────────

/** Build a streaming adapter from a list of pre-defined chunks. */
function makeStreamingAdapter(chunks: StreamChunk[]): AgentAdapter {
  return {
    run: async (): Promise<AgentResponse> => {
      // Fallback (should not be called when stream() is present).
      return { text: chunks.map((c) => c.delta).join(''), media: [], interrupted: false }
    },
    stream: async function* (_req: AgentRequest): AsyncIterable<StreamChunk> {
      for (const chunk of chunks) {
        yield chunk
        if (chunk.done) break
      }
    },
  }
}

describe('runTurn — streaming path', () => {
  const streamChunks: StreamChunk[] = [
    { delta: 'Hello', done: false },
    { delta: ' world', done: false },
    { delta: '!', done: true, interrupted: false, media: [] },
  ]

  describe('buffer path (connector does not support streaming)', () => {
    it('delivers assembled text via send() after all chunks received', async () => {
      // connector (created in beforeEach) does NOT have supportsStreaming
      const adapter = makeStreamingAdapter(streamChunks)
      const deps: RunTurnDeps = {
        connector,
        adapter,
        sessionRegistry,
        runRegistry,
        auditLog,
        config,
        approvalMap: new Map(),
      }

      const outcome = await runTurn(makeMsg(), deps)

      expect(outcome).toBe('dispatched')
      // Exactly one send() call with the assembled text
      expect(connector.sent).toHaveLength(1)
      expect(connector.sent[0]?.text).toBe('Hello world!')
      // sendChunk should NOT have been called
      expect(connector.chunks).toHaveLength(0)
    })

    it('does not call send() when assembled text is blank', async () => {
      const blankChunks: StreamChunk[] = [
        { delta: '', done: false },
        { delta: '', done: true, interrupted: false, media: [] },
      ]
      const adapter = makeStreamingAdapter(blankChunks)
      const deps: RunTurnDeps = {
        connector,
        adapter,
        sessionRegistry,
        runRegistry,
        auditLog,
        config,
        approvalMap: new Map(),
      }

      await runTurn(makeMsg(), deps)

      expect(connector.sent).toHaveLength(0)
    })

    it('does not double-send on streaming path', async () => {
      // Ensure the non-streaming send block (guarded by !streamed) is skipped.
      const adapter = makeStreamingAdapter(streamChunks)
      const deps: RunTurnDeps = {
        connector,
        adapter,
        sessionRegistry,
        runRegistry,
        auditLog,
        config,
        approvalMap: new Map(),
      }

      await runTurn(makeMsg(), deps)

      // Only the one send() from runStreaming() should have fired.
      expect(connector.sent).toHaveLength(1)
    })
  })

  describe('progressive path (connector supports streaming)', () => {
    let streamConnector: FakeConnector

    beforeEach(() => {
      streamConnector = new FakeConnector('test-account', { supportsStreaming: true })
    })

    it('calls sendChunk() for every chunk and does NOT call send()', async () => {
      const adapter = makeStreamingAdapter(streamChunks)
      const deps: RunTurnDeps = {
        connector: streamConnector,
        adapter,
        sessionRegistry,
        runRegistry,
        auditLog,
        config,
        approvalMap: new Map(),
      }

      const outcome = await runTurn(makeMsg(), deps)

      expect(outcome).toBe('dispatched')
      // send() must NOT have been called (no buffered delivery)
      expect(streamConnector.sent).toHaveLength(0)
      // sendChunk() should have been called for each chunk
      expect(streamConnector.chunks).toHaveLength(streamChunks.length)
    })

    it('passes correct accumulated text to each sendChunk() call', async () => {
      const adapter = makeStreamingAdapter(streamChunks)
      const deps: RunTurnDeps = {
        connector: streamConnector,
        adapter,
        sessionRegistry,
        runRegistry,
        auditLog,
        config,
        approvalMap: new Map(),
      }

      await runTurn(makeMsg(), deps)

      const accumulatedValues = streamConnector.chunks.map((c) => c.accumulated)
      expect(accumulatedValues[0]).toBe('Hello')
      expect(accumulatedValues[1]).toBe('Hello world')
      expect(accumulatedValues[2]).toBe('Hello world!')
    })

    it('passes the correct chunk object to sendChunk()', async () => {
      const adapter = makeStreamingAdapter(streamChunks)
      const deps: RunTurnDeps = {
        connector: streamConnector,
        adapter,
        sessionRegistry,
        runRegistry,
        auditLog,
        config,
        approvalMap: new Map(),
      }

      await runTurn(makeMsg(), deps)

      expect(streamConnector.chunks[0]?.chunk.delta).toBe('Hello')
      expect(streamConnector.chunks[2]?.chunk.done).toBe(true)
    })
  })

  describe('first-chunk timeout', () => {
    it('sends timeout message when no chunk arrives within adapterTimeoutMs', async () => {
      const tinyTimeoutConfig = { ...config, gateway: { ...config.gateway, adapterTimeoutMs: 30 } }

      let clearTimer: (() => void) | undefined
      const hangingAdapter: AgentAdapter = {
        run: async () => ({ text: '', media: [], interrupted: false }),
        stream: async function* (_req: AgentRequest): AsyncIterable<StreamChunk> {
          // Never yields — simulates a hanging stream.
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 10_000)
            clearTimer = () => clearTimeout(t)
          })
        },
      }

      const deps: RunTurnDeps = {
        connector,
        adapter: hangingAdapter,
        sessionRegistry,
        runRegistry,
        auditLog,
        config: tinyTimeoutConfig as unknown as GatewayConfig,
        approvalMap: new Map(),
      }

      await runTurn(makeMsg(), deps)
      clearTimer?.()

      expect(connector.sent[0]?.text).toContain('too long')
    })
  })
})
