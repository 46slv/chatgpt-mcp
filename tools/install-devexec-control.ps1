param(
    [ValidateSet("Install","Status")]
    [string]$Mode = "Install",

    [string]$RepoRoot = "",

    [string]$InstallRoot = "",

    [string]$ShortcutRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}

$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)

$DevExec = Join-Path $RepoRoot "tools\devexec.mjs"

if (-not (Test-Path -LiteralPath $DevExec -PathType Leaf)) {
    throw "Dev Exec entrypoint missing: $DevExec"
}

$Node = (Get-Command node -ErrorAction Stop).Source

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw "LOCALAPPDATA is required when InstallRoot is omitted."
    }

    $InstallRoot = Join-Path `
        $env:LOCALAPPDATA `
        "ChatGPTMCPProbe\control-launcher"
}

if ([string]::IsNullOrWhiteSpace($ShortcutRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
        throw "APPDATA is required when ShortcutRoot is omitted."
    }

    $ShortcutRoot = Join-Path `
        $env:APPDATA `
        "Microsoft\Windows\Start Menu\Programs"
}

$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$ShortcutRoot = [System.IO.Path]::GetFullPath($ShortcutRoot)

$StartLauncher = Join-Path $InstallRoot "DevExec Control.cmd"
$StatusLauncher = Join-Path $InstallRoot "DevExec Control Status.cmd"
$StopLauncher = Join-Path $InstallRoot "DevExec Control Stop.cmd"
$Manifest = Join-Path $InstallRoot "install.json"
$Shortcut = Join-Path $ShortcutRoot "Dev Exec Control.lnk"

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Path,

        [Parameter(Mandatory=$true)]
        [AllowEmptyString()]
        [string]$Text
    )

    [System.IO.File]::WriteAllText(
        $Path,
        $Text,
        $Utf8NoBom
    )
}

function Assert-Installed {
    foreach ($file in @(
        $StartLauncher,
        $StatusLauncher,
        $StopLauncher,
        $Manifest,
        $Shortcut
    )) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "Dev Exec Control installation incomplete: $file"
        }
    }

    $saved = Get-Content `
        -LiteralPath $Manifest `
        -Raw `
        -Encoding UTF8 |
        ConvertFrom-Json

    if (
        [System.IO.Path]::GetFullPath($saved.repo_root) -ne
        $RepoRoot
    ) {
        throw "Installed repo_root differs from requested RepoRoot."
    }

    if (
        [System.IO.Path]::GetFullPath($saved.node_path) -ne
        [System.IO.Path]::GetFullPath($Node)
    ) {
        throw "Installed node_path differs from active Node."
    }

    Write-Host "DEVEXEC_CONTROL_INSTALL_STATUS=PASS"
    Write-Host "INSTALL_ROOT=$InstallRoot"
    Write-Host "SHORTCUT=$Shortcut"
    Write-Host "REPO_ROOT=$RepoRoot"
    Write-Host "NODE=$Node"
}

if ($Mode -eq "Status") {
    Assert-Installed
    exit 0
}

New-Item `
    -ItemType Directory `
    -Path $InstallRoot `
    -Force |
    Out-Null

New-Item `
    -ItemType Directory `
    -Path $ShortcutRoot `
    -Force |
    Out-Null

$StartText = @"
@echo off
"$Node" "$DevExec" control start --open
if errorlevel 1 pause
"@

$StatusText = @"
@echo off
"$Node" "$DevExec" control status
if errorlevel 1 pause
"@

$StopText = @"
@echo off
"$Node" "$DevExec" control stop
if errorlevel 1 pause
"@

Write-Utf8NoBom `
    -Path $StartLauncher `
    -Text ($StartText.Trim() + "`r`n")

Write-Utf8NoBom `
    -Path $StatusLauncher `
    -Text ($StatusText.Trim() + "`r`n")

Write-Utf8NoBom `
    -Path $StopLauncher `
    -Text ($StopText.Trim() + "`r`n")

$InstallState = [ordered]@{
    protocol = "devexec.control.install"
    schema_version = 1
    installed_at = (Get-Date).ToString("o")
    repo_root = $RepoRoot
    node_path = $Node
    install_root = $InstallRoot
    shortcut = $Shortcut
    commands = [ordered]@{
        start_open = $StartLauncher
        status = $StatusLauncher
        stop = $StopLauncher
    }
}

$InstallJson = $InstallState |
    ConvertTo-Json -Depth 6

Write-Utf8NoBom `
    -Path $Manifest `
    -Text ($InstallJson + "`n")

$Shell = New-Object -ComObject WScript.Shell
$Link = $Shell.CreateShortcut($Shortcut)

$Link.TargetPath = $StartLauncher
$Link.WorkingDirectory = $RepoRoot
$Link.Description = "Start Dev Exec Control and open the local GUI"
$Link.WindowStyle = 1
$Link.Save()

Assert-Installed

Write-Host "DEVEXEC_CONTROL_INSTALL=PASS"
Write-Host "DEVEXEC_CONTROL_UPDATE=PASS"
