param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Install', 'Status', 'Uninstall')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$TaskName,

  [string]$NodePath,
  [string]$CliPath,
  [string]$WorkingDirectory
)

$ErrorActionPreference = 'Stop'

function Get-WsDispatchTaskStatus {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    return [ordered]@{
      installed = $false
      task_name = $TaskName
      state = 'NotInstalled'
    }
  }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
  $action = @($task.Actions)[0]
  $trigger = @($task.Triggers)[0]
  return [ordered]@{
    installed = $true
    task_name = $TaskName
    state = [string]$task.State
    execute = [string]$action.Execute
    arguments = [string]$action.Arguments
    working_directory = [string]$action.WorkingDirectory
    trigger_user = [string]$trigger.UserId
    principal_user = [string]$task.Principal.UserId
    logon_type = [string]$task.Principal.LogonType
    run_level = [string]$task.Principal.RunLevel
    hidden = [bool]$task.Settings.Hidden
    multiple_instances = [string]$task.Settings.MultipleInstances
    restart_count = [int]$task.Settings.RestartCount
    restart_interval = [string]$task.Settings.RestartInterval
    execution_time_limit = [string]$task.Settings.ExecutionTimeLimit
    last_run_time = $info.LastRunTime.ToString('o')
    last_task_result = [int]$info.LastTaskResult
    next_run_time = $info.NextRunTime.ToString('o')
  }
}

if ($Action -eq 'Status') {
  Get-WsDispatchTaskStatus | ConvertTo-Json -Depth 6
  exit 0
}

if ($Action -eq 'Uninstall') {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -ne $existing) {
    if ([string]$existing.State -eq 'Running') {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
  }
  Get-WsDispatchTaskStatus | ConvertTo-Json -Depth 6
  exit 0
}

foreach ($required in @($NodePath, $CliPath, $WorkingDirectory)) {
  if ([string]::IsNullOrWhiteSpace($required)) {
    throw 'Install requires NodePath, CliPath, and WorkingDirectory.'
  }
}
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "Node executable not found: $NodePath" }
if (-not (Test-Path -LiteralPath $CliPath -PathType Leaf)) { throw "WS Dispatch CLI not found: $CliPath" }
if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) { throw "Working directory not found: $WorkingDirectory" }

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskActionArgs = @{
  Execute = $NodePath
  Argument = ('"{0}" serve' -f $CliPath)
  WorkingDirectory = $WorkingDirectory
}
$taskAction = New-ScheduledTaskAction @taskActionArgs
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settingsArgs = @{
  MultipleInstances = 'IgnoreNew'
  RestartCount = 3
  RestartInterval = (New-TimeSpan -Minutes 1)
  ExecutionTimeLimit = [TimeSpan]::Zero
  Hidden = $true
  StartWhenAvailable = $true
  AllowStartIfOnBatteries = $true
  DontStopIfGoingOnBatteries = $true
}
$settings = New-ScheduledTaskSettingsSet @settingsArgs
$definition = New-ScheduledTask -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings
Register-ScheduledTask -TaskName $TaskName -InputObject $definition -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Milliseconds 500
Get-WsDispatchTaskStatus | ConvertTo-Json -Depth 6
