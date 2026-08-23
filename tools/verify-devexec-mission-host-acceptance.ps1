param(
    [string]$ExpectedHead = "",
    [string]$EvidenceRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$node = (Get-Command node -ErrorAction Stop).Source
$head = (& git rev-parse HEAD).Trim()
$branch = (& git branch --show-current).Trim()
if ([string]::IsNullOrWhiteSpace($branch)) { $branch = "DETACHED" }

if (-not [string]::IsNullOrWhiteSpace($ExpectedHead) -and $head -ne $ExpectedHead.Trim()) {
    throw "HEAD mismatch: expected $($ExpectedHead.Trim()) observed $head"
}

if ([string]::IsNullOrWhiteSpace($EvidenceRoot)) {
    $base = $env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($base)) { $base = $env:TEMP }
    if ([string]::IsNullOrWhiteSpace($base)) { throw "LOCALAPPDATA/TEMP unavailable for evidence root" }
    $EvidenceRoot = Join-Path $base "ChatGPTMCPProbe\mission-host-acceptance"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDir = Join-Path $EvidenceRoot $stamp
New-Item -ItemType Directory -Path $runDir -Force | Out-Null

function Invoke-AndPersist {
    param(
        [Parameter(Mandatory=$true)][string]$Name,
        [Parameter(Mandatory=$true)][scriptblock]$Action
    )

    $outputFile = Join-Path $runDir "$Name.txt"
    $captured = @(& $Action 2>&1 | ForEach-Object { $_.ToString() })
    $exit = $LASTEXITCODE
    $captured | Set-Content -LiteralPath $outputFile -Encoding UTF8
    foreach ($line in $captured) { Write-Host $line }
    if ($exit -ne 0) {
        throw "$Name failed with exit $exit; evidence: $outputFile"
    }
    return $outputFile
}

Write-Host "=== DEV EXEC MISSION HOST ACCEPTANCE ==="
Write-Host "Repo: $repoRoot"
Write-Host "Branch: $branch"
Write-Host "HEAD: $head"
Write-Host "Evidence: $runDir"

$reliabilityFile = Invoke-AndPersist -Name "01-mission-reliability" -Action {
    & (Join-Path $PSScriptRoot "verify-devexec-mission-constraint-continuation.ps1")
}

$previousProbeRoot = $env:DEVEXEC_FILE_IDENTITY_PROBE_ROOT
$env:DEVEXEC_FILE_IDENTITY_PROBE_ROOT = $runDir
try {
    $identityFile = Invoke-AndPersist -Name "02-file-identity" -Action {
        & $node (Join-Path $PSScriptRoot "devexec-mission-file-identity-host-probe.mjs")
    }
} finally {
    $env:DEVEXEC_FILE_IDENTITY_PROBE_ROOT = $previousProbeRoot
}

$lockFile = Invoke-AndPersist -Name "03-host-lock-process" -Action {
    & $node (Join-Path $PSScriptRoot "devexec-mission-host-lock-acceptance.mjs")
}

$files = @($reliabilityFile, $identityFile, $lockFile)
$artifacts = @()
foreach ($file in $files) {
    $hash = Get-FileHash -LiteralPath $file -Algorithm SHA256
    $artifacts += [ordered]@{
        path = $file
        sha256 = $hash.Hash
    }
}

$summary = [ordered]@{
    protocol = "devexec.mission-host-acceptance"
    schema_version = 1
    generated_at = (Get-Date).ToString("o")
    machine = $env:COMPUTERNAME
    repo = $repoRoot
    branch = $branch
    head = $head
    expected_head = if ([string]::IsNullOrWhiteSpace($ExpectedHead)) { $null } else { $ExpectedHead.Trim() }
    evidence_root = $runDir
    checks = [ordered]@{
        mission_reliability_bundle = "PASS"
        filesystem_hardlink_identity = "PASS"
        real_process_live_owner_refusal_and_kill_recovery = "PASS"
        returned_thenable_cross_process_exclusion = "PASS"
    }
    host_only_remainder = @(
        "Local Agent/Local Executor end-to-end integration",
        "mission child launch forced-kill timing beyond the existing process regressions",
        "power-loss/fsync durability"
    )
    artifacts = $artifacts
}

$summaryPath = Join-Path $runDir "SUMMARY.json"
$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
$summaryHash = (Get-FileHash -LiteralPath $summaryPath -Algorithm SHA256).Hash

Write-Host "SUMMARY=$summaryPath"
Write-Host "SUMMARY_SHA256=$summaryHash"
Write-Host "MISSION_HOST_ACCEPTANCE=PASS"
Write-Host "Local Agent/Local Executor E2E and power-loss durability remain separate acceptance boundaries."
