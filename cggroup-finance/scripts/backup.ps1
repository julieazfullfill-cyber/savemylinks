# Sao luu database CGGroup (pg_dump dang custom) vao backups\, giu $Keep ban gan nhat.
#   powershell -ExecutionPolicy Bypass -File scripts\backup.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\backup.ps1 -Register   # tu chay 23:30 moi ngay
# Doc DATABASE_URL tu .env (hoac bien moi truong). Can pg_dump cua PostgreSQL 16.
param(
  [int]$Keep = 30,
  [switch]$Register,
  [string]$PgBin = 'C:\Program Files\PostgreSQL\16\bin'
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

if ($Register) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Keep $Keep"
  $trigger = New-ScheduledTaskTrigger -Daily -At '23:30'
  Register-ScheduledTask -TaskName 'CGGroup-Finance-Backup' -Action $action -Trigger $trigger -Description 'Sao luu DB CGGroup moi ngay' -Force | Out-Null
  Write-Output 'Da dang ky tac vu CGGroup-Finance-Backup (23:30 hang ngay).'
  exit 0
}

function Get-DbUrl {
  if ($env:DATABASE_URL) { return $env:DATABASE_URL }
  $line = Get-Content (Join-Path $Root '.env') | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } | Select-Object -First 1
  if (-not $line) { throw 'Khong tim thay DATABASE_URL trong .env' }
  return ($line -replace '^\s*DATABASE_URL\s*=\s*', '').Trim('"', "'", ' ')
}

$u = [Uri](Get-DbUrl)
$user, $pass = $u.UserInfo.Split(':', 2)
$db = $u.AbsolutePath.TrimStart('/')
$port = if ($u.Port -gt 0) { $u.Port } else { 5432 }
$schemaArg = @()
if ($u.Query -match 'schema=([^&]+)') { $schemaArg = @('--schema', $Matches[1]) }

$dir = Join-Path $Root 'backups'
New-Item -ItemType Directory -Force $dir | Out-Null
$file = Join-Path $dir ("{0}_{1}.dump" -f $db, (Get-Date -Format 'yyyyMMdd_HHmmss'))

$env:PGPASSWORD = [Uri]::UnescapeDataString($pass)
& (Join-Path $PgBin 'pg_dump.exe') -h $u.Host -p $port -U ([Uri]::UnescapeDataString($user)) -d $db -Fc --no-owner @schemaArg -f $file
if ($LASTEXITCODE -ne 0) { throw "pg_dump that bai (ma $LASTEXITCODE)" }
Remove-Item Env:PGPASSWORD

$size = [math]::Round((Get-Item $file).Length / 1KB, 1)
Write-Output "Da sao luu: $file ($size KB)"

# Giu $Keep ban moi nhat
Get-ChildItem $dir -Filter "${db}_*.dump" | Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep | ForEach-Object {
  Remove-Item $_.FullName -Confirm:$false
  Write-Output "Xoa ban cu: $($_.Name)"
}
