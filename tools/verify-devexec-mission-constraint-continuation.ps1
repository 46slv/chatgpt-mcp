$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$node = (Get-Command node -ErrorAction Stop).Source

$syntaxFiles = @(
    "tools/devexec-durable-write.mjs",
    "tools/devexec-mission-objective.mjs",
    "tools/devexec-mission-amendment-runtime.mjs",
    "tools/devexec-mission-loop-boundary.mjs",
    "tools/devexec-mission-lock.mjs",
    "tools/devexec-mission-lock-resume.mjs",
    "tools/devexec-mission-control.mjs",
    "tools/devexec-mission-launch.mjs",
    "tools/devexec-mission-launcher.mjs",
    "tools/devexec-mission-run-admission.mjs",
    "tools/devexec-mission-entry-runtime.mjs",
    "tools/devexec-mission-constraint-envelope.mjs",
    "tools/devexec-target-alias.mjs",
    "tools/devexec-goal.mjs",
    "tools/devexec-local-agent-goal-state.mjs",
    "tools/devexec-mission-recovery-interlock-probe.mjs",
    "tools/devexec-mission-recovery-entry-interlock-probe.mjs",
    "tools/devexec-mission-host-preflight.mjs",
    "tools/devexec-mission-host-lock-acceptance.mjs",
    "tools/devexec-mission-host-evidence-verify.mjs"
)

$testFiles = @(
    "tools/devexec-durable-write.test.mjs",
    "tools/devexec-mission-objective.test.mjs",
    "tools/devexec-mission-amendment-runtime.test.mjs",
    "tools/devexec-mission-loop-boundary.test.mjs",
    "tools/devexec-mission-constraint-continuation.test.mjs",
    "tools/devexec-mission-lock.test.mjs",
    "tools/devexec-mission-lock-lifetime.test.mjs",
    "tools/devexec-mission-lock-process.test.mjs",
    "tools/devexec-mission-process-hard-termination.test.mjs",
    "tools/devexec-mission-lock-recovery.test.mjs",
    "tools/devexec-mission-lock-resume.test.mjs",
    "tools/devexec-mission-recovery-api-boundary.test.mjs",
    "tools/devexec-mission-recovery-claim-entry.test.mjs",
    "tools/devexec-mission-lock-publication.test.mjs",
    "tools/devexec-mission-control.test.mjs",
    "tools/devexec-mission-launch-review.test.mjs",
    "tools/devexec-mission-process-crash.test.mjs",
    "tools/devexec-mission-run-admission.test.mjs",
    "tools/devexec-mission-entry-runtime.test.mjs",
    "tools/devexec-mission-entry-launch-handshake.test.mjs",
    "tools/devexec-mission-root-start-review.test.mjs",
    "tools/devexec-mission-runtime-wiring.test.mjs",
    "tools/devexec-mission-target-env-clear.test.mjs",
    "tools/devexec-mission-target-validation.test.mjs",
    "tools/devexec-target-alias.test.mjs",
    "tools/devexec-local-agent-mission-boundary.test.mjs",
    "tools/devexec-mission-continuation-dispatch.test.mjs",
    "tools/devexec-mission-host-preflight.test.mjs",
    "tools/devexec-mission-host-evidence-verify.test.mjs",
    "tools/devexec-mission-host-wrapper-contract.test.mjs",
    "tools/devexec-mission-host-utf8-contract.test.mjs"
)

$regressionProbes = @(
    "tools/devexec-mission-recovery-interlock-probe.mjs",
    "tools/devexec-mission-recovery-entry-interlock-probe.mjs"
)

$realProcessProbe = "tools/devexec-mission-launch-real-e2e.mjs"

Write-Host "=== DEV EXEC MISSION RELIABILITY CHECK ==="
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
    throw "Mission reliability test bundle failed with exit $LASTEXITCODE"
}

foreach ($probe in $regressionProbes) {
    & $node $probe
    if ($LASTEXITCODE -ne 0) {
        throw "Mission reliability regression probe failed: $probe exit $LASTEXITCODE"
    }
}

if (-not (Test-Path $realProcessProbe)) {
    throw "Required real-process probe missing: $realProcessProbe"
}

# This probe launches only the current Node executable with a temporary child
# script under the OS temp directory. It does not call Local Executor, Resolve,
# the network, or an external command. Its purpose is to prove the real
# spawn -> durable receipt -> child lineage reconciliation path on this host.
& $node $realProcessProbe
if ($LASTEXITCODE -ne 0) {
    throw "Mission real-process launch probe failed with exit $LASTEXITCODE"
}

Write-Host "MISSION_RELIABILITY_CHECK=PASS"
Write-Host "Real Node child spawn/receipt/reconciliation probe=PASS"
Write-Host "Cross-process Mission lock exclusion plus atomic stale-recovery claim/concurrent-recoverer regression=PASS"
Write-Host "Synchronous Mission lock callback contract prevents declared async execution and keeps unexpected thenables locked until settlement=PASS"
Write-Host "Interrupted neutral or PID-bearing stale-recovery claim resumes through movable-owner file identity proof=PASS"
Write-Host "Recovery owner+neutral mixed state preserves canonical lock and blocks Mission entry before Local Agent side effects=PASS"
Write-Host "Independent legacy stale-lock mutator is retired; static API-boundary test prevents production runtime reuse=PASS"
Write-Host "Copied/mismatched recovery evidence cannot authorize canonical unlink=PASS"
Write-Host "Atomic Mission lock publication crash windows=PASS"
Write-Host "Cross-process exit/restart LAUNCHING replay guard, including actual dispatcher spawn-before-receipt crash=PASS"
Write-Host "External hard termination after durable LAUNCHING and real child spawn before receipt does not replay the child=PASS"
Write-Host "Host evidence preflight rejects dirty or wrong-HEAD checkout state=PASS"
Write-Host "Persisted host evidence verifier rejects hash/marker/root/commit drift and writes an immutable verification receipt=PASS"
Write-Host "Host wrapper static contract preserves pinned-HEAD, pre/postflight, unique evidence, component PASS-marker, BOM-free UTF-8 evidence, and post-write readback requirements=PASS"
Write-Host "Local Agent/Local Executor integration, power-loss durability, and pinned SHIRO-WS clean-checkout host acceptance remain separate and are NOT proven by this script."
Write-Host "Mission JSON state writers fsync temporary file bytes before atomic rename=PASS"
Write-Host "Forced external termination after durable LAUNCHING and real child spawn before receipt=PASS"
Write-Host "Directory metadata durability remains host-dependent: SHIRO-WS Node directory fsync returns EPERM, so full power-loss durability remains OPEN."
Write-Host "Local Agent/Local Executor live read-only E2E is separate host evidence and has passed on SHIRO-WS; pinned clean-checkout host acceptance remains separate."
