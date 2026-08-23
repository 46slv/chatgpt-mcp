param(
    [Parameter(Mandatory = $true)]
    [string]$MissionRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$probe = Join-Path $repoRoot "tools\devexec-mission-file-identity-host-probe.mjs"

if (-not (Test-Path -LiteralPath $MissionRoot -PathType Container)) {
    throw "MissionRoot must be an existing directory: $MissionRoot"
}
if (-not (Test-Path -LiteralPath $probe -PathType Leaf)) {
    throw "File identity probe missing: $probe"
}

$resolvedRoot = (Resolve-Path -LiteralPath $MissionRoot).Path
$priorProbeRoot = $env:DEVEXEC_FILE_IDENTITY_PROBE_ROOT
try {
    $env:DEVEXEC_FILE_IDENTITY_PROBE_ROOT = $resolvedRoot
    Write-Host "=== DEV EXEC MISSION FILE IDENTITY HOST CHECK ==="
    Write-Host "Platform: $([System.Environment]::OSVersion.VersionString)"
    Write-Host "MissionRoot: $resolvedRoot"
    Write-Host "Node: $node"
    & $node $probe
    if ($LASTEXITCODE -ne 0) {
        throw "Mission file identity probe failed with exit $LASTEXITCODE"
    }
    Write-Host "MISSION_FILE_IDENTITY_HOST_CHECK=PASS"
} finally {
    $env:DEVEXEC_FILE_IDENTITY_PROBE_ROOT = $priorProbeRoot
}
