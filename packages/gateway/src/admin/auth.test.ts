// admin/auth.test.ts — token compare, session cookie issue/verify, rate limit

import { describe, it, expect } from 'vitest'
import { AdminAuth } from './auth.js'

describe('AdminAuth — enabled state', () => {
  it('is disabled when no token is configured', () => {
    expect(new AdminAuth({}).enabled).toBe(false)
    expect(new AdminAuth({ token: '' }).enabled).toBe(false)
  })

  it('is enabled when a token is configured', () => {
    expect(new AdminAuth({ token: 'secret' }).enabled).toBe(true)
  })
})

describe('AdminAuth — token verification', () => {
  const auth = new AdminAuth({ token: 'correct-horse' })

  it('accepts the correct token', () => {
    expect(auth.verifyToken('correct-horse')).toBe(true)
  })

  it('rejects an incorrect token', () => {
    expect(auth.verifyToken('wrong')).toBe(false)
    expect(auth.verifyToken('correct-horse ')).toBe(false)
  })

  it('rejects everything when disabled', () => {
    expect(new AdminAuth({}).verifyToken('anything')).toBe(false)
  })
})

describe('AdminAuth — session cookies', () => {
  it('issues a session that it can verify', () => {
    const auth = new AdminAuth({ token: 't' })
    const session = auth.issueSession()
    expect(auth.verifySession(session)).toBe(true)
  })

  it('rejects a tampered session', () => {
    const auth = new AdminAuth({ token: 't' })
    const session = auth.issueSession()
    expect(auth.verifySession(session + 'x')).toBe(false)
    expect(auth.verifySession('garbage')).toBe(false)
    expect(auth.verifySession(undefined)).toBe(false)
  })

  it('rejects an expired session', () => {
    const auth = new AdminAuth({ token: 't', ttlMs: 1000 })
    const now = 1_000_000
    const session = auth.issueSession(now)
    expect(auth.verifySession(session, now + 500)).toBe(true)
    expect(auth.verifySession(session, now + 1500)).toBe(false)
  })

  it('rejects a session signed with a different key', () => {
    const a = new AdminAuth({ token: 't', sessionSecret: 'key-a' })
    const b = new AdminAuth({ token: 't', sessionSecret: 'key-b' })
    expect(b.verifySession(a.issueSession())).toBe(false)
  })
})

describe('AdminAuth — rate limiting', () => {
  it('blocks after maxAttempts failures within the window', () => {
    const auth = new AdminAuth({ token: 't', maxAttempts: 3, windowMs: 60_000 })
    const ip = '1.2.3.4'
    expect(auth.rateLimitOk(ip)).toBe(true)
    auth.recordFailure(ip)
    auth.recordFailure(ip)
    expect(auth.rateLimitOk(ip)).toBe(true) // 2 < 3
    auth.recordFailure(ip)
    expect(auth.rateLimitOk(ip)).toBe(false) // 3 >= 3
  })

  it('resets after the window elapses', () => {
    const auth = new AdminAuth({ token: 't', maxAttempts: 1, windowMs: 1000 })
    const ip = '5.6.7.8'
    auth.recordFailure(ip, 0)
    expect(auth.rateLimitOk(ip, 500)).toBe(false)
    expect(auth.rateLimitOk(ip, 2000)).toBe(true)
  })

  it('clears failures on success', () => {
    const auth = new AdminAuth({ token: 't', maxAttempts: 1 })
    const ip = '9.9.9.9'
    auth.recordFailure(ip)
    expect(auth.rateLimitOk(ip)).toBe(false)
    auth.clearFailures(ip)
    expect(auth.rateLimitOk(ip)).toBe(true)
  })
})
