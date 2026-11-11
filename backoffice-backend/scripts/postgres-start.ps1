param(
    [string]$PostgresBin = 'C:/Program Files/PostgreSQL/18/bin',
    [int]$Port = 55432
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$localRoot = Join-Path $projectRoot '.local'
$clusterPath = Join-Path $localRoot 'postgres'
$markerPath = Join-Path $localRoot 'postgres-owner.txt'
$credentialsPath = Join-Path $localRoot 'postgres-credentials.json'
$expectedMarker = "delivery-backoffice-local-v1|$projectRoot|$Port"
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Use an unprivileged local TCP port.' }
foreach ($command in @('initdb.exe','pg_ctl.exe','psql.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $PostgresBin $command))) { throw "PostgreSQL executable missing: $command" }
}
New-Item -ItemType Directory -Path $localRoot -Force | Out-Null
if (Test-Path -LiteralPath $clusterPath) {
    if (-not (Test-Path -LiteralPath $markerPath) -or (Get-Content -Raw -LiteralPath $markerPath).Trim() -ne $expectedMarker) {
        throw 'Refusing to operate on a PostgreSQL directory without the exact task ownership marker.'
    }
} else {
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "Port $Port is already in use; no existing server will be touched." }
    if (Test-Path -LiteralPath $credentialsPath) { throw 'Credentials exist without a cluster; inspect the local state before recovery.' }
    $newPassword = { [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant() }
    $credentials = [ordered]@{ admin = (& $newPassword); app = (& $newPassword); sourceOwner = (& $newPassword); sourceReader = (& $newPassword) }
    $credentials | ConvertTo-Json | Set-Content -LiteralPath $credentialsPath -Encoding utf8
    $credentials.admin | Set-Content -LiteralPath (Join-Path $localRoot 'initdb-password.txt') -Encoding ascii
    try {
        & (Join-Path $PostgresBin 'initdb.exe') -D $clusterPath -U backoffice_local_admin --encoding=UTF8 --locale=C --auth=scram-sha-256 --pwfile (Join-Path $localRoot 'initdb-password.txt')
        if ($LASTEXITCODE -ne 0) { throw 'initdb failed. Inspect only this task-owned .local directory.' }
        $expectedMarker | Set-Content -LiteralPath $markerPath -Encoding utf8
        @("listen_addresses = '127.0.0.1'", "port = $Port", "password_encryption = 'scram-sha-256'") | Add-Content -LiteralPath (Join-Path $clusterPath 'postgresql.conf')
    } finally {
        $passwordPath = Join-Path $localRoot 'initdb-password.txt'
        if (Test-Path -LiteralPath $passwordPath) { Remove-Item -LiteralPath $passwordPath }
    }
}
& (Join-Path $PostgresBin 'pg_ctl.exe') status -D $clusterPath *> $null
if ($LASTEXITCODE -ne 0) {
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "Port $Port is owned by another process; refusing to connect." }
    & (Join-Path $PostgresBin 'pg_ctl.exe') start -D $clusterPath -l (Join-Path $localRoot 'postgres.log') -w -t 30
    if ($LASTEXITCODE -ne 0) { throw 'Task-owned PostgreSQL failed to start.' }
}
$credentials = Get-Content -Raw -LiteralPath $credentialsPath | ConvertFrom-Json
$env:PGPASSWORD = $credentials.admin
try {
    $actual = & (Join-Path $PostgresBin 'psql.exe') -X -h 127.0.0.1 -p $Port -U backoffice_local_admin -d postgres -Atqc 'SHOW data_directory'
    if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($actual.Trim()) -ne $clusterPath) { throw 'PostgreSQL target did not match task-owned data directory.' }
} finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
Write-Output "Task-owned PostgreSQL ready at 127.0.0.1:$Port (data directory verified)."
