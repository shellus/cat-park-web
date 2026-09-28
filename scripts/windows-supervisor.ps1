# Keeps `npm start` running on a Windows host: restarts after exits and appends output to .runtime/start.*.log.
# Register once with scripts/windows-supervisor.ps1 -Register; the scheduled task starts it at logon.
param([switch]$Register, [switch]$Unregister)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$taskName = 'CatParkWeb'

if ($Register -or $Unregister) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  if ($Unregister) { Write-Output "已移除计划任务 $taskName"; return }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $root `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings | Out-Null
  Write-Output "已注册计划任务 $taskName：登录后自动启动并在退出后重启"
  return
}

$runtime = Join-Path $root '.runtime'
New-Item -ItemType Directory -Force $runtime | Out-Null
while ($true) {
  $started = Get-Date
  Add-Content -Encoding utf8 (Join-Path $runtime 'start.log') "$($started.ToString('s')) supervisor: npm start"
  $process = Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -WorkingDirectory $root -NoNewWindow -PassThru `
    -RedirectStandardOutput (Join-Path $runtime 'start.stdout.log') -RedirectStandardError (Join-Path $runtime 'start.stderr.log')
  $process.WaitForExit()
  $process.Refresh()
  Add-Content -Encoding utf8 (Join-Path $runtime 'start.log') "$((Get-Date).ToString('s')) supervisor: exit $($process.ExitCode)"
  # Back off when the service fails immediately so a broken build does not spin.
  if (((Get-Date) - $started).TotalSeconds -lt 60) { Start-Sleep -Seconds 30 } else { Start-Sleep -Seconds 3 }
}
