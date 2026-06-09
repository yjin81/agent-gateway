// adapter/langgraph/adapter.test.ts
// Unit tests for LangGraphAdapter — run() path, history, isNew/wasAutoReset.
// Uses FakeListChatModel: no live LLM calls, no API keys.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { StateGraph, END } from '@langchain/langgraph'
import { FakeListChatModel } from '@langchain/core/utils/testing'
import { HumanMessage, AIMessage } from '@langchain/core/messages'

import { LangGraphAdapter } from './index.js'
import { GatewayStateAnnotation } from './state.js'
import { MessageHistory } from './history.js'
import { checkAbort, GatewayAbortError } from './abort.js'
import type { AgentRequest } from '../types.js'
import type { RunnableConfig } from '@langchain/core/runnables'

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

let tmpDir: string
let dbPath: string
let adapter: LangGraphAdapter | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agw-lg-test-'))
  dbPath = join(tmpDir, 'history.db')
  adapter = undefined
})

afterEach(() => {
  adapter?.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LangGraphAdapter.run()', () => {
  it('returns the graph response as AgentResponse.text', async () => {
    const graph = buildGraph(['Hello back!'])
    adapter = new LangGraphAdapter(graph, { dbPath })

    const result = await adapter.run(makeRequest())

    expect(result.text).toBe('Hello back!')
    expect(result.media).toEqual([])
    expect(result.interrupted).toBe(false)
  })

  it('passes message text to the graph via HumanMessage', async () => {
    let capturedMessages: unknown[] = []
    const llm = new FakeListChatModel({ responses: ['ok'] })

    const graph = new StateGraph(GatewayStateAnnotation)
      .addNode('agent', async (state) => {
        capturedMessages = state.messages
        return { messages: [await llm.invoke(state.messages)] }
      })
      .addEdge('__start__', 'agent')
      .addEdge('agent', END)
      .compile()

    adapter = new LangGraphAdapter(graph, { dbPath })
    await adapter.run(makeRequest({ message: 'what is 2+2?' }))

    const last = capturedMessages[capturedMessages.length - 1]
    expect(last).toBeInstanceOf(HumanMessage)
    expect((last as HumanMessage).content).toBe('what is 2+2?')
  })

  it('populates GatewayState fields (isNew, wasAutoReset, platform)', async () => {
    let capturedState: typeof GatewayStateAnnotation.State | undefined

    const graph = new StateGraph(GatewayStateAnnotation)
      .addNode('agent', async (state) => {
        capturedState = state
        return { messages: [new AIMessage('ok')] }
      })
      .addEdge('__start__', 'agent')
      .addEdge('agent', END)
      .compile()

    adapter = new LangGraphAdapter(graph, { dbPath })
    await adapter.run(makeRequest({ isNew: true, wasAutoReset: false }))

    expect(capturedState?.isNew).toBe(true)
    expect(capturedState?.wasAutoReset).toBe(false)
    expect(capturedState?.platform.name).toBe('test')
    expect(capturedState?.sessionKey).toBe('v1:test:acc:chat-1')
  })

  it('persists history so a follow-up turn has prior messages', async () => {
    const graph = buildGraph(['First reply', 'Second reply'])
    adapter = new LangGraphAdapter(graph, { dbPath })
    await adapter.run(makeRequest({ message: 'turn one', isNew: true }))
    adapter.close()

    let messagesOnSecondTurn: unknown[] = []
    const graph2 = new StateGraph(GatewayStateAnnotation)
      .addNode('agent', async (state) => {
        messagesOnSecondTurn = [...state.messages]
        return { messages: [new AIMessage('Second reply')] }
      })
      .addEdge('__start__', 'agent')
      .addEdge('agent', END)
      .compile()

    adapter = new LangGraphAdapter(graph2, { dbPath })
    await adapter.run(makeRequest({ message: 'turn two', isNew: false }))

    // HumanMessage('turn one'), AIMessage('First reply'), HumanMessage('turn two')
    expect(messagesOnSecondTurn).toHaveLength(3)
    expect(messagesOnSecondTurn[0]).toBeInstanceOf(HumanMessage)
    expect(messagesOnSecondTurn[1]).toBeInstanceOf(AIMessage)
    expect(messagesOnSecondTurn[2]).toBeInstanceOf(HumanMessage)
  })

  it('clears history when isNew=true', async () => {
    const hist = new MessageHistory(dbPath)
    hist.append('v1:test:acc:chat-1', 'old message', 'old reply')
    hist.close()

    let messagesReceived: unknown[] = []
    const graph = new StateGraph(GatewayStateAnnotation)
      .addNode('agent', async (state) => {
        messagesReceived = [...state.messages]
        return { messages: [new AIMessage('Fresh reply')] }
      })
      .addEdge('__start__', 'agent')
      .addEdge('agent', END)
      .compile()

    adapter = new LangGraphAdapter(graph, { dbPath })
    await adapter.run(makeRequest({ message: 'new session', isNew: true }))

    // Only the new HumanMessage — old history was cleared.
    expect(messagesReceived).toHaveLength(1)
    expect((messagesReceived[0] as HumanMessage).content).toBe('new session')
  })

  it('clears history when wasAutoReset=true', async () => {
    const hist = new MessageHistory(dbPath)
    hist.append('v1:test:acc:chat-1', 'stale', 'stale reply')
    hist.close()

    let messagesReceived: unknown[] = []
    const graph = new StateGraph(GatewayStateAnnotation)
      .addNode('agent', async (state) => {
        messagesReceived = [...state.messages]
        return { messages: [new AIMessage('reset reply')] }
      })
      .addEdge('__start__', 'agent')
      .addEdge('agent', END)
      .compile()

    adapter = new LangGraphAdapter(graph, { dbPath })
    await adapter.run(makeRequest({ message: 'after reset', isNew: false, wasAutoReset: true }))

    expect(messagesReceived).toHaveLength(1)
    expect((messagesReceived[0] as HumanMessage).content).toBe('after reset')
  })

  it('passes extra config from buildConfig to the graph', async () => {
    let capturedTags: string[] | undefined

    const graph = new StateGraph(GatewayStateAnnotation)
      .addNode('agent', async (_state, config) => {
        capturedTags = config?.tags
        return { messages: [new AIMessage('ok')] }
      })
      .addEdge('__start__', 'agent')
      .addEdge('agent', END)
      .compile()

    adapter = new LangGraphAdapter(graph, {
      dbPath,
      buildConfig: () => ({ tags: ['my-tag'] }),
    })
    await adapter.run(makeRequest())

    expect(capturedTags).toContain('my-tag')
  })

  it('onSessionReset clears history', async () => {
    const hist = new MessageHistory(dbPath)
    hist.append('v1:test:acc:chat-1', 'msg', 'reply')
    expect(hist.load('v1:test:acc:chat-1')).toHaveLength(2)
    hist.close()

    const graph = buildGraph(['ok'])
    adapter = new LangGraphAdapter(graph, { dbPath })
    await adapter.onSessionReset('v1:test:acc:chat-1')

    const hist2 = new MessageHistory(dbPath)
    expect(hist2.load('v1:test:acc:chat-1')).toHaveLength(0)
    hist2.close()
  })
})

// ── checkAbort / GatewayAbortError ────────────────────────────────────────────

describe('checkAbort', () => {
  it('does not throw when signal is not aborted', () => {
    const ctrl = new AbortController()
    const config: RunnableConfig = { signal: ctrl.signal }
    expect(() => checkAbort(config)).not.toThrow()
  })

  it('throws GatewayAbortError when signal is aborted', () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const config: RunnableConfig = { signal: ctrl.signal }
    expect(() => checkAbort(config)).toThrow(GatewayAbortError)
  })

  it('does not throw when config has no signal', () => {
    expect(() => checkAbort({})).not.toThrow()
  })

  it('GatewayAbortError has correct name', () => {
    expect(new GatewayAbortError().name).toBe('GatewayAbortError')
  })
})

describe('LangGraphAdapter — abort handling', () => {
  let tmpDir2: string
  let dbPath2: string

  beforeEach(() => {
    tmpDir2 = mkdtempSync(join(tmpdir(), 'agw-abort-test-'))
    dbPath2 = join(tmpDir2, 'history.db')
  })

  afterEach(() => {
    rmSync(tmpDir2, { recursive: true, force: true })
  })

  it('run() returns interrupted:true when graph node calls checkAbort', async () => {
    // Build a graph whose node calls checkAbort — simulating a tool node that
    // detects cancellation.
    const ctrl = new AbortController()
    const nodeGraph = new StateGraph(GatewayStateAnnotation)
      .addNode('agent', async (_state, config: RunnableConfig) => {
        ctrl.abort()          // abort during execution
        checkAbort(config)    // should throw GatewayAbortError
        return { messages: [] }
      })
      .addEdge('__start__', 'agent')
      .addEdge('agent', END)
      .compile()

    const adapter2 = new LangGraphAdapter(nodeGraph, { dbPath: dbPath2 })
    const req = makeRequest({ abortSignal: ctrl.signal })
    const resp = await adapter2.run(req)
    expect(resp.interrupted).toBe(true)
    adapter2.close()
  })

  it('run() returns interrupted:true when abortSignal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const graph = buildGraph(['reply'])
    const adapter2 = new LangGraphAdapter(graph, { dbPath: dbPath2 })
    const req = makeRequest({ abortSignal: ctrl.signal })
    const resp = await adapter2.run(req)
    expect(resp.interrupted).toBe(true)
    adapter2.close()
  })
})
