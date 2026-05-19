// config/loader.ts — Load, interpolate, and validate gateway.config.yaml

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { GatewayConfigSchema } from './schema.js'
import type { GatewayConfig } from './schema.js'
import { ConfigValidationError } from '../lib/errors.js'

/**
 * Interpolate `${ENV_VAR_NAME}` placeholders in string values throughout
 * the config object (deep traversal). Throws ConfigValidationError if any
 * referenced env var is not set.
 */
function interpolateEnvVars(value: unknown, path: string[] = []): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
      const resolved = process.env[varName]
      if (resolved == null) {
        throw new ConfigValidationError(
          `Config references undefined env var: \${${varName}} at ${path.join('.')}`,
          { path: path.join('.'), varName },
        )
      }
      return resolved
    })
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => interpolateEnvVars(item, [...path, String(i)]))
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        interpolateEnvVars(v, [...path, k]),
      ]),
    )
  }
  return value
}

/**
 * Validate a pre-parsed (and env-interpolated) config object against the Zod schema.
 * Throws ConfigValidationError with full Zod issue details on failure.
 */
export function validateConfig(raw: unknown): GatewayConfig {
  const result = GatewayConfigSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new ConfigValidationError(`Invalid gateway configuration:\n${issues}`, {
      issues: result.error.issues,
    })
  }
  return result.data
}

/**
 * Load YAML config from a file path, interpolate env vars, validate, and return.
 * Requires `js-yaml` installed. Throws ConfigValidationError on any failure.
 */
export async function loadConfigFile(filePath: string): Promise<GatewayConfig> {
  let raw: unknown
  try {
    // Dynamic import of js-yaml to keep it optional at compile time.
    const jsYaml = await import('js-yaml')
    const content = readFileSync(resolve(filePath), 'utf8')
    raw = jsYaml.load(content)
  } catch (err) {
    if (err instanceof ConfigValidationError) throw err
    throw new ConfigValidationError(
      `Failed to read or parse config file: ${filePath}`,
      { cause: String(err) },
    )
  }
  const interpolated = interpolateEnvVars(raw)
  return validateConfig(interpolated)
}

/**
 * Resolve the config file path from CLI args or environment.
 * Priority: --data-dir flag > GATEWAY_DATA_DIR env > default './data'
 */
export function resolveConfigPath(args: string[] = process.argv.slice(2)): string {
  const dataDirFlagIndex = args.indexOf('--data-dir')
  const dataDir =
    dataDirFlagIndex !== -1 && args[dataDirFlagIndex + 1] != null
      ? (args[dataDirFlagIndex + 1] as string)
      : (process.env['GATEWAY_DATA_DIR'] ?? './data')

  return (
    process.env['GATEWAY_CONFIG_PATH'] ??
    resolve(dataDir, 'gateway.config.yaml')
  )
}
