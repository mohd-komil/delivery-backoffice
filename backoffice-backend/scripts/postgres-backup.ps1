param(
    [switch]$WritersStopped,
    [string]$PostgresBin = 'C:/Program Files/PostgreSQL/18/bin',
    [int]$Port = 55432
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $WritersStopped) { throw 'Stop backend/importer/demo/source writers first, then pass -WritersStopped. App, source and files do not share a transaction.' }
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
& (Join-Path $PSScriptRoot 'postgres-start.ps1') -PostgresBin $PostgresBin -Port $Port
foreach ($command in @('pg_dump.exe','psql.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $PostgresBin $command))) { throw "PostgreSQL executable missing: $command" }
}
$credentials = Get-Content -Raw -LiteralPath (Join-Path $projectRoot '.local/postgres-credentials.json') | ConvertFrom-Json
$psql = Join-Path $PostgresBin 'psql.exe'
$backupId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '_' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$backupRoot = Join-Path $projectRoot '.local/backups'
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
if ((Get-Item -LiteralPath $backupRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Backup root must not be a link.' }
$backupPath = Join-Path $backupRoot $backupId
New-Item -ItemType Directory -Path $backupPath | Out-Null
$filesPath = Join-Path $backupPath 'files'
New-Item -ItemType Directory -Path $filesPath | Out-Null

function Query-Local([string]$Database,[string]$Sql) {
    $result = & $psql -X -A -t -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $Port -U backoffice_local_admin -d $Database -c $Sql
    if ($LASTEXITCODE -ne 0) { throw "Backup query failed in $Database; no backup was marked complete." }
    return $result
}
function Table-Counts([string]$Database) {
    $counts = [ordered]@{}
    $tables = @(Query-Local $Database "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
    foreach ($table in $tables) {
        if ($table -notmatch '^[a-z_][a-z0-9_]*$') { throw 'Unexpected table identifier in owned local database.' }
        $counts[$table] = [long](Query-Local $Database ('SELECT count(*) FROM public."' + $table + '"'))
    }
    return $counts
}
$env:PGPASSWORD = $credentials.admin
try {
    $serverVersion = Query-Local 'postgres' 'SHOW server_version'
    $appCounts = Table-Counts 'delivery_backoffice'
    $sourceCounts = Table-Counts 'odoo_mock'
    $fileJson = Query-Local 'delivery_backoffice' "SELECT COALESCE(json_agg(json_build_object('id',id,'size',size,'status',status) ORDER BY id),'[]'::json)::text FROM file_record"
    $fileRecords = @($fileJson | ConvertFrom-Json -NoEnumerate)
    if ($fileRecords.Count -eq 1 -and $fileRecords[0] -is [Array]) { $fileRecords = @($fileRecords[0]) }
    $filterSql = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'local/source-filter.sql')).Trim().TrimEnd(';')
    $sourceIds = @(Query-Local 'odoo_mock' ("SELECT id FROM ($filterSql) expected ORDER BY id") | ForEach-Object { [int]$_ })
    foreach ($database in @('delivery_backoffice','odoo_mock')) {
        $filename = if ($database -eq 'delivery_backoffice') { 'application.dump' } else { 'source.dump' }
        & (Join-Path $PostgresBin 'pg_dump.exe') -h 127.0.0.1 -p $Port -U backoffice_local_admin -d $database --format=custom --file (Join-Path $backupPath $filename)
        if ($LASTEXITCODE -ne 0) { throw "pg_dump failed for $database; incomplete files were retained for inspection." }
    }
    $physicalFiles = @()
    $liveFiles = Join-Path $projectRoot '.local/files'
    if (Test-Path -LiteralPath $liveFiles) {
        if ((Get-Item -LiteralPath $liveFiles).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Private storage must not be a link.' }
        foreach ($file in Get-ChildItem -LiteralPath $liveFiles -Force) {
            if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.Name -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.pending)?$') {
                throw 'Unexpected entry in private file storage; refusing to copy it.'
            }
            $hashBefore = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
            $copiedPath = Join-Path $filesPath $file.Name
            Copy-Item -LiteralPath $file.FullName -Destination $copiedPath
            $hashAfter = (Get-FileHash -LiteralPath $copiedPath -Algorithm SHA256).Hash
            if ($hashBefore -ne $hashAfter) { throw 'A private file changed during backup; stop all writers and retry.' }
            $physicalFiles += [ordered]@{ name=$file.Name; size=$file.Length; sha256=$hashAfter }
        }
    }
    foreach ($record in $fileRecords) {
        if ($record.status -notin @('pending','ready','failed')) { throw 'Unknown file lifecycle status.' }
        if ($record.status -eq 'ready') {
            $file = @($physicalFiles | Where-Object { $_.name -eq $record.id })
            if ($file.Count -ne 1 -or $file[0].size -ne $record.size) { throw 'A ready file is missing/incomplete; the snapshot cannot be marked usable.' }
        }
    }
    $manifest = [ordered]@{
        formatVersion=1; backupId=$backupId; createdAt=[DateTime]::UtcNow.ToString('o');
        serverVersion=$serverVersion; writersStopped=$true;
        application=[ordered]@{ database='delivery_backoffice'; dump='application.dump'; sha256=(Get-FileHash -LiteralPath (Join-Path $backupPath 'application.dump') -Algorithm SHA256).Hash; counts=$appCounts };
        source=[ordered]@{ database='odoo_mock'; dump='source.dump'; sha256=(Get-FileHash -LiteralPath (Join-Path $backupPath 'source.dump') -Algorithm SHA256).Hash; counts=$sourceCounts; expectedPickingIds=$sourceIds };
        fileRecords=$fileRecords; files=$physicalFiles
    }
    $manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $backupPath 'manifest.json') -Encoding utf8
    Write-Output "Backup complete: $backupPath"
    Write-Output "Application deliveries: $($appCounts['delivery']); source pickings: $($sourceCounts['stock_picking']); private physical files: $($physicalFiles.Count)."
} finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
