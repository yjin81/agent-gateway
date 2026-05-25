# start-gateway.ps1 — Local dev startup script for Agent Gateway
#
# What this does:
#   1. Loads long-lived secrets from data/.env into the current process
#   2. Fetches a fresh AGENT_TOKEN from Azure AD — fails fast if this is not possible
#   3. Sets GATEWAY_DATA_DIR to data/ relative to this script
#   4. Starts the gateway
#
# Usage (from repo root):
#   .\start-gateway.ps1
#
# Requirements:
#   - Node.js 22+, pnpm 10+
#   - Azure CLI (`az`) installed and logged in (`az login`)
#   - data/.env present with long-lived secrets (see README.md)
#
# Connector secrets loaded from data/.env:
#   WeChat:  WECHAT_TOKEN, WECHAT_ILINK_BOT_ID, WECHAT_BASE_URL
#   Slack:   SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET
#            (Slack connector is active when these are present AND enabled in gateway.config.yaml)
#
# Note: AGENT_TOKEN is intentionally NOT stored in data/.env — it is a short-lived
# Azure AD JWT that must be fetched fresh on every startup. Storing it in .env
# causes hard-to-diagnose 401s when the token expires between restarts.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = $PSScriptRoot
$DataDir  = Join-Path $RepoRoot 'data'
$EnvFile  = Join-Path $DataDir '.env'

# ── 1. Load data/.env ─────────────────────────────────────────────────────────
# Only long-lived secrets live here: WECHAT_TOKEN, bot tokens, API keys, etc.
# Short-lived tokens (AGENT_TOKEN) are fetched below, not stored here.

if (-not (Test-Path $EnvFile)) {
    Write-Error "data/.env not found at $EnvFile — create it first (see README.md)"
    exit 1
}

Write-Host "Loading $EnvFile ..."
Get-Content $EnvFile | Where-Object { $_ -match '^[A-Z_]+=.' } | ForEach-Object {
    $parts = $_ -split '=', 2
    $key   = $parts[0].Trim()
    $value = $parts[1].Trim()
    Set-Item "env:$key" $value
}

# ── 2. Fetch AGENT_TOKEN from Azure AD ───────────────────────────────────────
# Always fetched fresh — never read from .env. Fails hard if az is unavailable
# or not logged in, so the gateway never starts with a missing or expired token.
#
# Skip this block entirely if your adapter does not use Azure AD authentication
# (i.e. bearerTokenEnv is not set to AGENT_TOKEN in gateway.config.yaml).

if ($env:AGENT_ENDPOINT) {
    Write-Host "Fetching AGENT_TOKEN from Azure AD ..."
    try {
        $token = az account get-access-token --resource https://ai.azure.com --query accessToken -o tsv 2>&1
        if ($LASTEXITCODE -ne 0 -or -not $token -or $token -like '*ERROR*') {
            Write-Error "az account get-access-token failed: $token`nRun 'az login' and try again."
            exit 1
        }
        $env:AGENT_TOKEN = $token.Trim()

        # Decode exp claim and show expiry so it is visible in the terminal
        $parts   = $env:AGENT_TOKEN.Split('.')
        $pad     = $parts[1].Length % 4
        $padded  = $parts[1] + ('=' * ((4 - $pad) % 4))
        $payload = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($padded)) | ConvertFrom-Json
        $expiry  = [datetimeoffset]::FromUnixTimeSeconds($payload.exp).ToLocalTime().ToString('HH:mm:ss')
        Write-Host "  AGENT_TOKEN fetched — valid until $expiry local time"
    } catch {
        Write-Error "Failed to fetch AGENT_TOKEN: $_`nRun 'az login' and try again."
        exit 1
    }
}

# ── 3. Set GATEWAY_DATA_DIR ───────────────────────────────────────────────────

$env:GATEWAY_DATA_DIR = $DataDir
Write-Host "GATEWAY_DATA_DIR = $DataDir"

# ── 4. Connector readiness summary ───────────────────────────────────────────

Write-Host ""
Write-Host "Connector secrets detected in .env:"
if ($env:WECHAT_TOKEN -and $env:WECHAT_ILINK_BOT_ID -and $env:WECHAT_BASE_URL) {
    Write-Host "  [ok] WeChat  (WECHAT_TOKEN, WECHAT_ILINK_BOT_ID, WECHAT_BASE_URL)"
} else {
    Write-Host "  [--] WeChat  (one or more vars missing — connector will fail if enabled)"
}
if ($env:SLACK_BOT_TOKEN -and $env:SLACK_APP_TOKEN -and $env:SLACK_SIGNING_SECRET) {
    Write-Host "  [ok] Slack   (SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET)"
} else {
    Write-Host "  [--] Slack   (one or more vars missing — connector will fail if enabled)"
}
Write-Host ""

# ── 5. Start the gateway ──────────────────────────────────────────────────────

$GatewayDir = Join-Path $RepoRoot 'packages\gateway'
Write-Host "Starting gateway ..."
Write-Host ""

Set-Location $GatewayDir
pnpm exec tsx src/index.ts
