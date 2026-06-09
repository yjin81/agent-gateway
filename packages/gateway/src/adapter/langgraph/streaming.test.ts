// adapter/langgraph/streaming.test.ts
// Unit tests for LangGraphAdapter.stream() and streamGraphEvents().
// Uses FakeListChatModel (non-streaming) — streamEvents() provides the event
// stream; the LLM only needs to return a complete response per call.
// No live LLM calls, no API keys.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { StateGraph, END } from '@langchain/langgraph'
import { FakeListChatModel } from '@langchain/core/utils/testing'
import { AIMessage } from '@langchain/core/messages'

import { LangGraphAdapter } from './index.js'
import { GatewayStateAnnotation } from './state.js'
import { streamGraphEvents } from './streaming.js'
import type { AgentRequest } from '../types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    sessionKey: 'v1:test:acc:chat-1',
    message: 'hello',
    messageRaw: 'hello',
    media: [],
    isNew: true,
    wasAutoReset: false,
    platform: { name: 'test', chatKind: 'dm', userId: 'u1', userName: 'User', accountId: 'acc', mentions: [] },
    toolPolicy: { allowedTools: [], disabledTools: [] },
    abortSignal: new AbortController().signal,
    progressCallback: () => {},
    approvalCallback: async () => 'approved',
    ...overrides,
  }
}

/** Build a graph that returns a deterministic response via FakeListChatModel. */
function buildGraph(responses: string[]) {
  const llm = new FakeListChatModel({ responses })
  return new StateGraph(GatewayStateAnnotation)
    .addNode('agent', async (state) => {
      const response = await llm.invoke(state.messages)
      return { messages: [response] }
    })
    .addEdge('__start__', 'agent')
    .addEdge('agent', END)
    .compile()
}

const BASE_INPUT = {
  messages: [],
  sessionKey: 'test',
  isNew: true,
  wasAutoReset: false,
  platform: { name: 'test', chatKind: 'dm' as const, userId: 'u', userName: 'U', accountId: 'a', mentions: [] },
  toolPolicy: { allowedTools: [], disabledTools: [] },
}

let tmpDir: string
let dbPath: string
let adapter: LangGraphAdapter | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agw-lg-stream-test-'))
  dbPath = join(tmpDir, 'history.db')
  adapter = undefined
})

afterEach(() => {
  adapter?.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── streamGraphEvents() unit tests ────────────────────────────────────────────

describe('streamGraphEvents()', () => {
  it('always yields a final done chunk', async () => {
    const graph = buildGraph(['Hi there'])
    const chunks = []
    for await (const chunk of streamGraphEvents(graph, BASE_INPUT, {})) {
      chunks.push(chunk)
    }

    const last = chunks[chunks.length - 1]
    expect(last?.done).toBe(true)
    expect(last?.interrupted).toBe(false)
    expect(last?.media).toEqual([])
  })

  it('all non-final chunks have done=false', async () => {
    const graph = buildGraph(['Hello world'])
    const chunks = []
    for await (const chunk of streamGraphEvents(graph, BASE_INPUT, {})) {
      chunks.push(chunk)
    }

    for (const c of chunks.slice(0, -1)) {
      expect(c.done).toBe(false)
    }
  })

  it('yields done+interrupted when abortSignal is pre-fired', async () => {
    const ac = new AbortController()
    ac.abort()

    const graph = buildGraph(['Some long response'])
    const chunks = []
    for await (const chunk of streamGraphEvents(
      graph, BASE_INPUT, { signal: ac.signal }, ac.signal,
    )) {
      chunks.push(chunk)
    }

    const last = chunks[chunks.length - 1]
    expect(last?.done).toBe(true)
    expect(last?.interrupted).toBe(true)
  })
})

// ── LangGraphAdapter.stream() integration tests ───────────────────────────────

describe('LangGraphAdapter.stream()', () => {
  it('yields a final done chunk with interrupted=false', async () => {
    const graph = buildGraph(['Hello world'])
    adapter = new LangGraphAdapter(graph, { dbPath })

    const chunks = []
    for await (const chunk of adapter.stream(makeRequest())) {
      chunks.push(chunk)
    }

    const last = chunks[chunks.length - 1]
    expect(last?.done).toBe(true)
    expect(last?.interrupted).toBe(false)
  })

  it('persists history after streaming completes', async () => {
    const graph = buildGraph(['Stream reply'])
    adapter = new LangGraphAdapter(graph, { dbPath })

    for await (const _ of adapter.stream(makeRequest({ message: 'stream me' }))) {
      // consume all chunks
    }
    adapter.close()

    const hist = new MessageHistory(dbPath)
    const messages = hist.load('v1:test:acc:chat-1')
    hist.close()

    expect(messages).toHaveLength(2)
    expect(messages[0]?.constructor.name).toBe('HumanMessage')
    expect(messages[1]?.constructor.name).toBe('AIMessage')
    expect((messages[1] as AIMessage).content).toBe('Stream reply')

    // Re-open adapter (afterEach needs a valid adapter to close).
    adapter = new LangGraphAdapter(buildGraph([]), { dbPath })
  })

  it('done chunk has interrupted=true when abortSignal is pre-fired', async () => {
    const ac = new AbortController()
    ac.abort()

    const graph = buildGraph(['long response'])
    adapter = new LangGraphAdapter(graph, { dbPath })

    const chunks = []
    for await (const chunk of adapter.stream(makeRequest({ abortSignal: ac.signal }))) {
      chunks.push(chunk)
    }

    const last = chunks[chunks.length - 1]
    expect(last?.done).toBe(true)
    expect(last?.interrupted).toBe(true)
  })

  it('text assembled from stream() chunks equals run() result when a ChatModel is used', async () => {
    // Use FakeListChatModel so streamEvents emits on_chat_model_stream events.
    const llm = new FakeListChatModel({ responses: ['Deterministic', 'Deterministic'] })
    const graph = new StateGraph(GatewayStateAnnotation)
      .addNode('agent', async (state) => ({ messages: [await llm.invoke(state.messages)] }))
      .addEdge('__start__', 'agent')
      .addEdge('agent', END)
      .compile()

    // run() result.
    const runAdapter = new LangGraphAdapter(graph, { dbPath })
    const runResult = await runAdapter.run(makeRequest({ message: 'q' }))
    runAdapter.close()

    // stream() assembled text — fresh DB.
    const tmpDir2 = mkdtempSync(join(tmpdir(), 'agw-lg-cmp-'))
    const streamAdapter = new LangGraphAdapter(graph, { dbPath: join(tmpDir2, 'h.db') })
    const chunks = []
    for await (const c of streamAdapter.stream(makeRequest({ message: 'q' }))) {
      chunks.push(c)
    }
    streamAdapter.close()
    rmSync(tmpDir2, { recursive: true, force: true })

    const streamText = chunks.filter(c => !c.done).map(c => c.delta).join('')
    expect(streamText).toBe(runResult.text)

    // Re-open adapter for afterEach.
    adapter = new LangGraphAdapter(buildGraph([]), { dbPath })
  })
})

// Imported here to avoid top-level import causing issues after adapter.close() in tests.
import { MessageHistory } from './history.js'
