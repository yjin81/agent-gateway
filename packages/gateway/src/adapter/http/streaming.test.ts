// adapter/http/streaming.test.ts
// Unit tests for HttpAdapter.stream() — SSE parsing via a local in-process HTTP server.
// No external services or API keys required.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { HttpAdapter } from './index.js'
import type { AgentRequest } from '../types.js'

// ── Minimal AgentRequest fixture ──────────────────────────────────────────────

function makeRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    sessionKey: 'test-session',
    message: 'hello',
    messageRaw: 'hello',
    media: [],
    isNew: false,
    wasAutoReset: false,
    platform: { name: 'test', chatKind: 'dm', userId: 'u1', userName: 'User', accountId: 'acc1', mentions: [] },
    toolPolicy: { allowedTools: [], disabledTools: [] },
    abortSignal: new AbortController().signal,
    progressCallback: () => {},
    approvalCallback: async () => 'approved',
    ...overrides,
  }
}

// ── Local SSE test server ─────────────────────────────────────────────────────

type SseHandler = (res: http.ServerResponse) => void

let server: http.Server
let baseUrl: string
let currentHandler: SseHandler = (res) => { res.end() }

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    currentHandler(res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
})

/** Write a sequence of SSE events to the response. */
function writeSseEvents(res: http.ServerResponse, events: Array<{ event?: string; data: string }>): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  for (const ev of events) {
    if (ev.event) res.write(`event: ${ev.event}\n`)
    res.write(`data: ${ev.data}\n\n`)
  }
  res.end()
}

function makeAdapter(): HttpAdapter {
  return new HttpAdapter(baseUrl, undefined, { protocol: 'openai-responses', model: 'gpt-4o' })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('HttpAdapter.stream() — openai-responses SSE', () => {
  it('yields text chunks and a final done chunk from response.output_text.delta + response.completed', async () => {
    currentHandler = (res) => writeSseEvents(res, [
      { event: 'response.output_text.delta', data: JSON.stringify({ delta: 'Hello' }) },
      { event: 'response.output_text.delta', data: JSON.stringify({ delta: ' world' }) },
      { event: 'response.completed', data: JSON.stringify({}) },
    ])

    const adapter = makeAdapter()
    const chunks = []
    for await (const chunk of adapter.stream(makeRequest())) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toEqual({ delta: 'Hello', done: false })
    expect(chunks[1]).toEqual({ delta: ' world', done: false })
    expect(chunks[2]).toEqual({ delta: '', done: true, interrupted: false, media: [] })
  })

  it('yields done+interrupted on response.incomplete', async () => {
    currentHandler = (res) => writeSseEvents(res, [
      { event: 'response.output_text.delta', data: JSON.stringify({ delta: 'partial' }) },
      { event: 'response.incomplete', data: JSON.stringify({}) },
    ])

    const adapter = makeAdapter()
    const chunks = []
    for await (const chunk of adapter.stream(makeRequest())) {
      chunks.push(chunk)
    }

    const last = chunks[chunks.length - 1]
    expect(last?.done).toBe(true)
    expect(last?.interrupted).toBe(true)
  })

  it('throws AdapterError on response.failed', async () => {
    currentHandler = (res) => writeSseEvents(res, [
      {
        event: 'response.failed',
        data: JSON.stringify({ response: { error: { message: 'quota exceeded' } } }),
      },
    ])

    const adapter = makeAdapter()
    await expect(async () => {
      for await (const _ of adapter.stream(makeRequest())) { /* consume */ }
    }).rejects.toThrow('quota exceeded')
  })

  it('handles [DONE] sentinel', async () => {
    currentHandler = (res) => writeSseEvents(res, [
      { event: 'response.output_text.delta', data: JSON.stringify({ delta: 'hi' }) },
      { data: '[DONE]' },
    ])

    const adapter = makeAdapter()
    const chunks = []
    for await (const chunk of adapter.stream(makeRequest())) {
      chunks.push(chunk)
    }

    const last = chunks[chunks.length - 1]
    expect(last?.done).toBe(true)
    expect(last?.interrupted).toBe(false)
  })

  it('skips unrecognised event types silently', async () => {
    currentHandler = (res) => writeSseEvents(res, [
      { event: 'response.created', data: JSON.stringify({ id: 'r_123' }) },
      { event: 'response.output_text.delta', data: JSON.stringify({ delta: 'ok' }) },
      { event: 'response.completed', data: JSON.stringify({}) },
    ])

    const adapter = makeAdapter()
    const chunks = []
    for await (const chunk of adapter.stream(makeRequest())) {
      chunks.push(chunk)
    }

    // Only the delta + done chunks — response.created is skipped.
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.delta).toBe('ok')
  })

  it('terminates cleanly when stream ends without a terminal event', async () => {
    currentHandler = (res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('event: response.output_text.delta\ndata: {"delta":"x"}\n\n')
      res.end() // no response.completed
    }

    const adapter = makeAdapter()
    const chunks = []
    for await (const chunk of adapter.stream(makeRequest())) {
      chunks.push(chunk)
    }

    const last = chunks[chunks.length - 1]
    expect(last?.done).toBe(true)
  })

  it('stops consuming when AbortSignal fires mid-stream', async () => {
    currentHandler = (res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write('event: response.output_text.delta\ndata: {"delta":"chunk1"}\n\n')
      // Deliberately do not end — leaves the stream open so abort fires.
      // The test will time out (15s) if abort isn't handled.
    }

    const ac = new AbortController()
    const adapter = makeAdapter()
    const chunks = []

    const req = makeRequest({ abortSignal: ac.signal })
    let i = 0
    for await (const chunk of adapter.stream(req)) {
      chunks.push(chunk)
      i++
      if (i === 1) ac.abort() // abort after first chunk
    }

    const last = chunks[chunks.length - 1]
    expect(last?.done).toBe(true)
    expect(last?.interrupted).toBe(true)
  })

  it('throws AdapterError on non-200 response', async () => {
    currentHandler = (res) => {
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      res.end('Service Unavailable')
    }

    const adapter = makeAdapter()
    await expect(async () => {
      for await (const _ of adapter.stream(makeRequest())) { /* consume */ }
    }).rejects.toThrow('503')
  })
})
