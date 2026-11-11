param([string]$PostgresBin = 'C:/Program Files/PostgreSQL/18/bin', [int]$Port = 55432)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'postgres-start.ps1') -PostgresBin $PostgresBin -Port $Port
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$credentials = Get-Content -Raw -LiteralPath (Join-Path $projectRoot '.local/postgres-credentials.json') | ConvertFrom-Json
$psql = Join-Path $PostgresBin 'psql.exe'
$env:PGPASSWORD = $credentials.sourceReader
try {
    & $psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $Port -U odoo_reader -d odoo_mock -f (Join-Path $projectRoot 'local/source-assertions.sql')
    if ($LASTEXITCODE -ne 0) { throw 'Source fixture or read permissions verification failed.' }
    $denied = 'SET default_transaction_read_only=off; UPDATE stock_picking SET name=name WHERE false;' | & $psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $Port -U odoo_reader -d odoo_mock 2>&1
    if ($LASTEXITCODE -eq 0 -or ($denied -join ' ') -notmatch 'permission denied') { throw 'Expected an actual PostgreSQL write-permission rejection.' }
    Write-Output 'PASS: reader UPDATE rejected by PostgreSQL grants even when transaction read-only is disabled.'
    $deniedDatabase = & $psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $Port -U odoo_reader -d delivery_backoffice -c 'SELECT current_database()' 2>&1
    if ($LASTEXITCODE -eq 0 -or ($deniedDatabase -join ' ') -notmatch 'permission denied') { throw 'Source reader should not connect to app DB.' }
    Write-Output 'PASS: source reader cannot connect to the application database.'
} finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
