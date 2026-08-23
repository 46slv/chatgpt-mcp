param(
    [ValidateSet("Install","Status","Disable")]
    [string]$Mode = "Install",

    [string]$InstallRoot = "",

    [string]$StartupRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Utf8NoBom =
    New-Object System.Text.UTF8Encoding($false)

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw "LOCALAPPDATA is required when InstallRoot is omitted."
    }

    $InstallRoot =
        Join-Path `
            $env:LOCALAPPDATA `
            "ChatGPTMCPProbe\control-launcher"
}

if ([string]::IsNullOrWhiteSpace($StartupRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
        throw "APPDATA is required when StartupRoot is omitted."
    }

    $StartupRoot =
        Join-Path `
            $env:APPDATA `
            "Microsoft\Windows\Start Menu\Programs\Startup"
}

$InstallRoot =
    [System.IO.Path]::GetFullPath($InstallRoot)

$StartupRoot =
    [System.IO.Path]::GetFullPath($StartupRoot)

$ManifestFile =
    Join-Path $InstallRoot "install.json"

$Launcher =
    Join-Path $InstallRoot "DevExec Control Autostart.cmd"

$Shortcut =
    Join-Path $StartupRoot "Dev Exec Control Autostart.lnk"

function Read-InstallManifest {
    if (-not (Test-Path -LiteralPath $ManifestFile -PathType Leaf)) {
        throw "Dev Exec Control installation manifest missing."
    }

    $value =
        Get-Content `
            -LiteralPath $ManifestFile `
            -Raw `
            -Encoding UTF8 |
        ConvertFrom-Json

    if ($value.protocol -ne "devexec.control.install") {
        throw "Install protocol mismatch."
    }

    if ($value.install_mode -ne "stable-user-runtime") {
        throw "Autostart requires stable-user-runtime."
    }

    if (
        -not (
            Test-Path `
                -LiteralPath ([string]$value.repo_root) `
                -PathType Container
        )
    ) {
        throw "Stable runtime root unavailable."
    }

    if (
        -not (
            Test-Path `
                -LiteralPath ([string]$value.node_path) `
                -PathType Leaf
        )
    ) {
        throw "Installed Node executable unavailable."
    }

    return $value
}

function Read-ShortcutTarget {
    if (-not (Test-Path -LiteralPath $Shortcut -PathType Leaf)) {
        return $null
    }

    $shell =
        New-Object -ComObject WScript.Shell

    $link =
        $shell.CreateShortcut($Shortcut)

    return [string]$link.TargetPath
}

function Emit-Status {
    $manifest =
        Read-InstallManifest

    $launcherExists =
        Test-Path `
            -LiteralPath $Launcher `
            -PathType Leaf

    $shortcutExists =
        Test-Path `
            -LiteralPath $Shortcut `
            -PathType Leaf

    $shortcutTarget =
        Read-ShortcutTarget

    $launcherText =
        if ($launcherExists) {
            Get-Content `
                -LiteralPath $Launcher `
                -Raw `
                -Encoding UTF8
        }
        else {
            ""
        }

    $headless =
        $launcherExists -and
        $launcherText.Contains("control start") -and
        -not $launcherText.Contains("--open")

    $shortcutBound =
        $shortcutExists -and
        -not [string]::IsNullOrWhiteSpace($shortcutTarget) -and
        (
            [System.IO.Path]::GetFullPath($shortcutTarget) -eq
            [System.IO.Path]::GetFullPath($Launcher)
        )

    $enabled =
        $launcherExists -and
        $headless -and
        $shortcutBound

    [ordered]@{
        protocol = "devexec.control.autostart"
        schema_version = 1
        status =
            if ($enabled) {
                "ENABLED"
            }
            else {
                "DISABLED"
            }
        enabled = $enabled
        trigger = "windows-user-startup-folder"
        stable_runtime_root = [string]$manifest.repo_root
        packaged_authority_head = [string]$manifest.packaged_authority_head
        launcher = $Launcher
        launcher_exists = $launcherExists
        launcher_headless = $headless
        shortcut = $Shortcut
        shortcut_exists = $shortcutExists
        shortcut_target = $shortcutTarget
        shortcut_bound = $shortcutBound
    } |
        ConvertTo-Json -Compress
}

if ($Mode -eq "Status") {
    Emit-Status
    exit 0
}

if ($Mode -eq "Disable") {
    if (Test-Path -LiteralPath $Shortcut -PathType Leaf) {
        [System.IO.File]::Delete($Shortcut)
    }

    $manifest =
        Read-InstallManifest

    $manifest |
        Add-Member `
            -NotePropertyName "autostart" `
            -NotePropertyValue ([pscustomobject]@{
                enabled = $false
                trigger = "windows-user-startup-folder"
                launcher = $Launcher
                shortcut = $Shortcut
            }) `
            -Force

    [System.IO.File]::WriteAllText(
        $ManifestFile,
        (
            $manifest |
            ConvertTo-Json -Depth 10
        ) + "`n",
        $Utf8NoBom
    )

    Emit-Status
    exit 0
}

$manifest =
    Read-InstallManifest

$RuntimeRoot =
    [System.IO.Path]::GetFullPath(
        [string]$manifest.repo_root
    )

$Node =
    [System.IO.Path]::GetFullPath(
        [string]$manifest.node_path
    )

$DevExec =
    Join-Path `
        $RuntimeRoot `
        "tools\devexec.mjs"

if (-not (Test-Path -LiteralPath $DevExec -PathType Leaf)) {
    throw "Stable runtime Dev Exec entrypoint missing."
}

New-Item `
    -ItemType Directory `
    -Path $InstallRoot `
    -Force |
    Out-Null

New-Item `
    -ItemType Directory `
    -Path $StartupRoot `
    -Force |
    Out-Null

$LauncherText = @"
@echo off
"$Node" "$DevExec" control start
"@

[System.IO.File]::WriteAllText(
    $Launcher,
    $LauncherText.Trim() + "`r`n",
    $Utf8NoBom
)

$shell =
    New-Object -ComObject WScript.Shell

$link =
    $shell.CreateShortcut($Shortcut)

$link.TargetPath = $Launcher
$link.WorkingDirectory = $RuntimeRoot
$link.Description = "Start Dev Exec Control automatically at Windows user logon"
$link.WindowStyle = 7
$link.Save()

$manifest |
    Add-Member `
        -NotePropertyName "autostart" `
        -NotePropertyValue ([pscustomobject]@{
            enabled = $true
            trigger = "windows-user-startup-folder"
            launcher = $Launcher
            shortcut = $Shortcut
            runtime_root = $RuntimeRoot
            packaged_authority_head = [string]$manifest.packaged_authority_head
        }) `
        -Force

[System.IO.File]::WriteAllText(
    $ManifestFile,
    (
        $manifest |
        ConvertTo-Json -Depth 10
    ) + "`n",
    $Utf8NoBom
)

Emit-Status