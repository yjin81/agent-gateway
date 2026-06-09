// admin/env-store.test.ts — parse/list/set/delete over data/.env

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EnvStore } from './env-store.js'

let dir: string
let envPath: string
let store: EnvStore

const SEED = `# Comment header
FOO=bar
EMPTY=

# section comment
TOKEN=abc123
`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agw-envstore-'))
  envPath = join(dir, '.env')
  writeFileSync(envPath, SEED, 'utf8')
  store = new EnvStore(envPath)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('EnvStore.list', () => {
  it('returns assignment lines, skipping comments and blanks', () => {
    expect(store.list()).toEqual([
      { key: 'FOO', value: 'bar' },
      { key: 'EMPTY', value: '' },
      { key: 'TOKEN', value: 'abc123' },
    ])
  })

  it('returns [] when the file does not exist', () => {
    expect(new EnvStore(join(dir, 'missing.env')).list()).toEqual([])
  })
})

describe('EnvStore.set', () => {
  it('updates an existing var in place, preserving order and comments', () => {
    store.set('FOO', 'baz')
    expect(store.list().find((v) => v.key === 'FOO')!.value).toBe('baz')
    const content = readFileSync(envPath, 'utf8')
    expect(content).toContain('# Comment header')
    expect(content.indexOf('FOO=baz')).toBeLessThan(content.indexOf('TOKEN=abc123'))
  })

  it('appends a new var', () => {
    store.set('NEW_KEY', 'hello')
    expect(store.list().at(-1)).toEqual({ key: 'NEW_KEY', value: 'hello' })
  })

  it('creates the file when it does not exist', () => {
    const p = join(dir, 'fresh.env')
    new EnvStore(p).set('A', '1')
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p, 'utf8')).toBe('A=1\n')
  })

  it('rejects invalid key names', () => {
    expect(() => store.set('bad-key', 'x')).toThrow()
    expect(() => store.set('1FOO', 'x')).toThrow()
  })
})

describe('EnvStore.delete', () => {
  it('removes a var and returns true', () => {
    expect(store.delete('FOO')).toBe(true)
    expect(store.list().some((v) => v.key === 'FOO')).toBe(false)
    expect(readFileSync(envPath, 'utf8')).toContain('# Comment header')
  })

  it('returns false for an unknown key', () => {
    expect(store.delete('NOPE')).toBe(false)
  })
})
