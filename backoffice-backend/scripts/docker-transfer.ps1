param(
    [switch]$WritersStopped,
    [string]$PostgresBin = 'C:/Program Files/PostgreSQL/18/bin'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
if (-not $WritersStopped) { throw 'Stop native API/importer/demo/source writers, then pass -WritersStopped. This copies into empty Docker databases only.' }
if (Get-NetTCPConnection -State Listen -LocalPort 3001 -ErrorAction SilentlyContinue) { throw 'API port 3001 must be stopped before the joint database/file snapshot.' }
& (Join-Path $PSScriptRoot 'postgres-start.ps1') -PostgresBin $PostgresBin
& (Join-Path $PSScriptRoot 'docker-configure.ps1')
$psql = Join-Path $PostgresBin 'psql.exe'
$credentials = Get-Content -Raw -LiteralPath (Join-Path $projectRoot '.local/postgres-credentials.json') | ConvertFrom-Json

. (Join-Path $PSScriptRoot 'docker-state.ps1')
Docker-Checked -Arguments @('compose','config','--quiet')
Docker-Checked -Arguments @('compose','up','-d','--wait','db')
$dbContainer = & docker compose ps -q db
if ($LASTEXITCODE -ne 0 -or $dbContainer -notmatch '^[a-f0-9]{12,64}$') { throw 'Expected exactly one task-owned Docker database.' }
$projectLabel = & docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' $dbContainer
if ($LASTEXITCODE -ne 0 -or $projectLabel -ne 'delivery-backoffice') { throw 'Unexpected Compose project.' }
$dataDirectory = Query-Database 'postgres' 'SHOW data_directory' -Container
if ($dataDirectory -ne '/var/lib/postgresql/18/docker') { throw 'Unexpected Docker PostgreSQL volume target.' }
$serverPort = Query-Database 'postgres' 'SHOW port' -Container
if ($serverPort -ne '55432') { throw 'Unexpected internal PostgreSQL port.' }
foreach ($database in @('delivery_backoffice','odoo_mock','delivery_backoffice_test')) {
    $existing = Query-Database $database "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname !~ '^pg_'" -Container
    if ($existing -ne '0') { throw "Docker $database is not empty. Refusing to merge, clean, reset or restore over it." }
}

$env:PGPASSWORD = $credentials.admin
try {
    $baseline = [ordered]@{}
    $accountNames = @('demo-accounts.json','participant-demo-accounts.json')
    $accountBaseline = Local-FileInventory (Join-Path $projectRoot '.local') -SelectedNames $accountNames
    foreach ($database in @('delivery_backoffice','odoo_mock','delivery_backoffice_test')) { $baseline[$database] = Database-Snapshot $database }
    $backupOutput = & (Join-Path $PSScriptRoot 'postgres-backup.ps1') -WritersStopped -PostgresBin $PostgresBin
    $backupOutput | Write-Output
    $backupLine = @($backupOutput | Where-Object { $_ -is [string] -and $_.StartsWith('Backup complete: ') })
    if ($backupLine.Count -ne 1) { throw 'No completed owned backup was produced.' }
    $backupPath = [IO.Path]::GetFullPath($backupLine[0].Substring('Backup complete: '.Length))
    $backupRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.local/backups')) + [IO.Path]::DirectorySeparatorChar
    if (-not $backupPath.StartsWith($backupRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Backup escaped the intended directory.' }
    # The reused backup script deliberately clears its temporary password env.
    $env:PGPASSWORD = $credentials.admin
    & (Join-Path $PostgresBin 'pg_dump.exe') -h 127.0.0.1 -p 55432 -U backoffice_local_admin -d delivery_backoffice_test --format=custom --file (Join-Path $backupPath 'test.dump')
    if ($LASTEXITCODE -ne 0) { throw 'Test database archive failed.' }
    $manifest = Get-Content -Raw -LiteralPath (Join-Path $backupPath 'manifest.json') | ConvertFrom-Json
    $baseline | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $backupPath 'docker-baseline.json') -Encoding utf8
    $runtimeCredentials = Join-Path $backupPath 'runtime-credentials'
    New-Item -ItemType Directory -Path $runtimeCredentials | Out-Null
    foreach ($filename in @('demo-accounts.json','participant-demo-accounts.json')) {
        $original = Join-Path $projectRoot ('.local/' + $filename)
        if (Test-Path -LiteralPath $original) { Copy-Item -LiteralPath $original -Destination (Join-Path $runtimeCredentials $filename) }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $runtimeCredentials 'demo-accounts.json'))) { throw 'Existing users need their matching private local credentials manifest.' }
    $archiveChecks = [ordered]@{}
    foreach ($filename in @('application.dump','source.dump','test.dump')) { $archiveChecks[$filename] = (Get-FileHash -LiteralPath (Join-Path $backupPath $filename) -Algorithm SHA256).Hash }
    if ($archiveChecks['application.dump'] -ne $manifest.application.sha256 -or $archiveChecks['source.dump'] -ne $manifest.source.sha256) { throw 'Archive changed after backup.' }

    # Check the destination volume before restoring any database. No existing
    # private files/credentials can be overwritten by this migration.
    Docker-Checked -Arguments @('compose','run','--rm','--no-deps','tools','sh','-c','test ! -e .local/files && test ! -e .local/demo-accounts.json && test ! -e .local/participant-demo-accounts.json')
    $transferId = 'backoffice-transfer-' + [Guid]::NewGuid().ToString('N')
    Docker-Checked -Arguments @('compose','exec','-T','--user','postgres','db','mkdir','-m','700',('/tmp/' + $transferId))
    foreach ($entry in @(@('delivery_backoffice','application.dump'),@('odoo_mock','source.dump'),@('delivery_backoffice_test','test.dump'))) {
        $filename = $entry[1]
        Docker-Checked -Arguments @('compose','cp',(Join-Path $backupPath $filename),('db:/tmp/' + $transferId + '/' + $filename))
        Docker-Checked -Arguments @('compose','exec','-T','db','pg_restore','--exit-on-error','--single-transaction','-U','backoffice_local_admin','-d',$entry[0],('/tmp/' + $transferId + '/' + $filename))
    }
    Docker-Checked -Arguments @('compose','run','--rm','--no-deps','--volume',($backupPath + ':/transfer:ro'),'tools','sh','-c','umask 077; mkdir -p .local/files; cp -a /transfer/files/. .local/files/; cp /transfer/runtime-credentials/*.json .local/')

    $restored = [ordered]@{}
    foreach ($database in @('delivery_backoffice','odoo_mock','delivery_backoffice_test')) {
        $restored[$database] = Database-Snapshot $database -Container
        $nativeAfter = Database-Snapshot $database
        $expected = $baseline[$database] | ConvertTo-Json -Depth 20 -Compress
        if (($restored[$database] | ConvertTo-Json -Depth 20 -Compress) -ne $expected) { throw "Full-row/sequence comparison failed for Docker $database." }
        if (($nativeAfter | ConvertTo-Json -Depth 20 -Compress) -ne $expected) { throw "Native $database changed during transfer; stop writers and inspect retained copies." }
    }
    $expectedFiles = [ordered]@{ files=@($manifest.files | Sort-Object name | ForEach-Object { [ordered]@{ name=$_.name; size=[long]$_.size; sha256=$_.sha256.ToLowerInvariant() } }) }
    $expectedFilesJson = ConvertTo-Json -InputObject $expectedFiles -Depth 8 -Compress
    $backupFiles = Local-FileInventory (Join-Path $backupPath 'files')
    $nativeFilesAfter = Local-FileInventory (Join-Path $projectRoot '.local/files')
    $dockerFiles = Docker-FileInventory
    foreach ($inventory in @($backupFiles,$nativeFilesAfter,$dockerFiles)) {
        if ((ConvertTo-Json -InputObject $inventory -Depth 8 -Compress) -cne $expectedFilesJson) { throw 'Exact backup/native/Docker file inventory mismatch: names, sizes and hashes must match without extras or omissions.' }
    }
    foreach ($file in Get-ChildItem -LiteralPath $runtimeCredentials -File) {
        $hashLine = Docker-Checked -Arguments @('compose','run','--rm','--no-deps','tools','sha256sum',('.local/' + $file.Name))
        if (($hashLine -split '\s+')[0] -ne (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash) { throw 'Matching local account manifest was not copied intact.' }
    }
    $expectedAccounts = ConvertTo-Json -InputObject $accountBaseline -Depth 8 -Compress
    $accountBackup = Local-FileInventory $runtimeCredentials -SelectedNames $accountNames
    $accountNativeAfter = Local-FileInventory (Join-Path $projectRoot '.local') -SelectedNames $accountNames
    if ((ConvertTo-Json -InputObject $accountBackup -Depth 8 -Compress) -cne $expectedAccounts -or
        (ConvertTo-Json -InputObject $accountNativeAfter -Depth 8 -Compress) -cne $expectedAccounts) { throw 'Native account manifest inventory or hashes changed during transfer.' }
    $filterSql = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'local/source-filter.sql')).Trim().TrimEnd(';')
    $sourceIds = @(Query-Database 'odoo_mock' ("SELECT id FROM ($filterSql) expected ORDER BY id") -Container | ForEach-Object { [int]$_ })
    if (($sourceIds -join ',') -ne ($manifest.source.expectedPickingIds -join ',')) { throw 'Source filter results changed.' }
    $readerSafe = Query-Database 'odoo_mock' "SELECT bool_and(has_table_privilege('odoo_reader',schemaname||'.'||tablename,'SELECT')) AND NOT bool_or(has_table_privilege('odoo_reader',schemaname||'.'||tablename,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) FROM pg_tables WHERE schemaname='public'" -Container
    if ($readerSafe -ne 't') { throw 'Source reader privileges are not strictly read-only.' }
    [ordered]@{
        verified=$true; createdAt=[DateTime]::UtcNow.ToString('o'); project='delivery-backoffice';
        nativePort=55432; dockerPublishedPort=55433; internalPort=55432;
        backupPath=$backupPath; archives=$archiveChecks; snapshots=$restored;
        sourceIds=$sourceIds; physicalFiles=$dockerFiles.files; exactFileInventory=$true; accountManifestHashesUnchanged=$true; sourceReaderReadOnly=$true;
        nativeDataUnchanged=$true; apiStarted=$false
    } | ConvertTo-Json -Depth 25 | Set-Content -LiteralPath (Join-Path $backupPath 'docker-verification.json') -Encoding utf8
    Write-Output "Docker transfer verified: $backupPath"
    Write-Output 'All three databases, complete table rows/sequences, source filter, reader ACL and private file hashes match. Native cluster retained; API not started.'
} finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
