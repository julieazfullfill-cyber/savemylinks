# Thu khoi phuc ban sao luu moi nhat vao mot DB tam, so so dong cac bang voi DB goc, roi xoa DB tam.
# Khong dung toi DB dang chay.
#   powershell -ExecutionPolicy Bypass -File scripts\restore-test.ps1
param([string]$PgBin = 'C:\Program Files\PostgreSQL\16\bin', [string]$TempDb = 'cggroup_restore_check')
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$line = Get-Content (Join-Path $Root '.env') | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } | Select-Object -First 1
$u = [Uri](($line -replace '^\s*DATABASE_URL\s*=\s*', '').Trim('"', "'", ' '))
$user, $pass = $u.UserInfo.Split(':', 2)
$db = $u.AbsolutePath.TrimStart('/')
$port = if ($u.Port -gt 0) { $u.Port } else { 5432 }
if ($db -eq $TempDb) { throw 'DB tam trung ten DB goc' }

$dump = Get-ChildItem (Join-Path $Root 'backups') -Filter "${db}_*.dump" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $dump) { throw 'Chua co ban sao luu nao - chay scripts\backup.ps1 truoc' }
Write-Output "Khoi phuc thu: $($dump.Name)"

$env:PGPASSWORD = [Uri]::UnescapeDataString($pass)
$common = @('-h', $u.Host, '-p', $port, '-U', [Uri]::UnescapeDataString($user))
$psql = Join-Path $PgBin 'psql.exe'

$env:PGOPTIONS = '-c client_min_messages=warning'
& $psql @common -d postgres -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $TempDb" -c "CREATE DATABASE $TempDb" | Out-Null
try {
  & (Join-Path $PgBin 'pg_restore.exe') @common -d $TempDb --no-owner $dump.FullName
  if ($LASTEXITCODE -ne 0) { throw "pg_restore that bai (ma $LASTEXITCODE)" }

  # Dem so dong moi bang trong mot cau SQL (khong can dau ngoac kep - PowerShell 5.1 lam roi chung khi goi psql).
  $sql = "SELECT table_name || '|' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1"
  $src = @{}; $dst = @{}
  (& $psql @common -d $db -tAc $sql) | Where-Object { $_ } | ForEach-Object { $k, $v = $_.Split('|'); $src[$k] = $v }
  (& $psql @common -d $TempDb -tAc $sql) | Where-Object { $_ } | ForEach-Object { $k, $v = $_.Split('|'); $dst[$k] = $v }
  if ($src.Count -eq 0) { throw 'Khong doc duoc bang nao tu DB goc' }
  $bad = 0
  foreach ($t in ($src.Keys | Sort-Object)) {
    $mark = if ($src[$t] -eq $dst[$t]) { 'OK ' } else { $bad++; 'LECH' }
    Write-Output ("{0}  {1,-22} goc={2,-8} khoi_phuc={3}" -f $mark, $t, $src[$t], $dst[$t])
  }
  if ($bad -gt 0) { throw "$bad bang lech so dong" }
  Write-Output 'KHOI PHUC THU THANH CONG - so dong moi bang khop voi DB goc.'
}
finally {
  & $psql @common -d postgres -q -c "DROP DATABASE IF EXISTS $TempDb" | Out-Null
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
