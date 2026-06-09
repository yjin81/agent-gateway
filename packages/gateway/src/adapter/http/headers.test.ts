// adapter/http/headers.test.ts
// Unit tests for HttpAdapter auth headers — bearer token vs api-key vs both.
// Captures the headers a real fetch sends via a local in-process HTTP server.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { HttpAdapter } from './index.js'
import type { AgentRequest } from '../types.js'

function makeRequest(): AgentRequest {
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
  }
}

let server: http.Server
let baseUrl: string
let lastHeaders: http.IncomingHttpHeaders = {}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastHeaders = req.headers
    // Drain the body, then return a minimal agent-request AgentResponse.
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ text: 'ok', media: [], interrupted: false }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
})

beforeEach(() => {
  lastHeaders = {}
})

describe('HttpAdapter auth headers', () => {
  it('sends Authorization: Bearer when a token is provided', async () => {
    const adapter = new HttpAdapter(baseUrl, async () => 'tok-123')
    await adapter.run(makeRequest())
    expect(lastHeaders['authorization']).toBe('Bearer tok-123')
    expect(lastHeaders['api-key']).toBeUndefined()
  })

  it('sends the api-key header when getApiKey is provided', async () => {
    const adapter = new HttpAdapter(baseUrl, undefined, { getApiKey: async () => 'key-abc' })
    await adapter.run(makeRequest())
    expect(lastHeaders['api-key']).toBe('key-abc')
    expect(lastHeaders['authorization']).toBeUndefined()
  })

  it('honours a custom apiKeyHeader name', async () => {
    const adapter = new HttpAdapter(baseUrl, undefined, {
      getApiKey: async () => 'key-abc',
      apiKeyHeader: 'x-api-key',
    })
    await adapter.run(makeRequest())
    expect(lastHeaders['x-api-key']).toBe('key-abc')
  })

  it('sends both headers when both credentials are present', async () => {
    const adapter = new HttpAdapter(baseUrl, async () => 'tok-123', { getApiKey: async () => 'key-abc' })
    await adapter.run(makeRequest())
    expect(lastHeaders['authorization']).toBe('Bearer tok-123')
    expect(lastHeaders['api-key']).toBe('key-abc')
  })

  it('omits empty credentials (unset env var → no useless empty header)', async () => {
    const adapter = new HttpAdapter(baseUrl, async () => '', { getApiKey: async () => '' })
    await adapter.run(makeRequest())
    expect(lastHeaders['authorization']).toBeUndefined()
    expect(lastHeaders['api-key']).toBeUndefined()
  })
})
