param(
    [string]$SourceRoot = "",

    [string]$AuthorityHead = "",

    [string]$RuntimeBase = "",

    [string]$InstallRoot = "",

    [string]$ShortcutRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
    $SourceRoot = Split-Path -Parent $PSScriptRoot
}

$SourceRoot =
    [System.IO.Path]::GetFullPath(
        $SourceRoot
    )

if ([string]::IsNullOrWhiteSpace($AuthorityHead)) {
    throw "AuthorityHead is required."
}

if (
    $AuthorityHead -notmatch
    '^[0-9a-fA-F]{40}$'
) {
    throw "AuthorityHead must be a 40-character Git commit SHA."
}

if ([string]::IsNullOrWhiteSpace($RuntimeBase)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw "LOCALAPPDATA is required when RuntimeBase is omitted."
    }

    $RuntimeBase =
        Join-Path `
            $env:LOCALAPPDATA `
            "ChatGPTMCPProbe\control-runtime"
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw "LOCALAPPDATA is required when InstallRoot is omitted."
    }

    $InstallRoot =
        Join-Path `
            $env:LOCALAPPDATA `
            "ChatGPTMCPProbe\control-launcher"
}

if ([string]::IsNullOrWhiteSpace($ShortcutRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
        throw "APPDATA is required when ShortcutRoot is omitted."
    }

    $ShortcutRoot =
        Join-Path `
            $env:APPDATA `
            "Microsoft\Windows\Start Menu\Programs"
}

$RuntimeBase =
    [System.IO.Path]::GetFullPath(
        $RuntimeBase
    )

$InstallRoot =
    [System.IO.Path]::GetFullPath(
        $InstallRoot
    )

$ShortcutRoot =
    [System.IO.Path]::GetFullPath(
        $ShortcutRoot
    )

$RuntimeRoot =
    Join-Path `
        $RuntimeBase `
        $AuthorityHead.ToLowerInvariant()

$SourceTools =
    Join-Path `
        $SourceRoot `
        "tools"

$RuntimeTools =
    Join-Path `
        $RuntimeRoot `
        "tools"

if (-not (Test-Path -LiteralPath $SourceTools -PathType Container)) {
    throw "Source tools directory missing: $SourceTools"
}

New-Item `
    -ItemType Directory `
    -Path $RuntimeTools `
    -Force |
    Out-Null

$SourceFiles =
    Get-ChildItem `
        -LiteralPath $SourceTools `
        -File `
        -Recurse

if ($SourceFiles.Count -eq 0) {
    throw "No runtime source files found."
}

foreach ($source in $SourceFiles) {
    $relative =
        $source.FullName.Substring(
            $SourceTools.Length
        ).TrimStart(
            [char]'\',
            [char]'/'
        )

    $target =
        Join-Path `
            $RuntimeTools `
            $relative

    $targetParent =
        Split-Path `
            -Parent `
            $target

    New-Item `
        -ItemType Directory `
        -Path $targetParent `
        -Force |
        Out-Null

    Copy-Item `
        -LiteralPath $source.FullName `
        -Destination $target `
        -Force
}

foreach ($optional in @(
    "package.json",
    "package-lock.json"
)) {
    $source =
        Join-Path `
            $SourceRoot `
            $optional

    if (Test-Path -LiteralPath $source -PathType Leaf) {
        Copy-Item `
            -LiteralPath $source `
            -Destination (Join-Path $RuntimeRoot $optional) `
            -Force
    }
}

$RuntimeDevExec =
    Join-Path `
        $RuntimeRoot `
        "tools\devexec.mjs"

$RuntimeInstaller =
    Join-Path `
        $RuntimeRoot `
        "tools\install-devexec-control.ps1"

$RuntimeChecker =
    Join-Path `
        $RuntimeRoot `
        "tools\devexec-control-install-check.mjs"

foreach ($required in @(
    $RuntimeDevExec,
    $RuntimeInstaller,
    $RuntimeChecker,
    (Join-Path $RuntimeRoot "tools\devexec-control.mjs"),
    (Join-Path $RuntimeRoot "tools\devexec-control-server.mjs"),
    (Join-Path $RuntimeRoot "tools\devexec-control-ui.html"),
    (Join-Path $RuntimeRoot "tools\devexec-control-ui.js")
)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Runtime package incomplete: $required"
    }
}

powershell.exe `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File $RuntimeInstaller `
    -Mode Install `
    -RepoRoot $RuntimeRoot `
    -InstallRoot $InstallRoot `
    -ShortcutRoot $ShortcutRoot

if ($LASTEXITCODE -ne 0) {
    throw "Stable runtime launcher installation failed."
}

$ManifestFile =
    Join-Path `
        $InstallRoot `
        "install.json"

$manifest =
    Get-Content `
        -LiteralPath $ManifestFile `
        -Raw `
        -Encoding UTF8 |
    ConvertFrom-Json

$manifest |
    Add-Member `
        -NotePropertyName "install_mode" `
        -NotePropertyValue "stable-user-runtime" `
        -Force

$manifest |
    Add-Member `
        -NotePropertyName "packaged_authority_head" `
        -NotePropertyValue $AuthorityHead.ToLowerInvariant() `
        -Force

$manifest |
    Add-Member `
        -NotePropertyName "source_repo_root" `
        -NotePropertyValue $SourceRoot `
        -Force

$manifest |
    Add-Member `
        -NotePropertyName "runtime_root" `
        -NotePropertyValue $RuntimeRoot `
        -Force

$manifest |
    ConvertTo-Json -Depth 8 |
    ForEach-Object {
        [System.IO.File]::WriteAllText(
            $ManifestFile,
            $_ + "`n",
            $Utf8NoBom
        )
    }

$RuntimeManifest =
    [ordered]@{
        protocol = "devexec.control.runtime-package"
        schema_version = 1
        authority_head = $AuthorityHead.ToLowerInvariant()
        packaged_at = (Get-Date).ToString("o")
        source_repo_root = $SourceRoot
        runtime_root = $RuntimeRoot
        install_root = $InstallRoot
        runtime_devexec = $RuntimeDevExec
    }

$RuntimeManifestFile =
    Join-Path `
        $RuntimeRoot `
        "runtime-package.json"

[System.IO.File]::WriteAllText(
    $RuntimeManifestFile,
    (
        $RuntimeManifest |
        ConvertTo-Json -Depth 6
    ) + "`n",
    $Utf8NoBom
)

Write-Host "DEVEXEC_STABLE_RUNTIME_INSTALL=PASS"
Write-Host "AUTHORITY_HEAD=$AuthorityHead"
Write-Host "SOURCE_ROOT=$SourceRoot"
Write-Host "RUNTIME_ROOT=$RuntimeRoot"
Write-Host "INSTALL_ROOT=$InstallRoot"
Write-Host "SHORTCUT_ROOT=$ShortcutRoot"