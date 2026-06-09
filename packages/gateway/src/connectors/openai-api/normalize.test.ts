// connectors/openai-api/normalize.test.ts
// Unit tests for normalizeOpenAIRequest.

import { describe, it, expect } from 'vitest'
import { normalizeOpenAIRequest } from './normalize.js'

const ACCOUNT = 'test-account'
const SESSION = 'sess-123'

describe('normalizeOpenAIRequest', () => {
  it('returns null when messages array is empty', () => {
    expect(normalizeOpenAIRequest({ messages: [] }, SESSION, ACCOUNT)).toBeNull()
  })

  it('returns null when there is no user message', () => {
    expect(normalizeOpenAIRequest(
      { messages: [{ role: 'system', content: 'be helpful' }] },
      SESSION, ACCOUNT,
    )).toBeNull()
  })

  it('returns null when messages is absent', () => {
    expect(normalizeOpenAIRequest({}, SESSION, ACCOUNT)).toBeNull()
  })

  it('picks the last user message as the current turn', () => {
    const result = normalizeOpenAIRequest({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
    }, SESSION, ACCOUNT)
    expect(result?.text).toBe('second')
  })

  it('sets isAgentAddressed=true always', () => {
    const result = normalizeOpenAIRequest(
      { messages: [{ role: 'user', content: 'hi' }] },
      SESSION, ACCOUNT,
    )
    expect(result?.routing.isAgentAddressed).toBe(true)
  })

  it('sets chat.kind to dm', () => {
    const result = normalizeOpenAIRequest(
      { messages: [{ role: 'user', content: 'hi' }] },
      SESSION, ACCOUNT,
    )
    expect(result?.chat.kind).toBe('dm')
  })

  it('uses sessionId as chat.id and sender.id', () => {
    const result = normalizeOpenAIRequest(
      { messages: [{ role: 'user', content: 'hi' }] },
      SESSION, ACCOUNT,
    )
    expect(result?.chat.id).toBe(SESSION)
    expect(result?.sender.id).toBe(SESSION)
  })

  it('sets routing.accountId to the provided accountId', () => {
    const result = normalizeOpenAIRequest(
      { messages: [{ role: 'user', content: 'hi' }] },
      SESSION, ACCOUNT,
    )
    expect(result?.routing.accountId).toBe(ACCOUNT)
  })

  it('sets textRaw equal to text', () => {
    const result = normalizeOpenAIRequest(
      { messages: [{ role: 'user', content: 'hello' }] },
      SESSION, ACCOUNT,
    )
    expect(result?.textRaw).toBe('hello')
    expect(result?.text).toBe('hello')
  })

  it('attaches the original body as raw', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }], model: 'gpt-4o' }
    const result = normalizeOpenAIRequest(body, SESSION, ACCOUNT)
    expect(result?.raw).toBe(body)
  })

  it('media array is empty', () => {
    const result = normalizeOpenAIRequest(
      { messages: [{ role: 'user', content: 'hi' }] },
      SESSION, ACCOUNT,
    )
    expect(result?.media).toEqual([])
  })
})
