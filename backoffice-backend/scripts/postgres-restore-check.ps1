param(
    [Parameter(Mandatory=$true)][string]$BackupPath,
    [string]$PostgresBin = 'C:/Program Files/PostgreSQL/18/bin',
    [int]$Port = 55432
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
& (Join-Path $PSScriptRoot 'postgres-start.ps1') -PostgresBin $PostgresBin -Port $Port
$backupRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.local/backups'))
$resolvedBackup = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $BackupPath).Path)
if (-not $resolvedBackup.StartsWith($backupRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Restore checks accept only backups inside this project .local/backups.' }
foreach ($directory in @($backupRoot,$resolvedBackup,(Join-Path $resolvedBackup 'files'))) {
    if ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Backup paths must not be links.' }
}
$manifest = Get-Content -Raw -LiteralPath (Join-Path $resolvedBackup 'manifest.json') | ConvertFrom-Json
if ($manifest.formatVersion -ne 1 -or $manifest.writersStopped -ne $true -or $manifest.backupId -notmatch '^\d{8}T\d{6}Z_[0-9a-f]{8}$') { throw 'Unsupported or incomplete backup manifest.' }
if ($manifest.application.database -ne 'delivery_backoffice' -or $manifest.source.database -ne 'odoo_mock') { throw 'Manifest database scope does not match this local demo.' }
foreach ($part in @(@{ manifest=$manifest.application; file='application.dump' },@{ manifest=$manifest.source; file='source.dump' })) {
    if ($part.manifest.dump -ne $part.file -or $part.manifest.sha256 -notmatch '^[A-Fa-f0-9]{64}$') { throw 'Invalid dump manifest.' }
    $dump = Get-Item -LiteralPath (Join-Path $resolvedBackup $part.file)
    if ($dump.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Dump files must not be links.' }
    if ((Get-FileHash -LiteralPath $dump.FullName -Algorithm SHA256).Hash -ne $part.manifest.sha256) { throw 'Backup dump checksum mismatch; no database was created.' }
}
$fileNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($file in @($manifest.files)) {
    if ($file.name -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.pending)?$' -or $file.sha256 -notmatch '^[A-Fa-f0-9]{64}$' -or $file.size -lt 1 -or -not $fileNames.Add($file.name)) { throw 'Invalid private-file manifest.' }
    $entry = Get-Item -LiteralPath (Join-Path (Join-Path $resolvedBackup 'files') $file.name)
    if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $entry.Length -ne $file.size -or (Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash -ne $file.sha256) { throw 'Private file checksum/size mismatch; no database was created.' }
}
$credentials = Get-Content -Raw -LiteralPath (Join-Path $projectRoot '.local/postgres-credentials.json') | ConvertFrom-Json
$psql = Join-Path $PostgresBin 'psql.exe'
$restoreId = [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') + '_' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$appDatabase = 'delivery_backoffice_restore_' + $restoreId
$sourceDatabase = 'odoo_mock_restore_' + $restoreId
if ($appDatabase -notmatch '^delivery_backoffice_restore_\d{14}_[0-9a-f]{8}$' -or $sourceDatabase -notmatch '^odoo_mock_restore_\d{14}_[0-9a-f]{8}$') { throw 'Unsafe generated restore database name.' }
$restoreRoot = Join-Path $projectRoot '.local/restore-checks'
New-Item -ItemType Directory -Path $restoreRoot -Force | Out-Null
if ((Get-Item -LiteralPath $restoreRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Restore-check storage must not be a link.' }
$restorePath = Join-Path $restoreRoot $restoreId
New-Item -ItemType Directory -Path $restorePath | Out-Null
$restoredFiles = Join-Path $restorePath 'files'
New-Item -ItemType Directory -Path $restoredFiles | Out-Null
function Query-Local([string]$Database,[string]$Sql) {
    $result = & $psql -X -A -t -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $Port -U backoffice_local_admin -d $Database -c $Sql
    if ($LASTEXITCODE -ne 0) { throw "Restore check query failed in $Database. Existing databases were not replaced." }
    return $result
}
function Assert-Counts([string]$Database,$Expected) {
    $tables = @(Query-Local $Database "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
    $names = @($Expected.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
    if (($tables -join ',') -ne ($names -join ',')) { throw "Restored table names differ in $Database." }
    foreach ($table in $names) {
        if ($table -notmatch '^[a-z_][a-z0-9_]*$') { throw 'Unexpected manifest table identifier.' }
        $actual = [long](Query-Local $Database ('SELECT count(*) FROM public."' + $table + '"'))
        if ($actual -ne [long]$Expected.$table) { throw "Restored row count differs for $table in $Database." }
    }
}
$env:PGPASSWORD = $credentials.admin
try {
    foreach ($database in @($appDatabase,$sourceDatabase)) {
        $existing = Query-Local 'postgres' ("SELECT count(*) FROM pg_database WHERE datname='$database'")
        if ([long]$existing -ne 0) { throw 'Generated restore target already exists; nothing will be replaced.' }
    }
    foreach ($target in @(@{ database=$appDatabase; owner='delivery_app'; dump='application.dump' },@{ database=$sourceDatabase; owner='odoo_seed'; dump='source.dump' })) {
        Query-Local 'postgres' ('CREATE DATABASE "' + $target.database + '" OWNER "' + $target.owner + '"') | Out-Null
        Query-Local 'postgres' ('REVOKE ALL ON DATABASE "' + $target.database + '" FROM PUBLIC') | Out-Null
        & (Join-Path $PostgresBin 'pg_restore.exe') -h 127.0.0.1 -p $Port -U backoffice_local_admin -d $target.database --role $target.owner --no-owner --no-privileges --single-transaction --exit-on-error (Join-Path $resolvedBackup $target.dump)
        if ($LASTEXITCODE -ne 0) { throw "Restore failed in new database $($target.database). It was retained for inspection; no existing database was replaced." }
    }
    Assert-Counts $appDatabase $manifest.application.counts
    Assert-Counts $sourceDatabase $manifest.source.counts
    $filterSql = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'local/source-filter.sql')).Trim().TrimEnd(';')
    $actualIds = @(Query-Local $sourceDatabase ("SELECT id FROM ($filterSql) expected ORDER BY id") | ForEach-Object { [int]$_ })
    if (($actualIds -join ',') -ne (@($manifest.source.expectedPickingIds) -join ',')) { throw 'Restored source filter result differs from backup manifest.' }
    foreach ($file in @($manifest.files)) {
        $destination = Join-Path $restoredFiles $file.name
        Copy-Item -LiteralPath (Join-Path (Join-Path $resolvedBackup 'files') $file.name) -Destination $destination
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $file.sha256) { throw 'Restored private file checksum differs.' }
    }
    $fileJson = Query-Local $appDatabase "SELECT COALESCE(json_agg(json_build_object('id',id,'size',size,'status',status) ORDER BY id),'[]'::json)::text FROM file_record"
    $records = @($fileJson | ConvertFrom-Json -NoEnumerate)
    if ($records.Count -eq 1 -and $records[0] -is [Array]) { $records = @($records[0]) }
    if (($records | ConvertTo-Json -Depth 5 -Compress) -ne ($manifest.fileRecords | ConvertTo-Json -Depth 5 -Compress)) { throw 'Restored file metadata differs from backup manifest.' }
    foreach ($record in $records) {
        if ($record.status -notin @('pending','ready','failed')) { throw 'Unknown restored file lifecycle status.' }
        if ($record.status -eq 'ready') {
            if ($record.id -notmatch '^[0-9a-f-]{36}$') { throw 'Invalid ready file ID.' }
            $ready = Get-Item -LiteralPath (Join-Path $restoredFiles $record.id) -ErrorAction Stop
            if ($ready.Length -ne $record.size) { throw 'Restored ready file bytes do not match metadata.' }
        }
    }
    $report = [ordered]@{
        status='verified'; verifiedAt=[DateTime]::UtcNow.ToString('o'); backupId=$manifest.backupId;
        applicationDatabase=$appDatabase; sourceDatabase=$sourceDatabase; privateFilesDirectory=$restoredFiles;
        applicationCounts=$manifest.application.counts; sourceCounts=$manifest.source.counts;
        sourcePickingIds=$actualIds; physicalFileCount=@($manifest.files).Count;
        readyFileCount=@($records | Where-Object { $_.status -eq 'ready' }).Count;
        pendingFileCount=@($records | Where-Object { $_.status -eq 'pending' }).Count;
        failedFileCount=@($records | Where-Object { $_.status -eq 'failed' }).Count
    }
    $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $restorePath 'verification.json') -Encoding utf8
    Write-Output "PASS: restored new application database $appDatabase"
    Write-Output "PASS: restored new source database $sourceDatabase; picking filter IDs $($actualIds -join ',')"
    Write-Output "PASS: table counts, dump hashes, file metadata, private bytes and lifecycle statuses verified. Ready files: $($report.readyFileCount); pending: $($report.pendingFileCount); failed: $($report.failedFileCount)."
    Write-Output "Verification report: $(Join-Path $restorePath 'verification.json')"
    Write-Output 'New clone databases and private files are retained; no original database or live files were replaced.'
} finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
