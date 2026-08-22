param(
    [string]$TargetAlias = "current-chat"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path $PSScriptRoot -Parent
Set-Location $RepoRoot

$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if ($IsAdmin) {
    throw "Run this verification from a non-elevated PowerShell session."
}

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw "node.exe is not available."
}
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw "npm.cmd is not available."
}

Write-Host "=== BRIDGE MULTILINE E2E PREFLIGHT ==="
Write-Host "Repo: $RepoRoot"
Write-Host "Target: $TargetAlias"

& npm.cmd run test:bridge
if ($LASTEXITCODE -ne 0) {
    throw "Focused Bridge regression suite failed before the real-path probe."
}

$SdkRoot = Join-Path $RepoRoot "node_modules\@modelcontextprotocol\sdk"
if (-not (Test-Path -LiteralPath $SdkRoot)) {
    throw "MCP SDK dependency is not installed in this checkout. Do not install automatically; prepare the existing runtime first."
}

$RunId = "DEV-EXEC-BRIDGE-MULTILINE-" + (Get-Date -Format "yyyyMMdd-HHmmss")
$Base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME "AppData\Local" }
$RunDir = Join-Path $Base "ChatGPTMCPProbe\dev-exec-runs\$RunId"
$StateFile = Join-Path $Base "ChatGPTMCPProbe\dev-exec-state\$RunId.json"

$env:DEV_EXEC_RUN_ID = $RunId
$env:DEV_EXEC_TARGET_ALIAS = $TargetAlias
$env:DEV_EXEC_MAX_STEPS = "1"
$env:DEV_EXEC_DOCS_ROOT = Split-Path $RepoRoot -Parent
$env:DEV_EXEC_PURPOSE = "Verify that the real ChatGPT Bridge preserves a fenced multiline PowerShell response through Natural Protocol parsing."
$env:DEV_EXEC_TARGET = @"
Perform exactly one harmless multiline transport verification. Your response must begin with RUN and contain exactly one powershell fenced block. Do not add another executable block. Put these three commands on three separate physical lines inside that fence, in this exact order:
Write-Output "BRIDGE_E2E_LINE_1"
Write-Output "BRIDGE_E2E_LINE_2"
Write-Output "BRIDGE_MULTILINE_E2E_OK"
Do not read, write, create, update, or delete any user file. Do not invoke Git. This is only a stdout transport probe.
"@

Write-Host "=== REAL BRIDGE -> NATURAL PROTOCOL -> POWERSHELL ==="
Write-Host "Run: $RunId"

& node.exe ".\tools\dev-exec-loop.mjs"
$RunnerExit = $LASTEXITCODE

$ResultPath = Join-Path $RunDir "step-001.result.json"
$ScriptPath = Join-Path $RunDir "step-001.ps1"

if (-not (Test-Path -LiteralPath $ResultPath)) {
    $StateHint = if (Test-Path -LiteralPath $StateFile) { Get-Content -LiteralPath $StateFile -Raw } else { "<state file missing>" }
    throw "No step result was produced. RunnerExit=$RunnerExit State=$StateHint"
}
if (-not (Test-Path -LiteralPath $ScriptPath)) {
    throw "Step script was not persisted: $ScriptPath"
}

$Result = Get-Content -LiteralPath $ResultPath -Raw | ConvertFrom-Json
$ScriptLines = @(Get-Content -LiteralPath $ScriptPath)
$ExpectedCommands = @(
    'Write-Output "BRIDGE_E2E_LINE_1"',
    'Write-Output "BRIDGE_E2E_LINE_2"',
    'Write-Output "BRIDGE_MULTILINE_E2E_OK"'
)

foreach ($Expected in $ExpectedCommands) {
    if ($ScriptLines -notcontains $Expected) {
        throw "Multiline structure verification failed; missing separate script line: $Expected"
    }
}

$ExpectedStdout = @("BRIDGE_E2E_LINE_1", "BRIDGE_E2E_LINE_2", "BRIDGE_MULTILINE_E2E_OK")
foreach ($Marker in $ExpectedStdout) {
    if ($Result.stdout -notmatch [regex]::Escape($Marker)) {
        throw "Execution output verification failed; missing marker: $Marker"
    }
}

if ($Result.timedOut -or $Result.exitCode -ne 0 -or -not [string]::IsNullOrWhiteSpace($Result.stderr)) {
    throw "PowerShell probe did not complete cleanly. ExitCode=$($Result.exitCode) TimedOut=$($Result.timedOut) Stderr=$($Result.stderr)"
}

Write-Host "BRIDGE_MULTILINE_E2E_PASS"
Write-Host "RunnerExit=$RunnerExit (MAX_STEPS=1 may intentionally leave the bounded test run in MAX_STEPS_REACHED after the verified step.)"
Write-Host "RunDir=$RunDir"
Write-Host "ScriptSHA256=$($Result.scriptSha256)"
Write-Host "StdoutSHA256=$($Result.stdoutSha256)"
