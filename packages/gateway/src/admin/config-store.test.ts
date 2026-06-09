// admin/config-store.test.ts — load/validate/persist, atomic write, .bak, rollback

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'

import { ConfigStore, type RawConfig } from './config-store.js'
import { ConfigValidationError } from '../lib/errors.js'

let dir: string
let cfgPath: string

const valid: RawConfig = {
  connectors: [{ type: 'openai-api', accountId: 'api1' }],
  adapter: { type: 'http', url: 'http://localhost:9999/run' },
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agw-cfgstore-'))
  cfgPath = join(dir, 'gateway.config.yaml')
  writeFileSync(cfgPath, yaml.dump(valid), 'utf8')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ConfigStore.load', () => {
  it('parses the YAML into a raw object', async () => {
    const store = await ConfigStore.load(cfgPath)
    expect((store.getRaw()['connectors'] as unknown[]).length).toBe(1)
  })

  it('throws ConfigValidationError when the file is missing', async () => {
    await expect(ConfigStore.load(join(dir, 'nope.yaml'))).rejects.toBeInstanceOf(ConfigValidationError)
  })
})

describe('ConfigStore.validate', () => {
  it('returns a validated config with schema defaults applied', async () => {
    const store = await ConfigStore.load(cfgPath)
    const cfg = store.validate(store.getRaw())
    expect(cfg.http.port).toBe(3000) // default
    expect(cfg.adapter.type).toBe('http')
  })

  it('throws on a schema violation (no connectors)', async () => {
    const store = await ConfigStore.load(cfgPath)
    expect(() => store.validate({ connectors: [], adapter: valid['adapter'] })).toThrow(
      ConfigValidationError,
    )
  })

  it('throws on an undefined ${ENV} reference', async () => {
    const store = await ConfigStore.load(cfgPath)
    const withEnv: RawConfig = {
      connectors: [{ type: 'telegram', accountId: 't', token: '${DEFINITELY_UNSET_VAR_XYZ}' }],
      adapter: valid['adapter'],
    }
    expect(() => store.validate(withEnv)).toThrow(ConfigValidationError)
  })
})

describe('ConfigStore.write', () => {
  it('persists atomically and keeps a .bak of the previous config', async () => {
    const store = await ConfigStore.load(cfgPath)
    const next: RawConfig = {
      connectors: [{ type: 'openai-api', accountId: 'api2' }],
      adapter: valid['adapter'],
    }
    await store.write(next)

    expect(existsSync(`${cfgPath}.bak`)).toBe(true)
    const onDisk = yaml.load(readFileSync(cfgPath, 'utf8')) as RawConfig
    expect((onDisk['connectors'] as Record<string, unknown>[])[0]!['accountId']).toBe('api2')
    expect((store.getRaw()['connectors'] as Record<string, unknown>[])[0]!['accountId']).toBe('api2')

    const bak = yaml.load(readFileSync(`${cfgPath}.bak`, 'utf8')) as RawConfig
    expect((bak['connectors'] as Record<string, unknown>[])[0]!['accountId']).toBe('api1')
  })

  it('does not write when validation fails', async () => {
    const store = await ConfigStore.load(cfgPath)
    const before = readFileSync(cfgPath, 'utf8')
    await expect(store.write({ connectors: [], adapter: valid['adapter'] })).rejects.toBeInstanceOf(
      ConfigValidationError,
    )
    expect(readFileSync(cfgPath, 'utf8')).toBe(before)
    expect(existsSync(`${cfgPath}.bak`)).toBe(false)
  })

  it('rolls back to the previous config from .bak', async () => {
    const store = await ConfigStore.load(cfgPath)
    await store.write({
      connectors: [{ type: 'openai-api', accountId: 'api2' }],
      adapter: valid['adapter'],
    })
    await store.rollback()
    const onDisk = yaml.load(readFileSync(cfgPath, 'utf8')) as RawConfig
    expect((onDisk['connectors'] as Record<string, unknown>[])[0]!['accountId']).toBe('api1')
    expect((store.getRaw()['connectors'] as Record<string, unknown>[])[0]!['accountId']).toBe('api1')
  })
})
