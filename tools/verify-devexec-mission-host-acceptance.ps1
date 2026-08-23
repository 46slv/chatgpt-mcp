param(
    [Parameter(Mandatory=$true)][string]$ExpectedHead,
    [string]$EvidenceRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$node = (Get-Command node -ErrorAction Stop).Source
$ExpectedHead = $ExpectedHead.Trim()
if ([string]::IsNullOrWhiteSpace($ExpectedHead)) {
    throw "ExpectedHead is required for authoritative Mission host acceptance"
}

if ([string]::IsNullOrWhiteSpace($EvidenceRoot)) {
    $base = $env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($base)) { $base = $env:TEMP }
    if ([string]::IsNullOrWhiteSpace($base)) { throw "LOCALAPPDATA/TEMP unavailable for evidence root" }
    $EvidenceRoot = Join-Path $base "ChatGPTMCPProbe\mission-host-acceptance"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$suffix = [Guid]::NewGuid().ToString("N").Substring(0, 8)
$runDir = Join-Path $EvidenceRoot "$stamp-$suffix"
New-Item -ItemType Directory -Path $runDir -ErrorAction Stop | Out-Null

function Invoke-AndPersist {
    param(
        [Parameter(Mandatory=$true)][string]$Name,
        [Parameter(Mandatory=$true)][string]$RequiredMarker,
        [Parameter(Mandatory=$true)][scriptblock]$Action
    )

    $outputFile = Join-Path $runDir "$Name.txt"
    $captured = [System.Collections.Generic.List[string]]::new()
    $failure = $null
    $exit = 0

    try {
        $global:LASTEXITCODE = 0
        @(& $Action 2>&1) | ForEach-Object { $captured.Add($_.ToString()) }
        $exit = $LASTEXITCODE
    } catch {
        $failure = $_
        $exit = 1
        $captured.Add($_.ToString())
        if ($_.ScriptStackTrace) {
            $captured.Add($_.ScriptStackTrace)
        }
    }

    $captured | Set-Content -LiteralPath $outputFile -Encoding UTF8
    foreach ($line in $captured) { Write-Host $line }

    if ($failure) {
        throw "$Name threw before completion; evidence: $outputFile; error: $($failure.Exception.Message)"
    }
    if ($exit -ne 0) {
        throw "$Name failed with exit $exit; evidence: $outputFile"
    }

    $markerSeen = $false
    foreach ($line in $captured) {
        if ($line.Trim() -eq $RequiredMarker) {
            $markerSeen = $true
            break
        }
    }
    if (-not $markerSeen) {
        throw "$Name exited 0 but required PASS marker '$RequiredMarker' was absent; evidence: $outputFile"
    }

    return $outputFile
}

Write-Host "=== DEV EXEC MISSION HOST ACCEPTANCE ==="
Write-Host "Repo: $repoRoot"
Write-Host "Expected HEAD: $ExpectedHead"
Write-Host "Evidence: $runDir"

$preflightScript = Join-Path $PSScriptRoot "devexec-mission-host-preflight.mjs"
$preflightFile = Invoke-AndPersist -Name "00-repo-preflight" -RequiredMarker "MISSION_HOST_PREFLIGHT=PASS" -Action {
    $preflightArgs = @($preflightScript, "--repo", $repoRoot, "--expected-head", $ExpectedHead)
    & $node @preflightArgs
}

$head = (& git rev-parse HEAD).Trim()
$branch = (& git branch --show-current).Trim()
if ([string]::IsNullOrWhiteSpace($branch)) { $branch = "DETACHED" }
Write-Host "Branch: $branch"
Write-Host "HEAD: $head"

$reliabilityFile = Invoke-AndPersist -Name "01-mission-reliability" -RequiredMarker "MISSION_RELIABILITY_CHECK=PASS" -Action {
    & (Join-Path $PSScriptRoot "verify-devexec-mission-constraint-continuation.ps1")
}

$previousProbeRoot = $env:DEVEXEC_FILE_IDENTITY_PROBE_ROOT
$env:DEVEXEC_FILE_IDENTITY_PROBE_ROOT = $runDir
try {
    $identityFile = Invoke-AndPersist -Name "02-file-identity" -RequiredMarker "MISSION_FILE_IDENTITY_HOST_PROBE=PASS" -Action {
        & $node (Join-Path $PSScriptRoot "devexec-mission-file-identity-host-probe.mjs")
    }
} finally {
    $env:DEVEXEC_FILE_IDENTITY_PROBE_ROOT = $previousProbeRoot
}

$lockFile = Invoke-AndPersist -Name "03-host-lock-process" -RequiredMarker "MISSION_HOST_LOCK_ACCEPTANCE=PASS" -Action {
    & $node (Join-Path $PSScriptRoot "devexec-mission-host-lock-acceptance.mjs")
}

# Re-run the checkout guard after every component. A host packet is only
# attributable to the recorded commit if tests did not modify tracked or
# untracked repository state while producing their evidence.
$postflightFile = Invoke-AndPersist -Name "04-repo-postflight" -RequiredMarker "MISSION_HOST_PREFLIGHT=PASS" -Action {
    & $node $preflightScript --repo $repoRoot --expected-head $ExpectedHead
}

$files = @($preflightFile, $reliabilityFile, $identityFile, $lockFile, $postflightFile)
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
    schema_version = 2
    generated_at = (Get-Date).ToString("o")
    machine = $env:COMPUTERNAME
    repo = $repoRoot
    branch = $branch
    head = $head
    expected_head = $ExpectedHead
    evidence_root = $runDir
    checks = [ordered]@{
        source_checkout_preflight_clean = "PASS"
        mission_reliability_bundle = "PASS"
        filesystem_hardlink_identity = "PASS"
        real_process_live_owner_refusal_and_kill_recovery = "PASS"
        returned_thenable_cross_process_exclusion = "PASS"
        source_checkout_postflight_clean = "PASS"
        component_pass_markers = "PASS"
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
