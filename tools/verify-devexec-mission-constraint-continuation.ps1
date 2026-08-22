$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$node = (Get-Command node -ErrorAction Stop).Source

$syntaxFiles = @(
    "tools/devexec-mission-objective.mjs",
    "tools/devexec-mission-loop-boundary.mjs",
    "tools/devexec-mission-launch.mjs",
    "tools/devexec-mission-launcher.mjs",
    "tools/devexec-mission-constraint-envelope.mjs",
    "tools/devexec-goal.mjs",
    "tools/devexec-local-agent-goal-state.mjs"
)

$testFiles = @(
    "tools/devexec-mission-objective.test.mjs",
    "tools/devexec-mission-amendment-runtime.test.mjs",
    "tools/devexec-mission-loop-boundary.test.mjs",
    "tools/devexec-mission-constraint-continuation.test.mjs",
    "tools/devexec-mission-target-env-clear.test.mjs",
    "tools/devexec-local-agent-mission-boundary.test.mjs",
    "tools/devexec-mission-continuation-dispatch.test.mjs"
)

Write-Host "=== DEV EXEC MISSION CONSTRAINT CONTINUATION CHECK ==="
Write-Host "Repo: $repoRoot"
Write-Host "HEAD: $((& git rev-parse HEAD).Trim())"

foreach ($file in $syntaxFiles) {
    if (-not (Test-Path $file)) {
        throw "Required syntax target missing: $file"
    }
    & $node --check $file
    if ($LASTEXITCODE -ne 0) {
        throw "node --check failed: $file"
    }
}

foreach ($file in $testFiles) {
    if (-not (Test-Path $file)) {
        throw "Required test missing: $file"
    }
}

& $node --test @testFiles
if ($LASTEXITCODE -ne 0) {
    throw "Mission constraint continuation test bundle failed with exit $LASTEXITCODE"
}

Write-Host "MISSION_CONSTRAINT_CONTINUATION_CHECK=PASS"
Write-Host "Host process-kill/restart acceptance is separate and is NOT proven by this script."
