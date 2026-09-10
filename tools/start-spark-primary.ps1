[CmdletBinding()]
param(
    [ValidateSet('Plan', 'Ensure', 'Status', 'Stop')]
    [string]$Mode = 'Plan',
    [string]$ModelPath = $env:LLAMACPP_MODEL_PATH,
    [string]$Model = $env:LLAMACPP_MODEL,
    [string]$LlamaCommand = $env:LLAMACPP_COMMAND,
    [string]$ServeUrl = $env:LLAMACPP_SERVE_URL,
    [int]$Context = 32768,
    [string]$DeviceName = $env:LLAMACPP_DEVICE_NAME,
    [string]$StateRoot = $env:LLAMACPP_STATE_ROOT
)

# SHIRO-WS standard lane launcher.  This is an ensure/observe helper for the
# existing DevExec control plane; it is not a second relay or scheduler.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Model)) { $Model = 'Spark-X2.5-4B-Q6_K.gguf' }
if ([string]::IsNullOrWhiteSpace($ServeUrl)) { $ServeUrl = 'http://127.0.0.1:18080' }
if ([string]::IsNullOrWhiteSpace($DeviceName)) { $DeviceName = 'NVIDIA GeForce RTX 3070 Ti' }
if ([string]::IsNullOrWhiteSpace($StateRoot)) {
    $StateRoot = Join-Path ($env:LOCALAPPDATA | ForEach-Object { if ($_){$_}else{Join-Path $env:USERPROFILE 'AppData\Local'} }) 'ChatGPTMCPProbe\spark-primary'
}

function Fail([string]$Code, [string]$Reason) {
    [ordered]@{ protocol = 'devexec.spark-primary.launcher'; schema_version = 1; status = 'BLOCKED'; code = $Code; reason = $Reason; mode = $Mode } | ConvertTo-Json -Depth 8
    exit 2
}

if (-not $PSBoundParameters.ContainsKey('Context') -and -not [string]::IsNullOrWhiteSpace($env:LLAMACPP_CONTEXT)) {
    $contextFromEnv = 0
    if (-not [int]::TryParse($env:LLAMACPP_CONTEXT, [ref]$contextFromEnv)) {
        Fail 'CONTEXT_INVALID' 'LLAMACPP_CONTEXT must be an integer when supplied.'
    }
    $Context = $contextFromEnv
}

try {
    $uri = [Uri]$ServeUrl
    if ($uri.Scheme -ne 'http' -or @('127.0.0.1', 'localhost', '::1') -notcontains $uri.Host -or $uri.Port -le 0) {
        Fail 'LOOPBACK_REQUIRED' 'ServeUrl must be an explicit loopback HTTP endpoint.'
    }
} catch {
    Fail 'LOOPBACK_REQUIRED' 'ServeUrl is not a valid loopback HTTP endpoint.'
}
$BaseUrl = $ServeUrl.TrimEnd('/')
$Port = $uri.Port

function Test-RegularFile([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    try {
        $item = Get-Item -LiteralPath $Path -ErrorAction Stop
        return $item -is [System.IO.FileInfo]
    } catch { return $false }
}

function Test-AbsoluteWindowsPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    return $Path -match '^[A-Za-z]:[\\/]' -or $Path -match '^\\\\'
}

function Same-Name([string]$Left, [string]$Right) {
    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
    $a = $Left.Trim().ToLowerInvariant()
    $b = $Right.Trim().ToLowerInvariant()
    return $a -eq $b -or $a.Contains($b) -or $b.Contains($a)
}

function Get-NvidiaGpus {
    if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) { return @() }
    $rows = & nvidia-smi --query-gpu=index,name,uuid,memory.total,memory.used,memory.free --format=csv,noheader,nounits 2>$null
    if ($LASTEXITCODE -ne 0) { return @() }
    $result = @()
    foreach ($row in @($rows)) {
        $parts = [string]$row -split ','
        if ($parts.Count -lt 6) { continue }
        try {
            $result += [pscustomobject]@{
                index = [int]$parts[0].Trim()
                name = $parts[1].Trim()
                uuid = $parts[2].Trim()
                total_mib = [int](($parts[3] -replace '[^0-9]', ''))
                used_mib = [int](($parts[4] -replace '[^0-9]', ''))
                free_mib = [int](($parts[5] -replace '[^0-9]', ''))
            }
        } catch { }
    }
    return $result
}

function Get-LlamaDevices([string]$Exe) {
    if (-not (Test-RegularFile $Exe)) { return @() }
    $name = [IO.Path]::GetFileName($Exe).ToLowerInvariant()
    $args = if ($name -eq 'llama-server.exe' -or $name -eq 'llama-server') { @('--list-devices') } else { @('serve', '--list-devices') }
    $text = (& $Exe @args 2>&1 | Out-String)
    $records = @()
    foreach ($line in ($text -split "`r?`n")) {
        $match = [regex]::Match($line, '^\s*(?<id>\S+):\s+(?<name>.+?)\s+\((?<details>.+)\)\s*$')
        if ($match.Success) {
            $idText = $match.Groups['id'].Value
            $index = $null
            $indexMatch = [regex]::Match($idText, '(\d+)$')
            if ($indexMatch.Success) { $index = [int]$indexMatch.Groups[1].Value }
            $records += [pscustomobject]@{ id = $idText; name = $match.Groups['name'].Value.Trim(); details = $match.Groups['details'].Value.Trim(); runtime_index = $index }
        }
    }
    return $records
}

function Get-LlamaProcesses {
    try {
        $all = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -in @('llama.exe', 'llama-server.exe') }
        return @($all | Where-Object { [string]$_.CommandLine -match [regex]::Escape($Model) -and [string]$_.CommandLine -match "(?:--port\s+)$Port(?:\s|$)" })
    } catch { return @() }
}

function Test-LocalListener([int]$ListenPort) {
    try {
        return @(Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction Stop).Count -gt 0
    } catch {
        try {
            return @(netstat -ano -p tcp 2>$null | Select-String (":$ListenPort\s+.*LISTENING" )).Count -gt 0
        } catch { return $false }
    }
}

function Get-ModelReadback {
    try {
        $body = Invoke-RestMethod -Uri "$BaseUrl/v1/models" -Method Get -TimeoutSec 3
        $entries = @($body.data)
        $ids = @($entries | ForEach-Object {
            $value = $_.id
            if ([string]::IsNullOrWhiteSpace([string]$value)) { $value = $_.model }
            if ([string]::IsNullOrWhiteSpace([string]$value)) { $value = $_.name }
            [string]$value
        } | Where-Object { $_ })
        $matching = @($ids | Where-Object { Same-Name $_ $Model })
        if ($matching.Count -gt 0) { return [pscustomobject]@{ status = 'READY'; ids = $ids; model_id = $matching[0] } }
        if ($ids.Count -gt 0) { return [pscustomobject]@{ status = 'CONFLICT'; ids = $ids; model_id = $null } }
        return [pscustomobject]@{ status = 'NOT_READY'; ids = @(); model_id = $null }
    } catch {
        return [pscustomobject]@{ status = 'UNAVAILABLE'; ids = @(); model_id = $null }
    }
}

function Get-Placement([object[]]$RuntimeDevices, [object[]]$Gpus) {
    $physical = @($Gpus | Where-Object { Same-Name $_.name $DeviceName }) | Select-Object -First 1
    if (-not $physical) { Fail 'GPU_IDENTITY_UNAVAILABLE' "nvidia-smi GPU '$DeviceName' was not found." }
    $runtime = @($RuntimeDevices | Where-Object { Same-Name $_.name $physical.name }) | Select-Object -First 1
    if (-not $runtime -or $null -eq $runtime.runtime_index) { Fail 'GPU_IDENTITY_UNAVAILABLE' "llama.cpp Vulkan device for '$($physical.name)' was not found." }
    return [pscustomobject]@{ physical = $physical; runtime = $runtime }
}

if ($Mode -in @('Ensure', 'Plan') -and [string]::IsNullOrWhiteSpace($ModelPath)) {
    if ($Mode -eq 'Ensure') { Fail 'MODEL_PATH_REQUIRED' 'LLAMACPP_MODEL_PATH must name the qualified Spark GGUF.' }
}
if ($Mode -in @('Ensure', 'Plan') -and [string]::IsNullOrWhiteSpace($LlamaCommand)) {
    if ($Mode -eq 'Ensure') { Fail 'LLAMA_COMMAND_REQUIRED' 'LLAMACPP_COMMAND must be an absolute llama executable path.' }
}
if (-not [string]::IsNullOrWhiteSpace($LlamaCommand) -and ((-not (Test-AbsoluteWindowsPath $LlamaCommand)) -or (-not (Test-RegularFile $LlamaCommand)))) {
    Fail 'LLAMA_COMMAND_INVALID' 'LLAMACPP_COMMAND must be an existing absolute executable.'
}
if (-not [string]::IsNullOrWhiteSpace($ModelPath) -and ((-not (Test-AbsoluteWindowsPath $ModelPath)) -or (-not (Test-RegularFile $ModelPath)))) {
    Fail 'MODEL_PATH_INVALID' 'LLAMACPP_MODEL_PATH must be an existing absolute regular file.'
}
if ($Context -lt 1024 -or $Context -gt 1048576) { Fail 'CONTEXT_INVALID' 'Context is outside the bounded range.' }

$models = Get-ModelReadback
$processes = @(Get-LlamaProcesses)
$runtimeDevices = @(if (-not [string]::IsNullOrWhiteSpace($LlamaCommand)) { Get-LlamaDevices $LlamaCommand } else { @() })
$gpus = @(Get-NvidiaGpus)
$placement = if ($runtimeDevices.Count -gt 0 -and $gpus.Count -gt 0) { Get-Placement $runtimeDevices $gpus } else { $null }

$serverArgs = @()
if (-not ($LlamaCommand -and [IO.Path]::GetFileName($LlamaCommand).ToLowerInvariant() -eq 'llama-server.exe')) { $serverArgs += 'serve' }
$serverArgs += @('-m', $ModelPath, '-c', "$Context", '-ngl', '99', '--fit', 'off', '-fa', 'on', '--jinja', '--port', "$Port", '--host', '127.0.0.1', '--split-mode', 'none', '--main-gpu', $(if ($placement) { "$($placement.runtime.runtime_index)" } else { '<resolved-by-name>' }))

$base = [ordered]@{
    protocol = 'devexec.spark-primary.launcher'
    schema_version = 1
    mode = $Mode
    standard = [ordered]@{ runtime = 'local'; provider = 'llamacpp'; model = $Model; endpoint = "$BaseUrl/v1"; context = $Context; long_context = 65536; device_name = $DeviceName }
    endpoint = [ordered]@{ url = "$BaseUrl/v1"; port = $Port; model_readback = $models }
    placement = if ($placement) { [ordered]@{ physical_name = $placement.physical.name; physical_index = $placement.physical.index; runtime_name = $placement.runtime.name; runtime_index = $placement.runtime.runtime_index; cpu_fallback = $false } } else { $null }
    process = [ordered]@{ matching_llama = @($processes | ForEach-Object { [ordered]@{ pid = $_.ProcessId; name = $_.Name; command = $_.CommandLine } }); owned_pid = $null }
    plan = [ordered]@{ command = if ($LlamaCommand) { $LlamaCommand } else { '<LLAMACPP_COMMAND>' }; args = @($serverArgs) }
}

if ($Mode -eq 'Plan') { $base | ConvertTo-Json -Depth 12; exit 0 }
if ($Mode -eq 'Status') { $base.status = if ($models.status -eq 'READY') { 'READY' } else { $models.status }; $base | ConvertTo-Json -Depth 12; exit 0 }

if ($Mode -eq 'Stop') {
    $record = Join-Path $StateRoot 'server.json'
    if (-not (Test-Path -LiteralPath $record -PathType Leaf)) { $base.status = 'NOT_RUNNING'; $base | ConvertTo-Json -Depth 12; exit 0 }
    $saved = Get-Content -LiteralPath $record -Raw -Encoding UTF8 | ConvertFrom-Json
    $owned = @($processes | Where-Object { $_.ProcessId -eq [int]$saved.pid -and [string]$_.CommandLine -match [regex]::Escape($Model) }) | Select-Object -First 1
    if (-not $owned) { Fail 'OWNERSHIP_UNPROVEN' 'Recorded PID is not the expected owned Spark process; it was not stopped.' }
    Stop-Process -Id ([int]$saved.pid) -Force
    Remove-Item -LiteralPath $record -Force
    $base.status = 'STOPPED'
    $base | ConvertTo-Json -Depth 12
    exit 0
}

if ($models.status -eq 'CONFLICT') { Fail 'PORT_COLLISION' "Loopback port $Port advertises a different model: $($models.ids -join ', ')." }
if ($models.status -eq 'READY') {
    if ($processes.Count -eq 0) { Fail 'PLACEMENT_UNPROVEN' 'A matching model endpoint exists but no matching llama process/command was observed.' }
    if (-not $placement) { Fail 'PLACEMENT_UNPROVEN' 'A matching model endpoint exists but NVIDIA/Vulkan identity mapping was unavailable.' }
    $cmd = ($processes | Select-Object -First 1).CommandLine
    $runtimeIndex = [string]$placement.runtime.runtime_index
    foreach ($required in @('--split-mode none', '--fit off', '-ngl 99', '--host 127.0.0.1', "-c $Context", "--main-gpu $runtimeIndex")) {
        if ($cmd -notmatch [regex]::Escape($required)) { Fail 'PLACEMENT_UNPROVEN' "Existing llama process is missing required Spark placement flag '$required'." }
    }
    if (-not [string]::IsNullOrWhiteSpace($ModelPath) -and $cmd -notmatch [regex]::Escape($ModelPath)) { Fail 'PLACEMENT_UNPROVEN' 'Existing llama process does not name the configured Spark GGUF path.' }
    $base.status = 'REUSED_EXISTING'
    $base.process.owned_pid = $null
    $base | ConvertTo-Json -Depth 12
    exit 0
}
if ($models.status -eq 'UNAVAILABLE' -and (Test-LocalListener $Port)) { Fail 'PORT_COLLISION' "Loopback port $Port is already listening but the expected Spark model was not readable." }
if ($models.status -eq 'NOT_READY' -and (Test-LocalListener $Port)) { Fail 'PORT_COLLISION' "Loopback port $Port is already listening but the expected Spark model was not advertised." }

New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
$stdout = Join-Path $StateRoot 'llama.stdout.log'
$stderr = Join-Path $StateRoot 'llama.stderr.log'
$proc = Start-Process -FilePath $LlamaCommand -ArgumentList $serverArgs -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden
$deadline = (Get-Date).AddMilliseconds(300000)
$ready = $false
while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) { break }
    $readback = Get-ModelReadback
    if ($readback.status -eq 'READY') { $ready = $true; break }
    if ($readback.status -eq 'CONFLICT') { break }
    Start-Sleep -Milliseconds 500
}
if (-not $ready) {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    if ((Get-ModelReadback).status -eq 'CONFLICT') { Fail 'PORT_COLLISION' "Loopback port $Port advertised a different model while starting Spark." }
    Fail 'START_TIMEOUT' 'Spark llama.cpp did not advertise the configured model before the bounded deadline.'
}
$commandLine = @((Get-LlamaProcesses) | Where-Object { $_.ProcessId -eq $proc.Id } | Select-Object -First 1)
if ($commandLine.Count -eq 0) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; Fail 'PLACEMENT_UNPROVEN' 'Started llama process could not be read back.' }
$line = [string]$commandLine[0].CommandLine
$runtimeIndex = [string]$placement.runtime.runtime_index
foreach ($required in @('--split-mode none', '--fit off', '-ngl 99', '--host 127.0.0.1', "-c $Context", "--main-gpu $runtimeIndex")) {
    if ($line -notmatch [regex]::Escape($required)) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; Fail 'PLACEMENT_UNPROVEN' "Started llama process is missing required Spark placement flag '$required'." }
}
[ordered]@{ pid = $proc.Id; model = $Model; model_path = $ModelPath; endpoint = "$BaseUrl/v1"; context = $Context; device_name = $DeviceName; runtime_index = $placement.runtime.runtime_index; started_at = (Get-Date).ToString('o') } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $StateRoot 'server.json') -Encoding UTF8
$base.status = 'STARTED'
$base.process.owned_pid = $proc.Id
$base.endpoint.model_readback = Get-ModelReadback
$base | ConvertTo-Json -Depth 12
