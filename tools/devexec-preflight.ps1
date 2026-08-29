[CmdletBinding()]
param(
    [int]$CdpPort = 9222,
    [int]$LmStudioPort = 1234
)

# Read-only prerequisite report. This script never installs, writes state,
# launches a browser/model, changes power/network settings, or prints secrets.
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Get-CommandReport([string]$Name) {
    $command = Get-Command -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        return [ordered]@{ available = $false; source = $null }
    }
    return [ordered]@{ available = $true; source = [string]$command.Source }
}

function Test-LocalListener([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(250)) { return $false }
        $client.EndConnect($async)
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Get-PathReport([string]$Path) {
    return [ordered]@{ path = $Path; exists = [bool](Test-Path -LiteralPath $Path) }
}

function Get-ConfigReport([string]$Path, [string]$Kind) {
    $report = [ordered]@{ path = $Path; exists = [bool](Test-Path -LiteralPath $Path); valid = $null; entries = @() }
    if (-not $report.exists) { return $report }
    try {
        # PowerShell 5.1 defaults to the active ANSI code page.  Runtime JSON
        # is written as UTF-8 by Node, so make decoding explicit to preserve
        # non-ASCII titles and aliases on Windows PowerShell as well as pwsh.
        $value = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
        $report.valid = $true
        if ($Kind -eq 'mcp' -and $null -ne $value.mcpServers) {
            $report.entries = @($value.mcpServers.psobject.Properties.Name | Sort-Object)
        } elseif ($Kind -eq 'targets' -and $null -ne $value.targets) {
            $report.entries = @($value.targets.psobject.Properties.Name | Sort-Object)
        }
    } catch {
        $report.valid = $false
    }
    return $report
}

$userProfile = [Environment]::GetEnvironmentVariable('USERPROFILE')
$localAppData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA')
if ([string]::IsNullOrWhiteSpace($localAppData) -and -not [string]::IsNullOrWhiteSpace($userProfile)) {
    $localAppData = Join-Path $userProfile 'AppData\Local'
}
if ([string]::IsNullOrWhiteSpace($localAppData)) { $localAppData = '<unresolved-localappdata>' }
$userHome = if (-not [string]::IsNullOrWhiteSpace($userProfile)) { $userProfile } else { [Environment]::GetFolderPath('UserProfile') }
if ([string]::IsNullOrWhiteSpace($userHome)) { $userHome = '<unresolved-home>' }

$stateDir = [Environment]::GetEnvironmentVariable('DEV_EXEC_STATE_DIR')
if ([string]::IsNullOrWhiteSpace($stateDir)) { $stateDir = Join-Path $localAppData 'ChatGPTMCPProbe\dev-exec-state' }
$runsDir = [Environment]::GetEnvironmentVariable('DEV_EXEC_RUNS_DIR')
if ([string]::IsNullOrWhiteSpace($runsDir)) { $runsDir = Join-Path $localAppData 'ChatGPTMCPProbe\dev-exec-runs' }
$userDataDir = [Environment]::GetEnvironmentVariable('CHATGPT_MCP_USER_DATA_DIR')
if ([string]::IsNullOrWhiteSpace($userDataDir)) { $userDataDir = Join-Path $userHome '.chatgpt-mcp\user-data' }
$mcpConfig = Join-Path $userHome '.lmstudio\mcp.json'
$targetRegistry = Join-Path $localAppData 'DevExec\targets.json'
$consultationStateDir = [Environment]::GetEnvironmentVariable('DEV_EXEC_CONSULTATION_STATE_DIR')
if ([string]::IsNullOrWhiteSpace($consultationStateDir)) { $consultationStateDir = Join-Path $localAppData 'ChatGPTMCPProbe\consultation-state' }
$consultationAlias = [Environment]::GetEnvironmentVariable('DEV_EXEC_CHATGPT_CONSULT_TARGET_ALIAS')
$cdpUrlValue = [Environment]::GetEnvironmentVariable('CHATGPT_MCP_CDP_URL')
$cdpUrlConfigured = -not [string]::IsNullOrWhiteSpace($cdpUrlValue)
$cdpUrlValid = $null
if ($cdpUrlConfigured) {
    $cdpMatch = [regex]::Match($cdpUrlValue, '^http://(127\.0\.0\.1|localhost):([0-9]{1,5})$')
    $cdpUrlValid = $cdpMatch.Success -and ([int]$cdpMatch.Groups[2].Value -ge 1) -and ([int]$cdpMatch.Groups[2].Value -le 65535)
}
$consultationTargetContract = [ordered]@{ alias = $consultationAlias; configured = (-not [string]::IsNullOrWhiteSpace($consultationAlias)); present = $false; canonical = $false; conversation_id_match = $false }
if ($consultationTargetContract.configured -and (Test-Path -LiteralPath $targetRegistry)) {
    try {
        $targetValue = Get-Content -LiteralPath $targetRegistry -Raw -Encoding UTF8 | ConvertFrom-Json
        $property = $targetValue.targets.psobject.Properties[$consultationAlias]
        $entry = if ($null -ne $property) { $property.Value } else { $null }
        if ($null -ne $entry) {
            $consultationTargetContract.present = $true
            $url = [string]$entry.chat_url
            $match = [regex]::Match($url, '^https://chatgpt\.com/(?:c/([A-Za-z0-9-]+)|g/[A-Za-z0-9-]+/c/([A-Za-z0-9-]+))$')
            $consultationTargetContract.canonical = $match.Success
            $conversationId = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
            $consultationTargetContract.conversation_id_match = $match.Success -and ([string]$entry.conversation_id -eq $conversationId)
        }
    } catch { }
}

$report = [ordered]@{
    protocol = 'devexec.preflight'
    schema_version = 1
    repository = [ordered]@{
        root = $repoRoot
        package_json = [bool](Test-Path -LiteralPath (Join-Path $repoRoot 'package.json'))
        package_lock = [bool](Test-Path -LiteralPath (Join-Path $repoRoot 'package-lock.json'))
        node_modules = [bool](Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules'))
        dist = [bool](Test-Path -LiteralPath (Join-Path $repoRoot 'dist'))
        cdp_launcher = [bool](Test-Path -LiteralPath (Join-Path $repoRoot 'tools\start-chatgpt-cdp.ps1'))
    }
    prerequisites = [ordered]@{
        node = Get-CommandReport 'node'
        npm = Get-CommandReport 'npm'
        git = Get-CommandReport 'git'
        powershell = Get-CommandReport 'powershell'
        python = Get-CommandReport 'python'
        lms = Get-CommandReport 'lms'
    }
    paths = [ordered]@{
        browser_user_data = Get-PathReport $userDataDir
        target_registry = Get-ConfigReport $targetRegistry 'targets'
        devexec_state = Get-PathReport $stateDir
        devexec_runs = Get-PathReport $runsDir
        consultation_state = Get-PathReport $consultationStateDir
        lmstudio_mcp = Get-ConfigReport $mcpConfig 'mcp'
        local_executor_root = [Environment]::GetEnvironmentVariable('LOCAL_WORKER_EXECUTOR_ROOT')
        cdp_launcher_profile = $userDataDir
    }
    listeners = [ordered]@{
        cdp_127_0_0_1 = [ordered]@{ port = $CdpPort; listening = (Test-LocalListener $CdpPort) }
        lmstudio_127_0_0_1 = [ordered]@{ port = $LmStudioPort; listening = (Test-LocalListener $LmStudioPort) }
    }
    environment = [ordered]@{
        local_worker_allow_write = ([Environment]::GetEnvironmentVariable('LOCAL_WORKER_ALLOW_WRITE') -eq '1')
        local_worker_model_set = -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable('LOCAL_WORKER_MODEL'))
        local_worker_lms_set = -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable('LOCAL_WORKER_LMS'))
        chatgpt_mcp_user_data_dir_override = -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable('CHATGPT_MCP_USER_DATA_DIR'))
        chatgpt_mcp_chrome_path_override = -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable('CHATGPT_MCP_CHROME_PATH'))
        chatgpt_mcp_chat_url_set = -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable('CHATGPT_MCP_CHAT_URL'))
        chatgpt_mcp_cdp_url_set = $cdpUrlConfigured
        chatgpt_mcp_cdp_url_valid = $cdpUrlValid
        chatgpt_mcp_allow_edge = ([Environment]::GetEnvironmentVariable('CHATGPT_MCP_ALLOW_EDGE') -eq '1')
        chatgpt_consultation_enabled = ([Environment]::GetEnvironmentVariable('DEV_EXEC_CHATGPT_CONSULT_ENABLED') -eq '1')
        chatgpt_consultation_target_set = -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable('DEV_EXEC_CHATGPT_CONSULT_TARGET_ALIAS'))
        chatgpt_consultation_target_contract = $consultationTargetContract
    }
    safety = [ordered]@{
        read_only = $true
        credentials_logged = $false
        state_written = $false
        installs_performed = $false
        power_network_browser_changed = $false
    }
}

$report | ConvertTo-Json -Depth 8
