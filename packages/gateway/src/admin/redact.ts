// admin/redact.ts — Mask secret-typed config fields on read; restore unchanged
// secrets on write. The dashboard must never receive resolved secret values.

import type { RawConfig } from './config-store.js'

/** Config field names that hold secret values. */
export const SECRET_KEYS = new Set([
  'token',
  'botToken',
  'appToken',
  'signingSecret',
  'appPassword',
  'bearerToken',
])

/** The placeholder returned for a literal (non-`${ENV}`) secret value. */
export const SECRET_MASK = '••••'

/** True if a string is an `${ENV_VAR}` interpolation reference (not a literal secret). */
function isEnvReference(value: string): boolean {
  return /^\$\{[^}]+\}$/.test(value.trim())
}

/**
 * Deep-clone a raw config and mask every secret-typed field.
 *
 * `${ENV_VAR}` references are returned unchanged (they are references, not
 * secrets); literal secret strings are replaced with {@link SECRET_MASK}.
 */
export function redactConfig(raw: RawConfig): RawConfig {
  return redactValue(raw, undefined) as RawConfig
}

function redactValue(value: unknown, key: string | undefined): unknown {
  if (typeof value === 'string' && key != null && SECRET_KEYS.has(key)) {
    return isEnvReference(value) ? value : SECRET_MASK
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, undefined))
  }
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactValue(v, k)]),
    )
  }
  return value
}

/**
 * Merge an incoming (possibly redacted) candidate config with the current raw
 * config: any secret-typed field whose submitted value is still the mask is
 * restored from the current config, so submitting the mask leaves a secret
 * unchanged. Connectors are matched by `accountId`; the adapter is matched
 * positionally.
 */
export function mergeSecrets(incoming: RawConfig, current: RawConfig): RawConfig {
  const merged: RawConfig = structuredClone(incoming)

  // Restore adapter secrets.
  if (isObject(merged['adapter']) && isObject(current['adapter'])) {
    restoreSecrets(merged['adapter'], current['adapter'])
  }

  // Restore connector secrets, matched by accountId.
  if (Array.isArray(merged['connectors']) && Array.isArray(current['connectors'])) {
    const currentByAccount = new Map<string, Record<string, unknown>>()
    for (const c of current['connectors']) {
      if (isObject(c) && typeof c['accountId'] === 'string') {
        currentByAccount.set(c['accountId'], c)
      }
    }
    for (const c of merged['connectors']) {
      if (!isObject(c) || typeof c['accountId'] !== 'string') continue
      const prev = currentByAccount.get(c['accountId'])
      if (prev != null) restoreSecrets(c, prev)
    }
  }

  return merged
}

/** For each secret key on `target` whose value is the mask, copy from `source`. */
function restoreSecrets(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of SECRET_KEYS) {
    if (target[key] === SECRET_MASK && key in source) {
      target[key] = source[key]
    }
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}
