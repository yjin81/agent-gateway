// connectors/openai-api/connector.test.ts
// Integration tests for OpenAIApiConnector: session key construction,
// send() → pending promise resolution, auth, error paths, and SSE streaming.

import { describe, it, expect, beforeEach } from 'vitest'
import { OpenAIApiConnector } from './index.js'
import type { NormalizedMessage } from '../types.js'

// Helper: read a ReadableStream<Uint8Array> to a string.
async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let result = ''
  const reader = stream.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    result += decoder.decode(value, { stream: true })
  }
  return result
}

// Helper: parse SSE text into an array of parsed JSON objects (data lines only).
function parseSseEvents(raw: string): unknown[] {
  return raw
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data: ') && block !== 'data: [DONE]')
    .map((block) => JSON.parse(block.slice('data: '.length)) as unknown)
}

function makeConnector(bearerToken?: string) {
  return new OpenAIApiConnector({
    type: 'openai-api',
    accountId: 'test-account',
    listenPath: '/v1',
    bearerToken,
  })
}

// Helper: simulate a POST /chat/completions request through the Hono app.
async function postCompletions(
  connector: OpenAIApiConnector,
  body: object,
  headers: Record<string, string> = {},
): Promise<Response> {
  const req = new Request('http://localhost/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return connector.app.fetch(req)
}

const VALID_BODY = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hello' }],
}

describe('OpenAIApiConnector', () => {
  let connector: OpenAIApiConnector
  let received: NormalizedMessage[]

  beforeEach(async () => {
    connector = makeConnector()
    received = []
    connector.onMessage((msg) => received.push(msg))
    await connector.startAccount()
  })

  describe('normalisation + session key', () => {
    it('constructs session key as v1:openai-api:{accountId}:{sessionId}', async () => {
      // Fire request and immediately resolve from send() side.
      const reqPromise = postCompletions(connector, VALID_BODY, {
        'X-Session-Id': 'sess-abc',
      })
      // Give the message callback a tick to fire.
      await new Promise((r) => setTimeout(r, 0))

      const msg = received[0] as NormalizedMessage & { sessionKey: string }
      expect(msg.sessionKey).toBe('v1:openai-api:test-account:sess-abc')

      // Resolve by calling send() so the HTTP response can complete.
      await connector.send({ chatId: 'sess-abc', accountId: 'test-account' }, 'reply')
      const resp = await reqPromise
      expect(resp.status).toBe(200)
    })

    it('session key does not double-embed accountId when no X-Session-Id', async () => {
      const reqPromise = postCompletions(connector, VALID_BODY)
      await new Promise((r) => setTimeout(r, 0))

      const msg = received[0] as NormalizedMessage & { sessionKey: string }
      // Key must be v1:openai-api:test-account:<uuid> — no nested accountId
      expect(msg.sessionKey).toMatch(/^v1:openai-api:test-account:[0-9a-f-]{36}$/)

      const sessionId = msg.chat.id
      await connector.send({ chatId: sessionId, accountId: 'test-account' }, 'reply')
      await reqPromise
    })

    it('sets message text from last user message', async () => {
      const reqPromise = postCompletions(connector, {
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'last' },
        ],
      }, { 'X-Session-Id': 'sess-1' })
      await new Promise((r) => setTimeout(r, 0))

      expect(received[0]?.text).toBe('last')
      await connector.send({ chatId: 'sess-1', accountId: 'test-account' }, 'done')
      await reqPromise
    })
  })

  describe('response shape', () => {
    it('returns OpenAI-compatible JSON with choices[0].message.content', async () => {
      const reqPromise = postCompletions(connector, VALID_BODY, { 'X-Session-Id': 'sess-2' })
      await new Promise((r) => setTimeout(r, 0))
      await connector.send({ chatId: 'sess-2', accountId: 'test-account' }, 'the answer')
      const resp = await reqPromise
      const body = await resp.json() as { choices: { message: { content: string } }[] }
      expect(body.choices[0].message.content).toBe('the answer')
    })

    it('reflects the requested model name in the response', async () => {
      const reqPromise = postCompletions(connector, { ...VALID_BODY, model: 'my-model' }, { 'X-Session-Id': 'sess-3' })
      await new Promise((r) => setTimeout(r, 0))
      await connector.send({ chatId: 'sess-3', accountId: 'test-account' }, 'ok')
      const resp = await reqPromise
      const body = await resp.json() as { model: string }
      expect(body.model).toBe('my-model')
    })
  })

  describe('error paths', () => {
    it('returns 400 when messages array has no user message', async () => {
      const resp = await postCompletions(connector, {
        messages: [{ role: 'system', content: 'be helpful' }],
      })
      expect(resp.status).toBe(400)
    })

    it('returns 400 for invalid JSON', async () => {
      const req = new Request('http://localhost/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      })
      const resp = await connector.app.fetch(req)
      expect(resp.status).toBe(400)
    })
  })

  describe('authentication', () => {
    it('returns 401 when bearer token is required but missing', async () => {
      const authed = makeConnector('secret')
      await authed.startAccount()
      authed.onMessage(() => {})
      const resp = await postCompletions(authed, VALID_BODY)
      expect(resp.status).toBe(401)
    })

    it('returns 401 for wrong bearer token', async () => {
      const authed = makeConnector('secret')
      await authed.startAccount()
      authed.onMessage(() => {})
      const resp = await postCompletions(authed, VALID_BODY, { Authorization: 'Bearer wrong' })
      expect(resp.status).toBe(401)
    })

    it('passes through with correct bearer token', async () => {
      const authed = makeConnector('secret')
      await authed.startAccount()
      authed.onMessage(async (msg) => {
        const m = msg as NormalizedMessage & { sessionKey: string }
        await authed.send({ chatId: m.chat.id, accountId: 'test-account' }, 'ok')
      })
      const resp = await postCompletions(authed, VALID_BODY, { Authorization: 'Bearer secret' })
      expect(resp.status).toBe(200)
    })
  })

  describe('stopAccount', () => {
    it('resolves pending responses with shutdown message on stop', async () => {
      const reqPromise = postCompletions(connector, VALID_BODY, { 'X-Session-Id': 'sess-stop' })
      await new Promise((r) => setTimeout(r, 0))
      await connector.stopAccount()
      const resp = await reqPromise
      const body = await resp.json() as { choices: { message: { content: string } }[] }
      expect(body.choices[0].message.content).toContain('shutting down')
    })
  })

  describe('SSE streaming', () => {
    it('returns Content-Type text/event-stream when stream:true', async () => {
      const reqPromise = postCompletions(connector, { ...VALID_BODY, stream: true }, { 'X-Session-Id': 'sse-1' })
      // Give pipeline a tick to register the writer before we close it.
      await new Promise((r) => setTimeout(r, 0))
      // Emit done chunk to close the stream.
      await connector.sendChunk({ chatId: 'sse-1' }, { delta: '', done: true }, '')
      const resp = await reqPromise
      expect(resp.headers.get('Content-Type')).toContain('text/event-stream')
    })

    it('SSE delta chunks contain assistant content', async () => {
      const reqPromise = postCompletions(connector, { ...VALID_BODY, stream: true, model: 'test-model' }, { 'X-Session-Id': 'sse-2' })
      await new Promise((r) => setTimeout(r, 0))
      await connector.sendChunk({ chatId: 'sse-2' }, { delta: 'Hello', done: false }, 'Hello')
      await connector.sendChunk({ chatId: 'sse-2' }, { delta: ' world', done: false }, 'Hello world')
      await connector.sendChunk({ chatId: 'sse-2' }, { delta: '', done: true }, 'Hello world')
      const resp = await reqPromise
      const raw = await readStream(resp.body!)
      const events = parseSseEvents(raw)
      // First two events should have content deltas.
      const contents = (events as Array<{ choices: Array<{ delta: { content?: string } }> }>)
        .map((e) => e.choices[0].delta.content ?? '')
        .filter((c) => c !== '')
      expect(contents).toEqual(['Hello', ' world'])
    })

    it('SSE final event has finish_reason stop and stream ends with [DONE]', async () => {
      const reqPromise = postCompletions(connector, { ...VALID_BODY, stream: true }, { 'X-Session-Id': 'sse-3' })
      await new Promise((r) => setTimeout(r, 0))
      await connector.sendChunk({ chatId: 'sse-3' }, { delta: 'hi', done: false }, 'hi')
      await connector.sendChunk({ chatId: 'sse-3' }, { delta: '', done: true }, 'hi')
      const resp = await reqPromise
      const raw = await readStream(resp.body!)
      // Must contain [DONE] sentinel.
      expect(raw).toContain('data: [DONE]')
      // Last data event before [DONE] must have finish_reason: 'stop'.
      const events = parseSseEvents(raw)
      const last = events.at(-1) as { choices: Array<{ finish_reason: string }> }
      expect(last.choices[0].finish_reason).toBe('stop')
    })

    it('SSE chunks carry consistent id and model fields', async () => {
      const reqPromise = postCompletions(connector, { ...VALID_BODY, stream: true, model: 'my-model' }, { 'X-Session-Id': 'sse-4' })
      await new Promise((r) => setTimeout(r, 0))
      await connector.sendChunk({ chatId: 'sse-4' }, { delta: 'tok', done: false }, 'tok')
      await connector.sendChunk({ chatId: 'sse-4' }, { delta: '', done: true }, 'tok')
      const resp = await reqPromise
      const raw = await readStream(resp.body!)
      const events = parseSseEvents(raw) as Array<{ id: string; model: string; object: string }>
      for (const e of events) {
        expect(e.object).toBe('chat.completion.chunk')
        expect(e.model).toBe('my-model')
        expect(e.id).toMatch(/^chatcmpl-/)
      }
      // All events share the same id.
      const ids = events.map((e) => e.id)
      expect(new Set(ids).size).toBe(1)
    })

    it('non-streaming client (stream:false) still receives buffered JSON via sendChunk fallback', async () => {
      // With supportsStreaming=true, pipeline calls sendChunk() not send().
      // The connector must still resolve the non-streaming HTTP response.
      const reqPromise = postCompletions(connector, VALID_BODY, { 'X-Session-Id': 'sse-5' })
      await new Promise((r) => setTimeout(r, 0))
      // Simulate pipeline calling sendChunk() with done=true (accumulated = full text).
      await connector.sendChunk({ chatId: 'sse-5' }, { delta: '', done: true }, 'buffered reply')
      const resp = await reqPromise
      expect(resp.status).toBe(200)
      const body = await resp.json() as { choices: Array<{ message: { content: string } }> }
      expect(body.choices[0].message.content).toBe('buffered reply')
    })

    it('stopAccount closes open SSE streams with [DONE]', async () => {
      const reqPromise = postCompletions(connector, { ...VALID_BODY, stream: true }, { 'X-Session-Id': 'sse-6' })
      await new Promise((r) => setTimeout(r, 0))
      await connector.stopAccount()
      const resp = await reqPromise
      const raw = await readStream(resp.body!)
      expect(raw).toContain('data: [DONE]')
    })
  })
})
