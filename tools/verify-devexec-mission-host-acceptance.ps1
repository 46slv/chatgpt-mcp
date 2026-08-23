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

# Windows PowerShell 5.1's Set-Content -Encoding UTF8 emits a UTF-8 BOM.
# Node's JSON.parse rejects that BOM, so all persisted host-evidence text is
# written explicitly as UTF-8 without BOM for consistent pwsh/Windows
# PowerShell behavior and deterministic verifier input.
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][AllowEmptyString()][string]$Text
    )
    [System.IO.File]::WriteAllText($Path, $Text, $script:Utf8NoBom)
}

# Mirror devexec-goal.mjs BASE semantics. Host lock/file-identity checks must run
# on the filesystem that actually stores Mission state, not whichever volume the
# operator chooses for evidence output.
$missionBase = $env:LOCALAPPDATA
if ([string]::IsNullOrWhiteSpace($missionBase)) {
    $home = $env:USERPROFILE
    if ([string]::IsNullOrWhiteSpace($home)) {
        throw "LOCALAPPDATA/USERPROFILE unavailable for Mission probe root"
    }
    $missionBase = Join-Path $home "AppData\Local"
}
if (-not (Test-Path -LiteralPath $missionBase -PathType Container)) {
    throw "Mission probe root does not exist: $missionBase"
}
$missionBase = (Resolve-Path -LiteralPath $missionBase).Path

if ([string]::IsNullOrWhiteSpace($EvidenceRoot)) {
    $EvidenceRoot = Join-Path $missionBase "ChatGPTMCPProbe\mission-host-acceptance"
}
if (-not (Test-Path -LiteralPath $EvidenceRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $EvidenceRoot -Force -ErrorAction Stop | Out-Null
}
$EvidenceRoot = (Resolve-Path -LiteralPath $EvidenceRoot).Path

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

    $outputText = if ($captured.Count -gt 0) {
        [string]::Join([Environment]::NewLine, $captured) + [Environment]::NewLine
    } else {
        ""
    }
    Write-Utf8NoBom -Path $outputFile -Text $outputText
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
Write-Host "Mission probe root: $missionBase"
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

$previousIdentityRoot = $env:DEVEXEC_FILE_IDENTITY_PROBE_ROOT
$env:DEVEXEC_FILE_IDENTITY_PROBE_ROOT = $missionBase
try {
    $identityFile = Invoke-AndPersist -Name "02-file-identity" -RequiredMarker "MISSION_FILE_IDENTITY_HOST_PROBE=PASS" -Action {
        & $node (Join-Path $PSScriptRoot "devexec-mission-file-identity-host-probe.mjs")
    }
} finally {
    $env:DEVEXEC_FILE_IDENTITY_PROBE_ROOT = $previousIdentityRoot
}

$previousMissionProbeRoot = $env:DEVEXEC_MISSION_HOST_PROBE_ROOT
$env:DEVEXEC_MISSION_HOST_PROBE_ROOT = $missionBase
try {
    $lockFile = Invoke-AndPersist -Name "03-host-lock-process" -RequiredMarker "MISSION_HOST_LOCK_ACCEPTANCE=PASS" -Action {
        & $node (Join-Path $PSScriptRoot "devexec-mission-host-lock-acceptance.mjs")
    }
} finally {
    $env:DEVEXEC_MISSION_HOST_PROBE_ROOT = $previousMissionProbeRoot
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
    mission_probe_root = $missionBase
    evidence_root = $runDir
    checks = [ordered]@{
        source_checkout_preflight_clean = "PASS"
        mission_reliability_bundle = "PASS"
        mission_filesystem_hardlink_identity = "PASS"
        mission_filesystem_real_process_live_owner_refusal_and_kill_recovery = "PASS"
        mission_filesystem_returned_thenable_cross_process_exclusion = "PASS"
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
$summaryJson = $summary | ConvertTo-Json -Depth 8
Write-Utf8NoBom -Path $summaryPath -Text ($summaryJson + [Environment]::NewLine)
$summaryHash = (Get-FileHash -LiteralPath $summaryPath -Algorithm SHA256).Hash

# Validate the persisted packet after every component and SUMMARY have already
# been written. This readback recomputes every component SHA, rechecks the exact
# PASS marker set, pins the commit, repository checkout, and Mission filesystem
# root, and writes an immutable receipt that binds the exact SUMMARY bytes to
# the observed artifacts.
$verificationPath = Join-Path $runDir "VERIFICATION.json"
$evidenceVerifier = Join-Path $PSScriptRoot "devexec-mission-host-evidence-verify.mjs"
$verificationOutput = @(
    & $node $evidenceVerifier `
        --summary $summaryPath `
        --expected-head $ExpectedHead `
        --expected-repo-root $repoRoot `
        --expected-mission-probe-root $missionBase `
        --receipt $verificationPath 2>&1
)
$verificationExit = $LASTEXITCODE
foreach ($line in $verificationOutput) { Write-Host $line }
if ($verificationExit -ne 0) {
    throw "Mission host evidence readback failed with exit $verificationExit; summary: $summaryPath"
}
$verificationMarkerSeen = $false
foreach ($line in $verificationOutput) {
    if ($line.ToString().Trim() -eq "MISSION_HOST_EVIDENCE_VERIFY=PASS") {
        $verificationMarkerSeen = $true
        break
    }
}
if (-not $verificationMarkerSeen) {
    throw "Mission host evidence verifier exited 0 without MISSION_HOST_EVIDENCE_VERIFY=PASS; summary: $summaryPath"
}
if (-not (Test-Path -LiteralPath $verificationPath -PathType Leaf)) {
    throw "Mission host evidence verifier did not persist VERIFICATION.json: $verificationPath"
}
$verificationHash = (Get-FileHash -LiteralPath $verificationPath -Algorithm SHA256).Hash

Write-Host "SUMMARY=$summaryPath"
Write-Host "SUMMARY_SHA256=$summaryHash"
Write-Host "VERIFICATION=$verificationPath"
Write-Host "VERIFICATION_SHA256=$verificationHash"
Write-Host "MISSION_HOST_ACCEPTANCE=PASS"
Write-Host "Local Agent/Local Executor E2E and power-loss durability remain separate acceptance boundaries."
