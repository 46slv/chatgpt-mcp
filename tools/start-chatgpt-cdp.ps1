[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$CdpPort = 9222,
    [string]$ChatUrl = '',
    [string]$UserDataDir = '',
    [string]$ChromePath = '',
    [switch]$AllowEdge,
    [switch]$Plan,
    [ValidateRange(1, 120)]
    [int]$StartupTimeoutSeconds = 20
)

# Start a visible, localhost-only Chrome CDP session without changing or
# deleting browser state.  -Plan is a read-only path/argument/preflight mode.
# This script intentionally never stops a browser, edits the registry, or
# writes a profile/configuration file itself.
$ErrorActionPreference = 'Stop'

function Get-UserDataDirectory {
    param([string]$Explicit)
    if (-not [string]::IsNullOrWhiteSpace($Explicit)) { return $Explicit }
    $fromEnvironment = [Environment]::GetEnvironmentVariable('CHATGPT_MCP_USER_DATA_DIR')
    if (-not [string]::IsNullOrWhiteSpace($fromEnvironment)) { return $fromEnvironment }

    $userHome = [Environment]::GetEnvironmentVariable('USERPROFILE')
    if ([string]::IsNullOrWhiteSpace($userHome)) { $userHome = [Environment]::GetEnvironmentVariable('HOME') }
    if ([string]::IsNullOrWhiteSpace($userHome)) { $userHome = [Environment]::GetFolderPath('UserProfile') }
    if ([string]::IsNullOrWhiteSpace($userHome)) { throw 'Unable to resolve a user home directory. Set CHATGPT_MCP_USER_DATA_DIR.' }
    return (Join-Path $userHome '.chatgpt-mcp\user-data')
}

function Add-BrowserCandidate {
    param(
        [System.Collections.ArrayList]$Candidates,
        [string]$Path,
        [string]$Source
    )
    if ([string]::IsNullOrWhiteSpace($Path)) { return }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    foreach ($candidate in $Candidates) {
        if ([string]::Equals($candidate.path, $Path, [StringComparison]::OrdinalIgnoreCase)) { return }
    }
    [void]$Candidates.Add([ordered]@{ path = $Path; source = $Source })
}

function Add-RootCandidate {
    param(
        [System.Collections.ArrayList]$Candidates,
        [string]$Root,
        [string]$Relative,
        [string]$Source
    )
    if ([string]::IsNullOrWhiteSpace($Root)) { return }
    Add-BrowserCandidate $Candidates (Join-Path $Root $Relative) $Source
}

function Get-PlaywrightChromiumPath {
    param([string]$RepositoryRoot)
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
    if ($null -ne $node) {
        $previous = (Get-Location).Path
        try {
            Set-Location -LiteralPath $RepositoryRoot
            $value = (& $node.Source --input-type=module -e "import { chromium } from 'playwright'; process.stdout.write(chromium.executablePath())" 2>$null | Select-Object -Last 1)
            if ($null -ne $value) {
                $value = ([string]$value).Trim()
                if (Test-Path -LiteralPath $value -PathType Leaf) { return $value }
            }
        } catch {
            # The package may not be installed; continue to the filesystem fallback.
        } finally {
            Set-Location -LiteralPath $previous
        }
    }

    $roots = New-Object System.Collections.ArrayList
    [void]$roots.Add((Join-Path $RepositoryRoot 'node_modules\playwright-core\.local-browsers'))
    [void]$roots.Add((Join-Path $RepositoryRoot 'node_modules\playwright\.local-browsers'))
    $localAppData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA')
    if (-not [string]::IsNullOrWhiteSpace($localAppData)) { [void]$roots.Add((Join-Path $localAppData 'ms-playwright')) }
    foreach ($root in $roots) {
        if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -LiteralPath $root)) { continue }
        $found = Get-ChildItem -LiteralPath $root -Filter chrome.exe -File -Recurse -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1
        if ($null -ne $found) { return $found.FullName }
    }
    return $null
}

function Resolve-Browser {
    param(
        [string]$ExplicitPath,
        [bool]$EdgeOptIn,
        [string]$RepositoryRoot
    )
    $candidates = New-Object System.Collections.ArrayList
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (-not (Test-Path -LiteralPath $ExplicitPath -PathType Leaf)) {
            throw "CHATGPT_MCP_CHROME_PATH does not point to an executable file: $ExplicitPath"
        }
        return [ordered]@{ path = (Resolve-Path -LiteralPath $ExplicitPath).Path; source = 'explicit' }
    }

    $programFiles = [Environment]::GetEnvironmentVariable('ProgramFiles')
    $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    $localAppData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA')
    Add-RootCandidate $candidates $programFiles 'Google\Chrome\Application\chrome.exe' 'system'
    Add-RootCandidate $candidates $programFilesX86 'Google\Chrome\Application\chrome.exe' 'system-x86'
    Add-RootCandidate $candidates $localAppData 'Google\Chrome\Application\chrome.exe' 'user-install'

    foreach ($name in @('chrome.exe', 'chrome')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($null -ne $command) {
            $commandPath = if (-not [string]::IsNullOrWhiteSpace([string]$command.Source)) { [string]$command.Source } else { [string]$command.Path }
            Add-BrowserCandidate $candidates $commandPath 'command'
        }
    }
    if ($candidates.Count -gt 0) { return $candidates[0] }

    if ($EdgeOptIn) {
        Add-RootCandidate $candidates $programFiles 'Microsoft\Edge\Application\msedge.exe' 'edge-opt-in'
        Add-RootCandidate $candidates $programFilesX86 'Microsoft\Edge\Application\msedge.exe' 'edge-opt-in-x86'
        Add-RootCandidate $candidates $localAppData 'Microsoft\Edge\Application\msedge.exe' 'edge-opt-in-user'
        foreach ($name in @('msedge.exe', 'msedge')) {
            $command = Get-Command $name -ErrorAction SilentlyContinue
            if ($null -ne $command) {
                $commandPath = if (-not [string]::IsNullOrWhiteSpace([string]$command.Source)) { [string]$command.Source } else { [string]$command.Path }
                Add-BrowserCandidate $candidates $commandPath 'edge-opt-in-command'
            }
        }
        if ($candidates.Count -gt 0) { return $candidates[0] }
    }

    $playwright = Get-PlaywrightChromiumPath $RepositoryRoot
    if (-not [string]::IsNullOrWhiteSpace($playwright)) {
        return [ordered]@{ path = $playwright; source = 'playwright-chromium' }
    }
    throw 'No Chrome executable found. Set CHATGPT_MCP_CHROME_PATH or install Playwright Chromium (npx playwright install chromium).'
}

function Get-CdpProbe {
    param([int]$Port)
    $result = [ordered]@{ tcp_listening = $false; cdp_available = $false; http_status = $null }
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(300)) { return $result }
        $client.EndConnect($async)
        $result.tcp_listening = [bool]$client.Connected
    } catch {
        return $result
    } finally {
        $client.Dispose()
    }
    if (-not $result.tcp_listening) { return $result }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/json/version" -f $Port) -TimeoutSec 1
        $result.http_status = [int]$response.StatusCode
        $result.cdp_available = ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300)
    } catch {
        # A non-CDP process owns the port; callers must not try to reuse it.
    }
    return $result
}

function Normalize-ChatUrl {
    param([string]$Url)
    if ([string]::IsNullOrWhiteSpace($Url)) { return $null }
    try {
        $uri = New-Object System.Uri($Url)
        if ($uri.Scheme -ne 'https' -or @('chatgpt.com', 'chat.openai.com') -notcontains $uri.Host.ToLowerInvariant()) {
            throw 'ChatUrl must be an https://chatgpt.com or https://chat.openai.com URL.'
        }
        return $uri.AbsoluteUri
    } catch {
        throw "Invalid ChatUrl: $Url"
    }
}

function New-CdpArgumentList {
    param(
        [int]$Port,
        [string]$Profile,
        [string]$Url
    )
    $arguments = New-Object System.Collections.ArrayList
    [void]$arguments.Add("--remote-debugging-address=127.0.0.1")
    [void]$arguments.Add("--remote-debugging-port=$Port")
    [void]$arguments.Add("--user-data-dir=$Profile")
    # Keep the browser visible so the user can log in; do not pass headless.
    if (-not [string]::IsNullOrWhiteSpace($Url)) { [void]$arguments.Add($Url) }
    return @($arguments)
}

function Write-ResultAndExit {
    param([System.Collections.IDictionary]$Result, [int]$ExitCode = 0)
    $Result.protocol = 'devexec.cdp-launcher'
    $Result.schema_version = 1
    $Result | ConvertTo-Json -Depth 8
    exit $ExitCode
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$explicitBrowser = $ChromePath
if ([string]::IsNullOrWhiteSpace($explicitBrowser)) { $explicitBrowser = [Environment]::GetEnvironmentVariable('CHATGPT_MCP_CHROME_PATH') }
$allowEdgeEffective = $AllowEdge.IsPresent -or ([Environment]::GetEnvironmentVariable('CHATGPT_MCP_ALLOW_EDGE') -eq '1')
$profile = Get-UserDataDirectory $UserDataDir
$url = Normalize-ChatUrl $ChatUrl
if ([string]::IsNullOrWhiteSpace($url)) { $url = Normalize-ChatUrl ([Environment]::GetEnvironmentVariable('CHATGPT_MCP_CHAT_URL')) }

$probe = Get-CdpProbe $CdpPort
$result = [ordered]@{
    cdp = [ordered]@{ host = '127.0.0.1'; port = $CdpPort; probe = $probe }
    user_data_dir = $profile
    chat_url = $url
    edge_opt_in = $allowEdgeEffective
    selected_browser = $null
    arguments = @()
    action = $null
    process_id = $null
    process_running = $null
    exit_code = $null
    error = $null
}

if ($probe.cdp_available) {
    $result.action = 'reuse_existing'
    Write-ResultAndExit $result 0
}
if ($probe.tcp_listening) {
    $result.action = 'blocked_port_in_use'
    $result.error = "127.0.0.1:$CdpPort is already in use by a non-CDP listener. No browser was started."
    Write-ResultAndExit $result 2
}

try {
    $browser = Resolve-Browser $explicitBrowser $allowEdgeEffective $repositoryRoot
    $result.selected_browser = $browser
    $result.arguments = New-CdpArgumentList $CdpPort $profile $url
} catch {
    $result.action = 'browser_not_found'
    $result.error = $_.Exception.Message
    Write-ResultAndExit $result 2
}

if ($Plan) {
    $result.action = 'would_launch'
    Write-ResultAndExit $result 0
}

try {
    # Start-Process is deliberately visible/normal: first-run login requires a
    # user-visible window. ArgumentList is an array, avoiding shell expansion.
    $process = Start-Process -FilePath $browser.path -ArgumentList $result.arguments -WorkingDirectory $repositoryRoot -WindowStyle Normal -PassThru
    $result.process_id = $process.Id
    $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $process.Refresh()
        if ($process.HasExited) {
            $result.action = 'early_exit'
            $result.process_running = $false
            $result.exit_code = $process.ExitCode
            $result.error = "Browser exited before CDP became ready (exit code $($process.ExitCode))."
            Write-ResultAndExit $result 3
        }
        $current = Get-CdpProbe $CdpPort
        $result.cdp.probe = $current
        if ($current.cdp_available) {
            $result.action = 'started'
            $result.process_running = $true
            Write-ResultAndExit $result 0
        }
        Start-Sleep -Milliseconds 250
    }
    $process.Refresh()
    $result.action = 'startup_timeout'
    $result.process_running = -not $process.HasExited
    if ($process.HasExited) { $result.exit_code = $process.ExitCode }
    $result.error = "CDP did not become ready within $StartupTimeoutSeconds seconds. Browser was not terminated."
    Write-ResultAndExit $result 4
} catch {
    $result.action = 'launch_failed'
    $result.error = $_.Exception.Message
    Write-ResultAndExit $result 3
}
