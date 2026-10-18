# Browser-only iPad/Safari access: public HTTPS Funnel -> authenticated loopback gateway -> local Codex.
# Existing Funnel/Serve ports (including 443 and 8443) are never modified.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$tailscale = "C:\Program Files\Tailscale\tailscale.exe"
if (-not (Test-Path -LiteralPath $tailscale -PathType Leaf)) { throw "Tailscale must be installed on your PC." }
$status = & $tailscale status --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $status.BackendState -ne "Running") { throw "Tailscale on PC is not connected." }
$name = ([string] $status.Self.DNSName).TrimEnd(".").ToLowerInvariant()
if ($name -notmatch '^[a-z0-9-]+(\.[a-z0-9-]+)+\.ts\.net$') { throw "Cannot verify Tailscale DNS name." }
$publicHost = "${name}:10000"
$publicUrl = "https://${publicHost}/"

$config = & $tailscale funnel status --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Cannot inspect Tailscale Funnel settings." }
$existing = $config.Web.PSObject.Properties[$publicHost]
if ($existing) {
  $rootHandler = $existing.Value.Handlers.PSObject.Properties["/"]
  if (-not $rootHandler -or $rootHandler.Value.Proxy -ne "http://127.0.0.1:4776") {
    throw "Port 10000 is assigned to a different service. Refusing to replace it."
  }
} elseif ($config.TCP.PSObject.Properties["10000"]) {
  throw "Port 10000 is already reserved. Refusing to change it."
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$workspaceFile = Join-Path $root ".local\tailnet-workspaces.txt"
if ([string]::IsNullOrWhiteSpace($env:CODEX_WORKSPACES) -and (Test-Path -LiteralPath $workspaceFile)) {
  $workspaces = @(Get-Content -LiteralPath $workspaceFile |
    ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith("#") })
  foreach ($workspace in $workspaces) {
    if (-not (Test-Path -LiteralPath $workspace -PathType Container)) {
      throw "Configured workspace directory does not exist: $workspace"
    }
  }
  if ($workspaces.Count -gt 0) { $env:CODEX_WORKSPACES = $workspaces -join [IO.Path]::PathSeparator }
}
$env:HOST = "127.0.0.1"
$env:PORT = "4765"
$env:REMOTE_PUBLIC_HOST = $publicHost
$env:REMOTE_GATEWAY_PORT = "4776"

function Ensure-NodeService([int] $servicePort, [string] $entry, [string] $processMarker) {
  $existingListener = Get-NetTCPConnection -LocalPort $servicePort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($existingListener) {
    if ($existingListener.LocalAddress -ne "127.0.0.1") { throw "Port $servicePort binds outside loopback." }
    $existingProcess = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $existingListener.OwningProcess)
    if (-not $existingProcess -or $existingProcess.CommandLine -notmatch [regex]::Escape($processMarker)) {
      throw "Another process is using port $servicePort."
    }
    return
  }
  $entryPath = Join-Path $root $entry
  Start-Process -FilePath $node -ArgumentList ('"' + $entryPath + '"') -WorkingDirectory $root -WindowStyle Hidden | Out-Null
  for ($n = 0; $n -lt 35; $n++) {
    Start-Sleep -Milliseconds 400
    $running = Get-NetTCPConnection -LocalPort $servicePort -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalAddress -eq "127.0.0.1" } | Select-Object -First 1
    if ($running) { return }
  }
  throw "Local service $entry failed to start."
}

Ensure-NodeService 4765 "server\index.mjs" "index.mjs"
Ensure-NodeService 4776 "server\remote-gateway.mjs" "remote-gateway.mjs"

# Local checks must pass before publishing any HTTPS endpoint.
$health = Invoke-RestMethod -Uri "http://127.0.0.1:4765/api/health" -TimeoutSec 5
if (-not $health.ok -or -not $health.codexReady) { throw "Local Codex app-server is not ready." }
$localGate = Invoke-WebRequest -Uri "http://127.0.0.1:4776/" -Headers @{ Host = $publicHost } -UseBasicParsing -TimeoutSec 5
if ($localGate.StatusCode -ne 200 -or $localGate.Content -notmatch "Safari") {
  throw "Safari pairing page is not healthy."
}
$unauthorized = 0
try {
  Invoke-WebRequest -Uri "http://127.0.0.1:4776/api/threads" -Headers @{ Host = $publicHost } -UseBasicParsing -TimeoutSec 5 | Out-Null
} catch {
  $unauthorized = [int] $_.Exception.Response.StatusCode
}
if ($unauthorized -ne 401) { throw "Auth check failed: private Codex API could be exposed." }

if (-not $existing) {
  & $tailscale funnel --bg --https=10000 --yes http://127.0.0.1:4776
  if ($LASTEXITCODE -ne 0) { throw "Failed to configure Tailscale Funnel." }
}
$verify = & $tailscale funnel status --json | ConvertFrom-Json
$finalHandler = $verify.Web.PSObject.Properties[$publicHost].Value.Handlers.PSObject.Properties["/"]
if (-not $finalHandler -or $finalHandler.Value.Proxy -ne "http://127.0.0.1:4776" -or
    -not $verify.AllowFunnel.PSObject.Properties[$publicHost]) {
  throw "Funnel verification failed."
}
Write-Host "Safari public HTTPS URL: $publicUrl"
Write-Host "Only the pairing page is public. Codex API requires an authenticated browser."
Write-Host "On PC, run: npm.cmd run remote:code"
Write-Host "Stop public access with: tailscale funnel --https=10000 off"
