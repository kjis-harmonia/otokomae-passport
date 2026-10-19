param([string]$ConnectionString, [string]$BackupRoot = 'C:/Users/user/Desktop/otokomae-backups/private')
$ErrorActionPreference = 'Stop'
$projectRef = 'ufyzynpmkxytnhebombq'
$pgBin = 'C:/Program Files/PostgreSQL/17/bin'
if (-not (Test-Path -LiteralPath "$pgBin/pg_dump.exe")) { throw 'PostgreSQL 17 の pg_dump がありません。ここで止めてください。' }
if (-not $ConnectionString) { $ConnectionString = Read-Host '本番 Connect の Session pooler URL（5432、パスワードを含めない）' }
$uri = [Uri]$ConnectionString
if ($uri.Scheme -notin @('postgres','postgresql') -or $uri.AbsolutePath -ne '/postgres' -or $uri.Port -ne 5432 -or $uri.Fragment) { throw 'postgres DB / port 5432 の URL を指定してください。' }
$userInfo = [Uri]::UnescapeDataString($uri.UserInfo)
if ($userInfo.Contains(':')) { throw 'URL にパスワードを含めないでください。表示・保存せず中止しました。' }
$direct = $uri.Host -eq "db.$projectRef.supabase.co" -and $userInfo -eq 'postgres'
$pooler = $uri.Host.EndsWith('.pooler.supabase.com') -and $userInfo -eq "postgres.$projectRef"
if (-not ($direct -or $pooler)) { throw '本番プロジェクトと一致しません。中止しました。' }
if ($uri.Query -and $uri.Query -ne '?sslmode=require') { throw 'URL のクエリは sslmode=require だけにしてください。' }
if (-not $uri.Query) { $ConnectionString += '?sslmode=require' }
$backupDir = Join-Path $BackupRoot ('prod-before-release-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
if (Test-Path -LiteralPath $backupDir) { throw '既存バックアップには上書きしません。' }
New-Item -ItemType Directory -Path $backupDir | Out-Null
$securePassword = Read-Host '本番DBのパスワード（表示されません）' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
$previousPassword = $env:PGPASSWORD
$previousOptions = $env:PGOPTIONS
try {
  $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $env:PGOPTIONS = '-c default_transaction_read_only=on'
  $dump = Join-Path $backupDir 'database.dump'
  & "$pgBin/pg_dump.exe" --dbname $ConnectionString --no-password --format=custom --file $dump
  if ($LASTEXITCODE -ne 0) { throw 'バックアップ失敗。DB更新には進まないでください。' }
  & "$pgBin/pg_dumpall.exe" --database $ConnectionString --no-password --roles-only --no-role-passwords --file (Join-Path $backupDir 'roles.sql')
  if ($LASTEXITCODE -ne 0) { throw 'ロール保存に失敗。DB更新には進まないでください。' }
  & "$pgBin/pg_restore.exe" --list $dump | Set-Content -LiteralPath (Join-Path $backupDir 'contents.txt') -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw 'バックアップを読み取れません。DB更新には進まないでください。' }
  $contents = Get-Content -LiteralPath (Join-Path $backupDir 'contents.txt') -Raw
  if ($contents -notmatch 'TABLE DATA public customers' -or $contents -notmatch 'TABLE DATA public tickets' -or $contents -notmatch 'TABLE DATA supabase_migrations schema_migrations') { throw '会員・券・migration履歴の保存を確認できません。ここで止めてください。' }
  Get-FileHash -Algorithm SHA256 -LiteralPath $dump,(Join-Path $backupDir 'roles.sql') | Select-Object Path,Hash | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backupDir 'sha256.json') -Encoding utf8
  Write-Output "BACKUP OK: $backupDir"
  Write-Output '本番DBへの書き込みはしていません。復元の実証は別途必要です。バックアップをGitへ追加しないでください。'
} finally {
  $env:PGPASSWORD = $previousPassword
  $env:PGOPTIONS = $previousOptions
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $securePassword.Dispose()
}
