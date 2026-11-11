param([string]$PostgresBin = 'C:/Program Files/PostgreSQL/18/bin', [int]$Port = 55432)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'postgres-start.ps1') -PostgresBin $PostgresBin -Port $Port
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$credentials = Get-Content -Raw -LiteralPath (Join-Path $projectRoot '.local/postgres-credentials.json') | ConvertFrom-Json
$psql = Join-Path $PostgresBin 'psql.exe'
$env:PGPASSWORD = $credentials.admin
$env:BACKOFFICE_LOCAL_APP_PASSWORD = $credentials.app
$env:BACKOFFICE_LOCAL_SOURCE_OWNER_PASSWORD = $credentials.sourceOwner
$env:BACKOFFICE_LOCAL_READER_PASSWORD = $credentials.sourceReader
try {
    & $psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $Port -U backoffice_local_admin -d postgres -f (Join-Path $projectRoot 'local/roles.sql')
    if ($LASTEXITCODE -ne 0) { throw 'Creating isolated local roles/databases failed.' }
    $env:PGPASSWORD = $credentials.sourceOwner
    & $psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $Port -U odoo_seed -d odoo_mock -f (Join-Path $projectRoot 'local/source-schema.sql')
    if ($LASTEXITCODE -ne 0) { throw 'Source schema failed.' }
    & $psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $Port -U odoo_seed -d odoo_mock -f (Join-Path $projectRoot 'local/source-seed.sql')
    if ($LASTEXITCODE -ne 0) { throw 'Source seed failed.' }
    $envPath = Join-Path $projectRoot '.env'
    if (-not (Test-Path -LiteralPath $envPath)) {
        @("DATABASE_URL=postgresql://delivery_app:$($credentials.app)@127.0.0.1:$Port/delivery_backoffice", "TEST_DATABASE_URL=postgresql://delivery_app:$($credentials.app)@127.0.0.1:$Port/delivery_backoffice_test", "ODOO_DATABASE_URL=postgresql://odoo_reader:$($credentials.sourceReader)@127.0.0.1:$Port/odoo_mock", 'PORT=3001', 'FRONTEND_ORIGIN=http://127.0.0.1:3000') | Set-Content -LiteralPath $envPath -Encoding utf8
    }
} finally {
    foreach ($name in @('PGPASSWORD','BACKOFFICE_LOCAL_APP_PASSWORD','BACKOFFICE_LOCAL_SOURCE_OWNER_PASSWORD','BACKOFFICE_LOCAL_READER_PASSWORD')) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
}
& (Join-Path $PSScriptRoot 'postgres-verify.ps1') -PostgresBin $PostgresBin -Port $Port
