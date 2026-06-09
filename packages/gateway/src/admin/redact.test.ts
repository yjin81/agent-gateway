// admin/redact.test.ts — secret redaction + merge round-trip

import { describe, it, expect } from 'vitest'
import { redactConfig, mergeSecrets, SECRET_MASK } from './redact.js'
import type { RawConfig } from './config-store.js'

const base: RawConfig = {
  connectors: [
    { type: 'slack', accountId: 'a', botToken: 'xoxb-literal', appToken: '${SLACK_APP}', signingSecret: 'sign-lit' },
    { type: 'telegram', accountId: 'b', token: '${TG_TOKEN}' },
  ],
  adapter: { type: 'http', url: 'http://x', bearerToken: 'literal-bearer' },
}

describe('redactConfig', () => {
  it('masks literal secrets but preserves ${ENV} references', () => {
    const out = redactConfig(base)
    const conns = out['connectors'] as Record<string, unknown>[]
    expect(conns[0]!['botToken']).toBe(SECRET_MASK)
    expect(conns[0]!['signingSecret']).toBe(SECRET_MASK)
    expect(conns[0]!['appToken']).toBe('${SLACK_APP}') // env ref preserved
    expect(conns[1]!['token']).toBe('${TG_TOKEN}')
    expect((out['adapter'] as Record<string, unknown>)['bearerToken']).toBe(SECRET_MASK)
  })

  it('does not mutate the input', () => {
    const clone = structuredClone(base)
    redactConfig(base)
    expect(base).toEqual(clone)
  })

  it('leaves non-secret fields untouched', () => {
    const out = redactConfig(base)
    const conns = out['connectors'] as Record<string, unknown>[]
    expect(conns[0]!['accountId']).toBe('a')
    expect((out['adapter'] as Record<string, unknown>)['url']).toBe('http://x')
  })
})

describe('mergeSecrets', () => {
  it('restores masked secrets from the current config (unchanged submit)', () => {
    const redacted = redactConfig(base)
    const merged = mergeSecrets(redacted, base)
    const conns = merged['connectors'] as Record<string, unknown>[]
    expect(conns[0]!['botToken']).toBe('xoxb-literal') // restored
    expect((merged['adapter'] as Record<string, unknown>)['bearerToken']).toBe('literal-bearer')
  })

  it('keeps an explicitly changed secret value', () => {
    const incoming = structuredClone(redactConfig(base)) as RawConfig
    ;(incoming['connectors'] as Record<string, unknown>[])[0]!['botToken'] = 'xoxb-new'
    const merged = mergeSecrets(incoming, base)
    expect((merged['connectors'] as Record<string, unknown>[])[0]!['botToken']).toBe('xoxb-new')
  })

  it('matches connectors by accountId regardless of order', () => {
    const reordered: RawConfig = {
      connectors: [
        { type: 'telegram', accountId: 'b', token: SECRET_MASK },
        { type: 'slack', accountId: 'a', botToken: SECRET_MASK, appToken: '${SLACK_APP}', signingSecret: SECRET_MASK },
      ],
      adapter: { type: 'http', url: 'http://x', bearerToken: SECRET_MASK },
    }
    const merged = mergeSecrets(reordered, base)
    const conns = merged['connectors'] as Record<string, unknown>[]
    // token for 'b' was an env ref in base, so it is restored to the ref
    expect(conns[0]!['token']).toBe('${TG_TOKEN}')
    expect(conns[1]!['botToken']).toBe('xoxb-literal')
    expect(conns[1]!['signingSecret']).toBe('sign-lit')
  })
})
