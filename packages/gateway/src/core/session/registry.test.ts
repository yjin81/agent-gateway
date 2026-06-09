// src/core/session/registry.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionRegistry } from './registry.js'

let tmpDir: string
let registry: SessionRegistry

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agw-reg-test-'))
  registry = new SessionRegistry(join(tmpDir, 'test.db'))
})

afterEach(() => {
  registry.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('SessionRegistry', () => {
  describe('getOrCreate — new session', () => {
    it('returns isNew=true on first call', () => {
      const record = registry.getOrCreate('v1:test:key', 60_000)
      expect(record.isNew).toBe(true)
    })

    it('returns wasAutoReset=false on first call', () => {
      const record = registry.getOrCreate('v1:test:key', 60_000)
      expect(record.wasAutoReset).toBe(false)
    })

    it('returns the provided sessionKey', () => {
      const record = registry.getOrCreate('v1:test:mykey', 60_000)
      expect(record.sessionKey).toBe('v1:test:mykey')
    })
  })

  describe('getOrCreate — subsequent call within idle timeout', () => {
    it('returns isNew=false on second call after touch', () => {
      const key = 'v1:test:key2'
      registry.getOrCreate(key, 60_000)
      registry.touch(key)
      const second = registry.getOrCreate(key, 60_000)
      expect(second.isNew).toBe(false)
    })

    it('returns wasAutoReset=false when within idle timeout', () => {
      const key = 'v1:test:key3'
      registry.getOrCreate(key, 60_000)
      registry.touch(key)
      const second = registry.getOrCreate(key, 60_000)
      expect(second.wasAutoReset).toBe(false)
    })
  })

  describe('idle timeout', () => {
    it('sets wasAutoReset=true when idle timeout has elapsed', () => {
      const key = 'v1:test:idle'
      registry.getOrCreate(key, 60_000)
      registry.touch(key)
      // idleTimeoutMs of -1 means any positive elapsed time triggers reset
      const result = registry.getOrCreate(key, -1)
      expect(result.wasAutoReset).toBe(true)
      expect(result.isNew).toBe(true)
    })
  })

  describe('resetSession', () => {
    it('causes next getOrCreate to return isNew=true and wasAutoReset=true', () => {
      const key = 'v1:test:reset'
      registry.getOrCreate(key, 60_000)
      registry.touch(key)
      registry.resetSession(key)
      const after = registry.getOrCreate(key, 60_000)
      expect(after.isNew).toBe(true)
      expect(after.wasAutoReset).toBe(true)
    })
  })

  describe('isolation', () => {
    it('different session keys are independent', () => {
      registry.getOrCreate('key-a', 60_000)
      registry.touch('key-a')
      const b = registry.getOrCreate('key-b', 60_000)
      expect(b.isNew).toBe(true)
    })
  })
})
