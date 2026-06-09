// admin/config-store.ts — Load / validate / persist gateway.config.yaml.
//
// Holds the raw (pre-interpolation) YAML object so `${ENV_VAR}` placeholders are
// preserved across read/write cycles — secrets are never resolved into the file.
// Writes are atomic (temp-write + rename) with a `.bak` of the previous good
// config for rollback.

import { readFileSync, writeFileSync, copyFileSync, renameSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { validateConfig, interpolateEnvVars } from '../config/loader.js'
import type { GatewayConfig } from '../config/schema.js'
import { ConfigValidationError } from '../lib/errors.js'

/** A raw, pre-interpolation config object as parsed from YAML. */
export type RawConfig = Record<string, unknown>

export class ConfigStore {
  private raw: RawConfig

  constructor(
    private readonly configPath: string,
    initialRaw: RawConfig,
  ) {
    this.raw = initialRaw
  }

  /**
   * Build a ConfigStore by reading and parsing the YAML file at `configPath`.
   * Does not validate — call `validate()` separately. Throws
   * ConfigValidationError if the file cannot be read or parsed.
   */
  static async load(configPath: string): Promise<ConfigStore> {
    const absPath = resolve(configPath)
    let raw: unknown
    try {
      const jsYaml = await import('js-yaml')
      const content = readFileSync(absPath, 'utf8')
      raw = jsYaml.load(content)
    } catch (err) {
      throw new ConfigValidationError(`Failed to read or parse config file: ${configPath}`, {
        cause: String(err),
      })
    }
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ConfigValidationError(`Config file is not a YAML object: ${configPath}`)
    }
    return new ConfigStore(absPath, raw as RawConfig)
  }

  /** The current raw (pre-interpolation) config object. Caller must not mutate. */
  getRaw(): RawConfig {
    return this.raw
  }

  /**
   * Interpolate + validate a candidate raw config against GatewayConfigSchema.
   * Returns the validated, interpolated GatewayConfig.
   * Throws ConfigValidationError on undefined env vars or schema violations.
   */
  validate(candidate: RawConfig): GatewayConfig {
    const interpolated = interpolateEnvVars(candidate)
    return validateConfig(interpolated)
  }

  /**
   * Validate then atomically persist a candidate raw config to disk, keeping a
   * `.bak` of the previous file. Updates the in-memory raw config on success.
   * Throws ConfigValidationError (before any write) if validation fails.
   */
  async write(candidate: RawConfig): Promise<GatewayConfig> {
    const validated = this.validate(candidate)

    const jsYaml = await import('js-yaml')
    const yaml = jsYaml.dump(candidate, { noRefs: true, lineWidth: -1 })

    // Back up the previous good config before overwriting.
    if (existsSync(this.configPath)) {
      copyFileSync(this.configPath, `${this.configPath}.bak`)
    }

    // Atomic write: temp file in the same directory, then rename over target.
    const tmpPath = `${this.configPath}.tmp`
    writeFileSync(tmpPath, yaml, 'utf8')
    renameSync(tmpPath, this.configPath)

    this.raw = candidate
    return validated
  }

  /**
   * Restore the previous config from its `.bak` (used on apply rollback).
   * No-op if no backup exists.
   */
  async rollback(): Promise<void> {
    const bakPath = `${this.configPath}.bak`
    if (!existsSync(bakPath)) return
    copyFileSync(bakPath, this.configPath)
    const restored = await ConfigStore.load(this.configPath)
    this.raw = restored.getRaw()
  }
}
