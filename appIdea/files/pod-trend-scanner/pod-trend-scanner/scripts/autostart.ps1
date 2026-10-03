# Tự khởi động Postgres local (port 5433) + `scanner schedule` sau khi đăng nhập Windows.
# Được Task Scheduler gọi (task "pod-trend-scanner autostart", trigger: lúc logon).
# Chạy lại nhiều lần vẫn an toàn: bước nào đang chạy rồi thì bỏ qua.
#
# Đăng ký task (một lần, không cần quyền admin):
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Register

param([switch]$Register)

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$PgBin = 'F:\pgdev16\pgsql\bin'
$PgData = 'F:\pgdev16\data'
$PgLog = 'F:\pgdev16\server.log'
$PgPort = 5433
$LogDir = Join-Path $ProjectDir 'logs'
$TaskName = 'pod-trend-scanner autostart'

if ($Register) {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    # Chờ 30s sau logon cho mạng lên; không giới hạn thời gian chạy (scheduler chạy mãi).
    $trigger.Delay = 'PT30S'
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Output "Registered task '$TaskName'"
    return
}

New-Item -ItemType Directory -Force $LogDir | Out-Null
$AutostartLog = Join-Path $LogDir 'autostart.log'
function Log($msg) { "$(Get-Date -Format s) $msg" | Out-File -Append -Encoding utf8 $AutostartLog }

# 1. Postgres. Phải truyền -p 5433: postgresql.conf không set port, mặc định 5432 đã bị
#    service postgresql-x64-16 chiếm (Windows báo "Permission denied" khi bind).
& "$PgBin\pg_ctl.exe" status -D $PgData *> $null
if ($LASTEXITCODE -eq 0) {
    Log 'postgres: already running'
} else {
    # Không dùng -w: pg_ctl -w giữ pipe stdout và treo khi chạy không có console.
    Start-Process -FilePath "$PgBin\pg_ctl.exe" -WindowStyle Hidden `
        -ArgumentList 'start', '-D', $PgData, '-l', $PgLog, '-o', "`"-p $PgPort`""
    $ready = $false
    for ($i = 0; $i -lt 30 -and -not $ready; $i++) {
        Start-Sleep 2
        & "$PgBin\pg_isready.exe" -h 127.0.0.1 -p $PgPort *> $null
        $ready = ($LASTEXITCODE -eq 0)
    }
    if (-not $ready) { Log 'postgres: FAILED to start, see F:\pgdev16\server.log'; exit 1 }
    Log 'postgres: started'
}

# 2. Scheduler. Bỏ qua nếu đã có một tiến trình `scanner schedule` đang chạy.
$running = Get-CimInstance Win32_Process -Filter "Name = 'scanner.exe' OR Name = 'python.exe'" |
    Where-Object { $_.CommandLine -match 'scanner(\.exe)?"?\s+schedule' }
if ($running) {
    Log "scheduler: already running (pid $($running.ProcessId -join ','))"
} else {
    $stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
    $p = Start-Process -FilePath (Join-Path $ProjectDir '.venv\Scripts\scanner.exe') -ArgumentList 'schedule' `
        -WorkingDirectory $ProjectDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $LogDir "scheduler_$stamp.log") `
        -RedirectStandardError (Join-Path $LogDir "scheduler_$stamp.err.log")
    Log "scheduler: started pid $($p.Id)"
}
