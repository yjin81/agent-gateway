# deploy.ps1 — Build, push, and deploy Agent Gateway to Azure Container Apps
#
# What this does:
#   1. Builds the Docker image locally from the repo Dockerfile
#   2. Logs in to the Azure Container Registry (ACR) and pushes the image
#      (pinned by digest so :latest always rolls a new revision)
#   3. Updates the Azure Container App (ACA) to the freshly pushed image
#
# Usage (from repo root):
#   .\deploy.ps1                       # uses the defaults below
#   .\deploy.ps1 -Tag v1.2.0           # custom tag
#   .\deploy.ps1 -SkipBuild            # reuse the local image, just push + update
#
# Requirements:
#   - Docker Desktop running (local build)
#   - Azure CLI (`az`) installed and logged in (`az login`)
#   - Access to the target ACR and Container App
#
# Note: the image bakes in data/gateway.config.yaml. Secrets referenced as
# ${ENV_VAR} in that file must be set on the Container App (env vars / secrets)
# or the gateway will fail validation at startup.

[CmdletBinding()]
param(
    [string]$Registry      = 'gateway4agent',
    [string]$Image         = 'agent-gateway',
    [string]$Tag           = 'latest',
    [string]$ResourceGroup = 'mcptooldemo',
    [string]$ContainerApp  = 'agentgateway',
    [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot   = $PSScriptRoot
$LoginServer = "$Registry.azurecr.io"
$ImageRef    = "$LoginServer/${Image}:$Tag"

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

# ── 1. Build ────────────────────────────────────────────────────────────────
if (-not $SkipBuild) {
    Write-Step "Building image: $ImageRef"
    docker build -t $ImageRef -f (Join-Path $RepoRoot 'Dockerfile') $RepoRoot
    if ($LASTEXITCODE -ne 0) { throw "docker build failed (exit $LASTEXITCODE)" }
} else {
    Write-Step "Skipping build (using existing local image: $ImageRef)"
}

# ── 2. Push ─────────────────────────────────────────────────────────────────
Write-Step "Logging in to ACR: $Registry"
az acr login --name $Registry
if ($LASTEXITCODE -ne 0) { throw "az acr login failed (exit $LASTEXITCODE)" }

Write-Step "Pushing image: $ImageRef"
docker push $ImageRef
if ($LASTEXITCODE -ne 0) { throw "docker push failed (exit $LASTEXITCODE)" }

# Resolve the pushed digest so the ACA update always creates a new revision,
# even when the tag (e.g. :latest) is unchanged.
Write-Step "Resolving pushed image digest"
$Digest = az acr repository show --name $Registry --image "${Image}:$Tag" `
    --query 'digest' --output tsv
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($Digest)) {
    throw "Failed to resolve image digest from ACR"
}
$ImageByDigest = "$LoginServer/$Image@$Digest"
Write-Host "Digest: $Digest"

# ── 3. Update ACA ───────────────────────────────────────────────────────────
Write-Step "Updating Container App: $ContainerApp (rg: $ResourceGroup)"
az containerapp update `
    --name $ContainerApp `
    --resource-group $ResourceGroup `
    --image $ImageByDigest `
    --query '{revision:properties.latestRevisionName, state:properties.provisioningState}' `
    --output table
if ($LASTEXITCODE -ne 0) { throw "az containerapp update failed (exit $LASTEXITCODE)" }

Write-Step "Done"
Write-Host "Deployed $ImageByDigest to $ContainerApp" -ForegroundColor Green
Write-Host "Check status:  az containerapp revision list -g $ResourceGroup -n $ContainerApp -o table"
Write-Host "Check logs:    az containerapp logs show -g $ResourceGroup -n $ContainerApp --tail 50 --type console"
