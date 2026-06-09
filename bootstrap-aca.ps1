# bootstrap-aca.ps1 — One-time setup of secrets + ingress for the Container App
#
# What this does:
#   1. Loads long-lived secrets from data/.env
#   2. Stores them as Azure Container App secrets (never plaintext env vars)
#   3. Maps them to the ${ENV_VAR} names the baked gateway.config.yaml expects
#   4. Enables external ingress on the gateway port (so /admin is reachable)
#
# Run this ONCE after the Container App is created (and again only if secrets
# or ingress settings change). Day-to-day image rollouts use deploy.ps1.
#
# Usage (from repo root):
#   .\bootstrap-aca.ps1
#   .\bootstrap-aca.ps1 -SkipIngress          # secrets only
#   .\bootstrap-aca.ps1 -TargetPort 3000      # custom ingress port
#
# Requirements:
#   - Azure CLI (`az`) installed and logged in (`az login`)
#   - data/.env present with the gateway's long-lived secrets (see README.md)

[CmdletBinding()]
param(
    [string]$ResourceGroup = 'mcptooldemo',
    [string]$ContainerApp  = 'agentgateway',
    [int]   $TargetPort    = 3000,
    [switch]$SkipIngress
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = $PSScriptRoot
$EnvFile  = Join-Path $RepoRoot 'data\.env'

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

# ── 1. Load data/.env ───────────────────────────────────────────────────────
if (-not (Test-Path $EnvFile)) {
    throw "data/.env not found at $EnvFile — create it first (see README.md)"
}

Write-Step "Loading secrets from $EnvFile"
$EnvVars = @{}
Get-Content $EnvFile | Where-Object { $_ -match '^[A-Z_]+=.' } | ForEach-Object {
    $parts = $_ -split '=', 2
    $EnvVars[$parts[0].Trim()] = $parts[1].Trim()
}

# The env-var names the baked gateway.config.yaml interpolates. Only these are
# pushed to the Container App; anything else in .env is ignored.
$RequiredVars = @(
    'AGENT_ENDPOINT',
    'AGENT_API_KEY',
    'WECHAT_TOKEN',
    'WECHAT_ILINK_BOT_ID',
    'WECHAT_BASE_URL',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_SIGNING_SECRET'
)
# Optional vars: pushed only if present in .env.
$OptionalVars = @(
    'GATEWAY_ADMIN_TOKEN',
    'GATEWAY_ADMIN_COOKIE_SECURE'
)

$missing = $RequiredVars | Where-Object { -not $EnvVars.ContainsKey($_) -or [string]::IsNullOrWhiteSpace($EnvVars[$_]) }
if ($missing) {
    throw "Missing required vars in data/.env: $($missing -join ', ')"
}

$VarsToPush = @()
$VarsToPush += $RequiredVars
$VarsToPush += $OptionalVars | Where-Object { $EnvVars.ContainsKey($_) -and -not [string]::IsNullOrWhiteSpace($EnvVars[$_]) }

# ── 2. Build secret + env-var mappings ──────────────────────────────────────
# ACA secret names must be lowercase alphanumeric + dashes. Convert FOO_BAR -> foo-bar.
$SecretArgs = @()   # name=value pairs for `az containerapp secret set`
$EnvArgs    = @()   # NAME=secretref:name pairs for `az containerapp update`
foreach ($name in $VarsToPush) {
    $secretName = $name.ToLower().Replace('_', '-')
    $SecretArgs += "$secretName=$($EnvVars[$name])"
    $EnvArgs    += "$name=secretref:$secretName"
}

# ── 3. Push secrets ─────────────────────────────────────────────────────────
Write-Step "Setting $($SecretArgs.Count) secrets on $ContainerApp"
az containerapp secret set `
    --name $ContainerApp `
    --resource-group $ResourceGroup `
    --secrets $SecretArgs `
    --output none
if ($LASTEXITCODE -ne 0) { throw "az containerapp secret set failed (exit $LASTEXITCODE)" }

# ── 4. Map secrets to env vars ──────────────────────────────────────────────
Write-Step "Setting $($EnvArgs.Count) env vars (secret references)"
az containerapp update `
    --name $ContainerApp `
    --resource-group $ResourceGroup `
    --set-env-vars $EnvArgs `
    --output none
if ($LASTEXITCODE -ne 0) { throw "az containerapp update (env vars) failed (exit $LASTEXITCODE)" }

Write-Host "Pushed: $($VarsToPush -join ', ')" -ForegroundColor Green

# ── 5. Enable ingress ───────────────────────────────────────────────────────
if (-not $SkipIngress) {
    Write-Step "Enabling external ingress on port $TargetPort"
    az containerapp ingress enable `
        --name $ContainerApp `
        --resource-group $ResourceGroup `
        --type external `
        --target-port $TargetPort `
        --transport http `
        --output none
    if ($LASTEXITCODE -ne 0) { throw "az containerapp ingress enable failed (exit $LASTEXITCODE)" }

    $fqdn = az containerapp show -g $ResourceGroup -n $ContainerApp `
        --query 'properties.configuration.ingress.fqdn' --output tsv
    Write-Host "Ingress FQDN: https://$fqdn" -ForegroundColor Green
    if ($EnvVars.ContainsKey('GATEWAY_ADMIN_TOKEN')) {
        Write-Host "Admin portal: https://$fqdn/admin" -ForegroundColor Green
    }
} else {
    Write-Step "Skipping ingress (-SkipIngress)"
}

Write-Step "Done"
Write-Host "Check logs: az containerapp logs show -g $ResourceGroup -n $ContainerApp --tail 50 --type console"
