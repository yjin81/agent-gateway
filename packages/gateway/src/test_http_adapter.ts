// test_http_adapter.ts — Smoke test for HttpAdapter + gateway config
//
// Exercises the real HttpAdapter code path end-to-end:
//   1. Load data/.env into process.env
//   2. Load + validate data/gateway.config.yaml (env-var interpolation included)
//   3. Construct HttpAdapter exactly as index.ts does
//   4. Call adapter.run() with a minimal AgentRequest
//   5. Validate the AgentResponse shape
//
// Run:
//   cd packages/gateway
//   pnpm exec tsx src/test_http_adapter.ts

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadConfigFile } from './config/loader.js'
import { HttpAdapter } from './adapter/http.js'
import type { AgentRequest, AgentResponse } from './adapter/types.js'

// ── Colours ───────────────────────────────────────────────────────────────────

const G = (s: string) => `\x1b[32m${s}\x1b[0m`
const R = (s: string) => `\x1b[31m${s}\x1b[0m`
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`

let failures = 0

function pass(label: string, detail = '') {
  console.log(`  [${G('PASS')}] ${label}${detail ? `  — ${detail}` : ''}`)
}
function fail(label: string, detail = '') {
  failures++
  console.log(`  [${R('FAIL')}] ${label}${detail ? `  — ${detail}` : ''}`)
}
function warn(label: string, detail = '') {
  console.log(`  [${Y('WARN')}] ${label}${detail ? `  — ${detail}` : ''}`)
}

// ── .env loader ───────────────────────────────────────────────────────────────

function loadDotEnv(envPath: string): void {
  let text: string
  try {
    text = readFileSync(envPath, 'utf8')
  } catch {
    return
  }
  for (const line of text.split('\n')) {
    const stripped = line.trim()
    if (!stripped || stripped.startsWith('#')) continue
    const eq = stripped.indexOf('=')
    if (eq === -1) continue
    const key = stripped.slice(0, eq).trim()
    const val = stripped.slice(eq + 1).trim()
    if (key && !(key in process.env)) {
      process.env[key] = val
    }
  }
}

// ── JWT expiry helper ─────────────────────────────────────────────────────────

function jwtExpiry(token: string): { exp: number; upn: string } | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const pad = parts[1]!.length % 4
    const b64 = parts[1]! + (pad ? '='.repeat(4 - pad) : '')
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'))
    return { exp: payload.exp ?? 0, upn: payload.upn ?? payload.unique_name ?? '' }
  } catch {
    return null
  }
}

// ── Minimal AgentRequest ──────────────────────────────────────────────────────

function makeRequest(): AgentRequest {
  return {
    sessionKey: 'v1:test:smoke-test-session',
    message: 'Reply with exactly one word: OK',
    messageRaw: 'Reply with exactly one word: OK',
    media: [],
    isNew: true,
    wasAutoReset: false,
    platform: {
      name: 'wechat',
      chatKind: 'dm',
      userId: 'smoke-test-user',
      userName: 'Smoke Test',
      accountId: 'wechat-personal',
      mentions: [],
    },
    toolPolicy: { allowedTools: [], disabledTools: [] },
    abortSignal: new AbortController().signal,
    progressCallback: () => {},
    approvalCallback: async () => 'approved',
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const repoRoot = resolve(import.meta.dirname, '../../../')
  const envPath = resolve(repoRoot, 'data/.env')
  const configPath = resolve(repoRoot, 'data/gateway.config.yaml')

  console.log('='.repeat(60))
  console.log('  agent-gateway HttpAdapter smoke test')
  console.log('='.repeat(60))

  // ── 1. Load .env ────────────────────────────────────────────────────────────
  console.log('\n[1] data/.env')
  loadDotEnv(envPath)
  pass('.env loaded', envPath)

  for (const v of ['AGENT_TOKEN', 'ADAPTER_URL', 'WECHAT_TOKEN', 'WECHAT_ILINK_BOT_ID', 'WECHAT_BASE_URL']) {
    const val = process.env[v] ?? ''
    if (val) {
      pass(`${v} is set`, val.slice(0, 16) + (val.length > 16 ? '...' : ''))
    } else {
      fail(`${v} is empty`)
    }
  }

  // ── 2. Check AGENT_TOKEN expiry ─────────────────────────────────────────────
  console.log('\n[2] AGENT_TOKEN — JWT expiry')
  const rawToken = process.env['AGENT_TOKEN'] ?? ''
  let tokenExpired = false
  if (rawToken) {
    const info = jwtExpiry(rawToken)
    if (info) {
      const remaining = info.exp - Math.floor(Date.now() / 1000)
      if (remaining > 0) {
        const m = Math.floor(remaining / 60)
        pass('Token valid', `expires in ${m}m ${remaining % 60}s`)
      } else {
        tokenExpired = true
        fail('Token EXPIRED', `expired ${Math.floor(-remaining / 60)}m ago — refresh with:`)
        console.log('       az account get-access-token --resource https://ai.azure.com --query accessToken -o tsv')
      }
      if (info.upn) pass('Token identity', info.upn)
    } else {
      warn('Could not decode JWT payload')
    }
  } else {
    fail('AGENT_TOKEN not set')
    tokenExpired = true
  }

  // ── 3. Load + validate config ───────────────────────────────────────────────
  console.log('\n[3] gateway.config.yaml — load + validate')
  let adapterUrl = ''
  let bearerTokenEnv = ''
  let config: Awaited<ReturnType<typeof loadConfigFile>> | undefined
  try {
    config = await loadConfigFile(configPath)
    pass('Config parsed + schema validated')

    if (config.adapter.type === 'http') {
      adapterUrl = config.adapter.url
      bearerTokenEnv = config.adapter.bearerTokenEnv ?? ''
      pass('Adapter type is http')
      pass('Adapter URL', adapterUrl.slice(0, 72) + (adapterUrl.length > 72 ? '...' : ''))
      if (bearerTokenEnv) {
        pass('bearerTokenEnv', bearerTokenEnv)
      } else {
        warn('bearerTokenEnv not set — requests will be unauthenticated')
      }
    } else {
      fail(`Expected adapter.type=http, got: ${config.adapter.type}`)
    }

    const wechat = config.connectors.find((c) => c.type === 'wechat')
    if (wechat) {
      pass('WeChat connector present', `accountId=${wechat.accountId}`)
    } else {
      warn('No WeChat connector found in config')
    }
  } catch (err) {
    fail('Config load failed', String(err))
  }

  // ── 4. HttpAdapter.run() ────────────────────────────────────────────────────
  console.log('\n[4] HttpAdapter.run() — live request')

  let adapterProtocol: 'agent-request' | 'openai-responses' = 'agent-request'
  let adapterModel = ''
  if (config?.adapter.type === 'http') {
    adapterProtocol = config.adapter.protocol
    adapterModel = config.adapter.model ?? ''
    pass('Protocol', adapterProtocol)
    if (adapterModel) pass('Model', adapterModel)
  }

  if (!adapterUrl) {
    fail('No adapter URL — skipping live request')
  } else if (tokenExpired) {
    fail('AGENT_TOKEN expired — skipping live request (refresh the token first)')
  } else {
    // Construct HttpAdapter exactly as index.ts does
    const adapter = new HttpAdapter(
      adapterUrl,
      bearerTokenEnv ? async () => process.env[bearerTokenEnv] ?? '' : undefined,
      { protocol: adapterProtocol, ...(adapterModel ? { model: adapterModel } : {}) },
    )

    const request = makeRequest()
    process.stdout.write('  Calling adapter.run()... ')
    const t0 = Date.now()
    let response: AgentResponse
    try {
      response = await adapter.run(request)
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      console.log(`done (${elapsed}s)`)
      pass(`HTTP 200 received`, `${elapsed}s`)
    } catch (err) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      console.log(`failed (${elapsed}s)`)
      fail('adapter.run() threw', String(err))
      printSummary()
      return
    }

    // Validate AgentResponse shape
    console.log('\n[5] AgentResponse — shape validation')
    if (typeof response.text === 'string') {
      pass("'text' is a string", JSON.stringify(response.text.slice(0, 120)))
    } else {
      fail("'text' field missing or not a string", String(response.text))
    }

    if (Array.isArray(response.media)) {
      pass(`'media' is an array`, `${response.media.length} item(s)`)
    } else {
      fail("'media' field missing or not an array")
    }

    if (typeof response.interrupted === 'boolean') {
      pass(`'interrupted' is a boolean`, String(response.interrupted))
    } else {
      warn("'interrupted' field missing or not a boolean")
    }
  }

  printSummary()
}

function printSummary() {
  console.log('\n' + '='.repeat(60))
  if (failures === 0) {
    console.log(`  ${G('All checks passed.')}`)
  } else {
    console.log(`  ${R(`${failures} check(s) failed.`)}`)
  }
  console.log('='.repeat(60))
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(R('\n[fatal] Unhandled error:'), err)
  process.exit(1)
})
