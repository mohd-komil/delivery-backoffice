param(
    [Parameter(Mandatory)][string]$SourceEndpoint,
    [Parameter(Mandatory)][string]$SourceUser,
    [Parameter(Mandatory)][string]$SourceInstance,
    [ValidateSet('tls', 'internal-lan')][string]$Transport = 'tls',
    [switch]$ApproveInternalLan,
    [string]$SourcePasswordFile,
    [string]$SourceCaFile,
    [string]$SourceAddress,
    [string]$ProjectName = 'delivery-odoo-integration'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'docker-odoo-state.ps1')
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($ProjectName -notmatch '^delivery-odoo-[a-z0-9]+(?:-[a-z0-9]+)*$' -or $ProjectName.Length -gt 60) { throw 'Use a separate delivery-odoo-* project name.' }
if ($Transport -eq 'internal-lan' -and -not $ApproveInternalLan) { throw 'Internal LAN transport needs explicit approval for this local development copy.' }
if ($Transport -ne 'tls' -and $SourceCaFile) { throw 'A source CA file is only valid with TLS.' }
if ($SourceAddress -and $Transport -ne 'internal-lan') { throw 'A local source address override is limited to the approved internal LAN mode.' }
$localRoot = Join-Path $projectRoot '.local'
$integrationRoot = Join-Path $localRoot 'odoo-integration'
$directory = Join-Path $integrationRoot $ProjectName
if (Test-Path -LiteralPath $directory) {
    $existing = Get-OdooConfiguration $projectRoot $ProjectName
    if ($existing.manifest.sourceEndpoint -cne $SourceEndpoint -or $existing.manifest.sourceUser -cne $SourceUser -or
        $existing.manifest.sourceInstance -cne $SourceInstance -or $existing.manifest.transport -cne $Transport -or
        ([string]$existing.manifest['sourceAddress']) -cne $SourceAddress) {
        throw 'This integration project already belongs to another source configuration. Existing credentials and data were retained.'
    }
    Invoke-OdooDocker @('compose', '--project-name', $ProjectName, '--file', $existing.compose, 'config', '--quiet') | Out-Null
    Write-Output 'Existing isolated Odoo configuration verified and retained. No password was replaced and no service was started.'
    exit 0
}
if ($SourcePasswordFile -and $env:BACKOFFICE_ODOO_SOURCE_PASSWORD) { throw 'Provide the source password by one mechanism only: private file or BACKOFFICE_ODOO_SOURCE_PASSWORD.' }
$sourcePassword = if ($SourcePasswordFile) {
    Assert-OdooOrdinaryPath $SourcePasswordFile $false
    [IO.File]::ReadAllText((Resolve-Path -LiteralPath $SourcePasswordFile).Path).TrimEnd([char]10, [char]13)
} else { $env:BACKOFFICE_ODOO_SOURCE_PASSWORD }
if ([string]::IsNullOrWhiteSpace($sourcePassword) -or $sourcePassword.Length -gt 1024 -or $sourcePassword.IndexOfAny([char[]]@([char]0, [char]10, [char]13)) -ge 0) {
    throw 'A source password is required in a private file or BACKOFFICE_ODOO_SOURCE_PASSWORD. Do not place it in command arguments.'
}
if ($SourceCaFile) { Assert-OdooOrdinaryPath $SourceCaFile $false }
$endpoint = $null
if (-not [Uri]::TryCreate($SourceEndpoint, [UriKind]::Absolute, [ref]$endpoint) -or $endpoint.Scheme -cne 'postgresql' -or $endpoint.UserInfo -ne '') {
    throw 'Use a credential-free approved postgresql://hostname:port/database endpoint.'
}
if ($SourceAddress) {
    $address = $null
    if (-not [Net.IPAddress]::TryParse($SourceAddress, [ref]$address) -or $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
        $address.ToString() -cne $SourceAddress -or -not $endpoint.DnsSafeHost.EndsWith('.local', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'A source address override must map the exact approved .local hostname to a canonical RFC1918 IPv4 address.'
    }
    $bytes = $address.GetAddressBytes()
    if (-not ($bytes[0] -eq 10 -or ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or ($bytes[0] -eq 192 -and $bytes[1] -eq 168))) {
        throw 'A source address override cannot point outside RFC1918 IPv4 ranges.'
    }
}
$sourceUrl = 'postgresql://' + [Uri]::EscapeDataString($SourceUser) + ':' + [Uri]::EscapeDataString($sourcePassword) + '@' + $SourceEndpoint.Substring('postgresql://'.Length)
$sourcePassword = $null
$secrets = [ordered]@{}
foreach ($name in @('admin_password', 'app_password', 'source_owner_password', 'source_reader_password')) {
    $secrets[$name] = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()
}
$secrets.database_url = 'postgresql://delivery_app:' + $secrets.app_password + '@db:55432/delivery_backoffice'
$secrets.test_database_url = 'postgresql://delivery_app:' + $secrets.app_password + '@db:55432/delivery_backoffice_test'
$secrets.odoo_database_url = $sourceUrl
$sourceUrl = $null
$applicationEnvironment = [ordered]@{
    BACKOFFICE_RUNTIME = 'docker'; BACKOFFICE_TEST = '0'; PORT = '3001'
    FRONTEND_ORIGIN = 'http://127.0.0.1:3030'; CREW_FRONTEND_ORIGIN = 'http://127.0.0.1:3032'
    ROUTE_PUBLICATION_ENABLED = 'true'; ODOO_SOURCE_MODE = 'odoo18'; ODOO_SOURCE_INSTANCE = $SourceInstance
    ODOO_SOURCE_ALLOWED_ENDPOINT = $SourceEndpoint; ODOO_SOURCE_USER = $SourceUser; ODOO_SOURCE_TRANSPORT = $Transport
}
if ($SourceCaFile) { $applicationEnvironment.ODOO_SOURCE_CA_FILE = '/run/secrets/source_ca' }
# Reuse the actual pure application validator before writing configuration; no source connection occurs.
$validationEnvironment = @{}
foreach ($entry in $applicationEnvironment.GetEnumerator()) { $validationEnvironment[$entry.Key] = $entry.Value }
$validationEnvironment.DATABASE_URL = $secrets.database_url
$validationEnvironment.TEST_DATABASE_URL = $secrets.test_database_url
$validationEnvironment.ODOO_DATABASE_URL = $secrets.odoo_database_url
$validationEnvironment.ODOO_SOURCE_CA_FILE = if ($SourceCaFile) { '/run/secrets/source_ca' } else { $null }
$previous = @{}
Push-Location $projectRoot
try {
    foreach ($key in $validationEnvironment.Keys) {
        $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        if ($null -eq $validationEnvironment[$key]) { Remove-Item -LiteralPath ('Env:' + $key) -ErrorAction SilentlyContinue }
        else { [Environment]::SetEnvironmentVariable($key, $validationEnvironment[$key], 'Process') }
    }
    & node --require tsx/cjs -e 'try { require("./src/config").parseEnvironment(process.env); } catch(error) { if(error instanceof require("zod").ZodError) process.stderr.write("Rejected configuration fields: " + error.issues.map(issue=>issue.path.join(".")).join(", ") + "\n"); process.exit(1); }'
    if ($LASTEXITCODE -ne 0) { throw 'The application rejected the source configuration. No private integration files were created.' }
} finally {
    foreach ($key in $previous.Keys) {
        if ($null -eq $previous[$key]) { Remove-Item -LiteralPath ('Env:' + $key) -ErrorAction SilentlyContinue }
        else { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
    }
    Pop-Location
}
$containers = @(Invoke-OdooDocker @('ps', '-a', '--filter', ('label=com.docker.compose.project=' + $ProjectName), '--format', '{{.ID}}'))
$volumes = @(Invoke-OdooDocker @('volume', 'ls', '--format', '{{.Name}}'))
$networks = @(Invoke-OdooDocker @('network', 'ls', '--format', '{{.Name}}'))
if ($containers.Count -or ($ProjectName + '_pg-data') -in $volumes -or ($ProjectName + '_app-data') -in $volumes -or
    ($ProjectName + '_default') -in $networks -or ($ProjectName + '_source-access') -in $networks) {
    throw 'The requested project already has Docker resources without this configuration. Existing resources will not be adopted.'
}
foreach ($path in @($localRoot, $integrationRoot)) {
    if (Test-Path -LiteralPath $path) { Assert-OdooOrdinaryPath $path $true }
    else { New-OdooPrivateDirectory $path }
}
New-OdooPrivateDirectory $directory
$secretDirectory = Join-Path $directory 'secrets'
New-OdooPrivateDirectory $secretDirectory
$composeSecrets = [ordered]@{}
foreach ($entry in $secrets.GetEnumerator()) {
    $path = Join-Path $secretDirectory $entry.Key
    Write-OdooPrivateFile $path $entry.Value
    $composeSecrets[$entry.Key] = @{ file = $path }
}
$secrets.Clear()
$connectionSecrets = @('database_url', 'test_database_url', 'odoo_database_url')
if ($SourceCaFile) {
    $caPath = Join-Path $secretDirectory 'source_ca'
    Write-OdooPrivateFile $caPath ([IO.File]::ReadAllText((Resolve-Path -LiteralPath $SourceCaFile).Path))
    $composeSecrets.source_ca = @{ file = $caPath }
    $connectionSecrets += 'source_ca'
}
function New-OdooApplicationService([bool]$Runtime) {
    $environment = [ordered]@{}
    foreach ($entry in $applicationEnvironment.GetEnumerator()) { $environment[$entry.Key] = $entry.Value }
    $environment.NODE_ENV = if ($Runtime) { 'production' } else { 'development' }
    $service = [ordered]@{
        image = $ProjectName + $(if ($Runtime) { '-backend:0.1.0' } else { '-tools:0.1.0' })
        build = @{ context = $projectRoot; target = $(if ($Runtime) { 'runtime' } else { 'tools' }) }
        init = $true; environment = $environment; secrets = $connectionSecrets
        volumes = @(@{ type = 'volume'; source = 'app-data'; target = '/app/.local' })
        security_opt = @('no-new-privileges:true'); cap_drop = @('ALL')
        networks = @('default', 'source-access')
        depends_on = @{ db = @{ condition = 'service_healthy' } }
    }
    if ($SourceAddress) { $service.extra_hosts = @{ $endpoint.DnsSafeHost = $SourceAddress } }
    return $service
}
$backend = New-OdooApplicationService $true
$backend.restart = 'unless-stopped'; $backend.read_only = $true; $backend.tmpfs = @('/tmp')
$backend.ports = @('127.0.0.1:3031:3001')
$backend.depends_on.migrate = @{ condition = 'service_completed_successfully' }
$backend.healthcheck = @{
    test = @('CMD', 'node', '-e', "fetch('http://127.0.0.1:3001/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))")
    interval = '10s'; timeout = '5s'; retries = 6; start_period = '15s'
}
$migrate = New-OdooApplicationService $false
$migrate.command = @('npm', 'run', 'migrate'); $migrate.restart = 'no'
$toolsService = New-OdooApplicationService $false
$toolsService.profiles = @('tools')
$compose = [ordered]@{
    name = $ProjectName
    services = [ordered]@{
        db = [ordered]@{
            image = 'postgres:18.6-bookworm'; restart = 'unless-stopped'; command = @('postgres', '-p', '55432')
            environment = @{
                POSTGRES_USER = 'backoffice_local_admin'; POSTGRES_DB = 'postgres'; PGPORT = '55432'
                POSTGRES_PASSWORD_FILE = '/run/secrets/admin_password'
                POSTGRES_INITDB_ARGS = '--encoding=UTF8 --locale=C --auth-host=scram-sha-256'
            }
            secrets = @('admin_password', 'app_password', 'source_owner_password', 'source_reader_password')
            volumes = @(
                @{ type = 'volume'; source = 'pg-data'; target = '/var/lib/postgresql' },
                @{ type = 'bind'; source = (Join-Path $projectRoot 'docker/postgres-init.sh'); target = '/docker-entrypoint-initdb.d/10-backoffice.sh'; read_only = $true },
                @{ type = 'bind'; source = (Join-Path $projectRoot 'local'); target = '/opt/backoffice/local'; read_only = $true }
            )
            networks = @('default')
            healthcheck = @{
                test = @('CMD', 'pg_isready', '-h', '127.0.0.1', '-p', '55432', '-U', 'backoffice_local_admin', '-d', 'postgres')
                interval = '5s'; timeout = '3s'; retries = 12; start_period = '15s'
            }
        }
        migrate = $migrate; backend = $backend; tools = $toolsService
    }
    volumes = @{ 'pg-data' = @{}; 'app-data' = @{} }
    networks = @{ default = @{ internal = $true }; 'source-access' = @{} }
    secrets = $composeSecrets
}
$composePath = Join-Path $directory 'compose.yaml'
# Compose accepts JSON as YAML; escape dollar literals so no host variable is interpolated.
Write-OdooPrivateFile $composePath ((ConvertTo-Json -InputObject $compose -Depth 30).Replace('$', '$$'))
Invoke-OdooDocker @('compose', '--project-name', $ProjectName, '--file', $composePath, 'config', '--quiet') | Out-Null
$files = [ordered]@{ 'compose.yaml' = (Get-FileHash -LiteralPath $composePath -Algorithm SHA256).Hash.ToLowerInvariant() }
foreach ($name in $composeSecrets.Keys) { $files['secrets/' + $name] = (Get-FileHash -LiteralPath (Join-Path $secretDirectory $name) -Algorithm SHA256).Hash.ToLowerInvariant() }
$manifest = [ordered]@{
    formatVersion = 1; project = $ProjectName; apiPort = 3031; manualImportsOnly = $true
    sourceEndpoint = $SourceEndpoint; sourceUser = $SourceUser; sourceInstance = $SourceInstance; transport = $Transport; sourceAddress = $SourceAddress
    createdAt = [DateTime]::UtcNow.ToString('o'); files = $files
}
Write-OdooPrivateFile (Join-Path $directory 'manifest.json') (ConvertTo-Json -InputObject $manifest -Depth 10)
Get-OdooConfiguration $projectRoot $ProjectName | Out-Null
Write-Output 'Isolated Odoo configuration validated and saved privately. No service was started; no source connection was made.'
