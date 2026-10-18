# Start Codex Remote Web behind a private Tailscale Serve HTTPS endpoint.
# The Node server stays bound to loopback. No Funnel or public listener is enabled.
param(
  [string[]] $Workspaces = @(),
  [ValidateRange(1, 65535)] [int] $HttpsPort = 8443
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$target = "http://127.0.0.1:4765"

$tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if (-not $tailscale) {
  $installed = "C:\Program Files\Tailscale\tailscale.exe"
  if (-not (Test-Path -LiteralPath $installed -PathType Leaf)) {
    throw "Tailscale is not installed. Install and sign in to Tailscale first."
  }
  $tailscalePath = $installed
} else {
  $tailscalePath = $tailscale.Source
}

$status = & $tailscalePath status --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $status.BackendState -ne "Running") {
  throw "Tailscale is not connected. Open Tailscale and sign in first."
}
$hostname = [string] $status.Self.DNSName
$hostname = $hostname.TrimEnd(".").ToLowerInvariant()
if ($hostname -notmatch '^[a-z0-9-]+(\.[a-z0-9-]+)+\.ts\.net$') {
  throw "Could not verify the private Tailscale HTTPS hostname."
}

$key = "${hostname}:${HttpsPort}"
$config = & $tailscalePath serve status --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Cannot inspect Tailscale Serve configuration." }

$funnel = $config.AllowFunnel.PSObject.Properties[$key]
if ($funnel -and $funnel.Value) {
  throw "Refusing to run: HTTPS port $HttpsPort is exposed by Tailscale Funnel."
}

$existing = $config.Web.PSObject.Properties[$key]
if ($existing) {
  $rootHandler = $existing.Value.Handlers.PSObject.Properties["/"]
  if (-not $rootHandler -or $rootHandler.Value.Proxy -ne $target) {
    throw "HTTPS port $HttpsPort is already used by another Tailscale service."
  }
} else {
  if ($config.TCP.PSObject.Properties[[string] $HttpsPort]) {
    throw "HTTPS port $HttpsPort is already reserved in Tailscale."
  }
  & $tailscalePath serve --bg "--https=$HttpsPort" --yes $target
  if ($LASTEXITCODE -ne 0) { throw "Could not configure private Tailscale Serve." }
}

$verify = & $tailscalePath serve status --json | ConvertFrom-Json
if ($verify.AllowFunnel.PSObject.Properties[$key]) {
  throw "Refusing to run: the endpoint is marked as public."
}

if ($Workspaces.Count -eq 0 -and [string]::IsNullOrWhiteSpace($env:CODEX_WORKSPACES)) {
  $localWorkspaces = Join-Path $projectRoot ".local\tailnet-workspaces.txt"
  if (Test-Path -LiteralPath $localWorkspaces -PathType Leaf) {
    $Workspaces = @(Get-Content -LiteralPath $localWorkspaces |
      ForEach-Object { $_.Trim() } |
      Where-Object { $_ -and -not $_.StartsWith("#") })
  }
}

if ($Workspaces.Count -gt 0) {
  foreach ($workspace in $Workspaces) {
    if (-not (Test-Path -LiteralPath $workspace -PathType Container)) {
      throw "Workspace directory does not exist: $workspace"
    }
  }
  $env:CODEX_WORKSPACES = $Workspaces -join [IO.Path]::PathSeparator
}

$env:HOST = "127.0.0.1"
$env:PORT = "4765"
$env:TRUSTED_HOSTS = $hostname
Set-Location -LiteralPath $projectRoot
Write-Host "Private iPad Safari URL: https://${hostname}:${HttpsPort}/"
Write-Host "The iPad must be signed in to the same Tailscale tailnet."
Write-Host "This is Tailscale Serve, not public Funnel. Keep this terminal open."
& npm.cmd start
exit $LASTEXITCODE
