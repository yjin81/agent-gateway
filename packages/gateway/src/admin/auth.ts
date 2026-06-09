// admin/auth.ts — Admin token bootstrap + signed session cookie (HMAC).
//
// Secure by default: when no admin token is configured the whole admin surface
// is disabled (see admin/index.ts, which returns 404 in that case).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE_NAME = 'gw_admin_session'

export interface AdminAuthOptions {
  /** Admin bootstrap token. When absent/empty the admin feature is disabled. */
  token?: string | undefined
  /** Signing key for session cookies. Derived from the token when absent. */
  sessionSecret?: string | undefined
  /** Session TTL in milliseconds. Default 1 hour. */
  ttlMs?: number
  /** Max failed login attempts per IP within the rate-limit window. Default 5. */
  maxAttempts?: number
  /** Rate-limit window in milliseconds. Default 60s. */
  windowMs?: number
}

interface AttemptRecord {
  count: number
  resetAt: number
}

export class AdminAuth {
  private readonly token: string | undefined
  private readonly signingKey: string
  private readonly ttlMs: number
  private readonly maxAttempts: number
  private readonly windowMs: number
  private readonly attempts = new Map<string, AttemptRecord>()

  constructor(opts: AdminAuthOptions = {}) {
    this.token = opts.token != null && opts.token.length > 0 ? opts.token : undefined
    // Derive a signing key from a dedicated secret, else from the token itself.
    this.signingKey =
      opts.sessionSecret != null && opts.sessionSecret.length > 0
        ? opts.sessionSecret
        : this.token != null
          ? createHmac('sha256', 'gw-admin-session-derive').update(this.token).digest('hex')
          : randomBytes(32).toString('hex')
    this.ttlMs = opts.ttlMs ?? 3_600_000
    this.maxAttempts = opts.maxAttempts ?? 5
    this.windowMs = opts.windowMs ?? 60_000
  }

  /** True when an admin token is configured and the admin surface is active. */
  get enabled(): boolean {
    return this.token != null
  }

  /** Constant-time comparison of a candidate token against the configured token. */
  verifyToken(candidate: string): boolean {
    if (this.token == null) return false
    const a = Buffer.from(candidate)
    const b = Buffer.from(this.token)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  /**
   * Issue a signed session value: `base64url(payload).base64url(hmac)`.
   * Payload carries the expiry timestamp; no server-side state is stored.
   */
  issueSession(now: number = Date.now()): string {
    const payload = JSON.stringify({ exp: now + this.ttlMs })
    const encoded = Buffer.from(payload).toString('base64url')
    const sig = this.hmac(encoded)
    return `${encoded}.${sig}`
  }

  /** Verify a session value's signature and expiry. */
  verifySession(value: string | undefined, now: number = Date.now()): boolean {
    if (value == null) return false
    const dot = value.lastIndexOf('.')
    if (dot <= 0) return false
    const encoded = value.slice(0, dot)
    const sig = value.slice(dot + 1)
    const expected = this.hmac(encoded)
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false
    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
        exp?: number
      }
      return typeof payload.exp === 'number' && payload.exp > now
    } catch {
      return false
    }
  }

  /** Returns true if the IP is allowed another login attempt (rate limit). */
  rateLimitOk(ip: string, now: number = Date.now()): boolean {
    const rec = this.attempts.get(ip)
    if (rec == null || now >= rec.resetAt) return true
    return rec.count < this.maxAttempts
  }

  /** Record a failed login attempt for an IP. */
  recordFailure(ip: string, now: number = Date.now()): void {
    const rec = this.attempts.get(ip)
    if (rec == null || now >= rec.resetAt) {
      this.attempts.set(ip, { count: 1, resetAt: now + this.windowMs })
    } else {
      rec.count += 1
    }
  }

  /** Clear failed-attempt state for an IP after a successful login. */
  clearFailures(ip: string): void {
    this.attempts.delete(ip)
  }

  private hmac(data: string): string {
    return createHmac('sha256', this.signingKey).update(data).digest('base64url')
  }
}
