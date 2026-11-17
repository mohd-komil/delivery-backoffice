param(
    [Parameter(Mandatory = $true)][string]$BackupDirectory,
    [ValidateRange(1024, 65535)][int]$ApiPort = 3021
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'docker-state.ps1')

# This restores only into a new project. It never stops, starts, queries or mounts
# the current project's data, and it deliberately leaves the restored API stopped.
function Assert-OrdinaryPath([string]$Path, [bool]$Directory) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -ne $Directory -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Recovery paths must be ordinary files/directories, not links.'
    }
}
function Write-PrivateDirectory([string]$Path) {
    New-Item -ItemType Directory -Path $Path | Out-Null
    if ($IsWindows) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
        if ($null -eq $identity) { throw 'Unable to establish the private restore owner.' }
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($sid in @($identity, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                $sid, [Security.AccessControl.FileSystemRights]::FullControl,
                [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
                [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
        }
        Set-Acl -LiteralPath $Path -AclObject $acl
    } else {
        [IO.File]::SetUnixFileMode($Path, [IO.UnixFileMode]'UserRead,UserWrite,UserExecute')
    }
}
function Json-Text($Value) { return ConvertTo-Json -InputObject $Value -Depth 40 -Compress }
function Write-Json([string]$Path, $Value) {
    ConvertTo-Json -InputObject $Value -Depth 40 | Set-Content -LiteralPath $Path -Encoding utf8
}
function Resolve-Image([string]$Reference) {
    $id = Docker-Checked -Arguments @('image', 'inspect', '--format', '{{.Id}}', $Reference)
    if ($id -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Recovery requires an existing immutable local image ID.' }
    return [string]$id
}
function Assert-Hash([string]$Path, [string]$Expected) {
    Assert-OrdinaryPath $Path $false
    if ($Expected -notmatch '^[a-fA-F0-9]{64}$' -or
        (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ine $Expected) {
        throw ('Backup hash verification failed for ' + [IO.Path]::GetFileName($Path) + '.')
    }
}

$backupRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.local/backups'))
$backupPath = if ([IO.Path]::IsPathRooted($BackupDirectory)) {
    [IO.Path]::GetFullPath($BackupDirectory)
} else { [IO.Path]::GetFullPath((Join-Path $projectRoot $BackupDirectory)) }
Assert-OrdinaryPath (Join-Path $projectRoot '.local') $true
Assert-OrdinaryPath $backupRoot $true
$backupParent = [IO.Path]::GetDirectoryName($backupPath.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar))
if (-not [string]::Equals($backupParent, $backupRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Select one completed backup directly inside this project .local/backups directory.'
}
Assert-OrdinaryPath $backupPath $true
$manifestPath = Join-Path $backupPath 'docker-backup-manifest.json'
Assert-OrdinaryPath $manifestPath $false
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -AsHashtable
if ($manifest.formatVersion -ne 1 -or $manifest.project -cne 'delivery-backoffice' -or
    $manifest.writersStopped -ne $true -or $manifest.containsPrivateRecoverySecrets -ne $true -or
    $manifest.backupId -cne [IO.Path]::GetFileName($backupPath) -or
    $manifest.backupId -notmatch '^docker_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{8}$' -or
    $manifest.serverVersion -notmatch '^18\.6(?:\s|$)') {
    throw 'Expected a completed stopped-writer Docker PostgreSQL 18.6 backup manifest.'
}
$databases = @('delivery_backoffice', 'odoo_mock', 'delivery_backoffice_test')
$archiveNames = @('application.dump', 'source.dump', 'test.dump', 'globals.sql', 'app-data.tar')
if ((@($manifest.archives.Keys | Sort-Object) -join '|') -cne (@($archiveNames | Sort-Object) -join '|')) {
    throw 'Backup archive inventory is unexpected.'
}
foreach ($name in $archiveNames) { Assert-Hash (Join-Path $backupPath $name) $manifest.archives[$name] }
foreach ($database in $databases) {
    if (-not $manifest.snapshots.Contains($database) -or -not $manifest.structures.Contains($database)) {
        throw 'Backup is missing a required database snapshot.'
    }
}
$backupSecrets = Join-Path $backupPath 'secrets'
Assert-OrdinaryPath $backupSecrets $true
$secretNames = @('admin_password', 'app_password', 'source_owner_password', 'source_reader_password', 'database_url', 'test_database_url', 'odoo_database_url')
if ((@($manifest.recoverySecrets | ForEach-Object { $_.name } | Sort-Object) -join '|') -cne
    (@($secretNames | Sort-Object) -join '|')) { throw 'Recovery secret inventory is unexpected.' }
foreach ($secret in $manifest.recoverySecrets) {
    $path = Join-Path $backupSecrets $secret.name
    Assert-Hash $path $secret.sha256
    if ((Get-Item -LiteralPath $path).Length -ne $secret.size -or $secret.size -le 0) {
        throw 'Recovery secret size differs from the completed backup.'
    }
}
foreach ($connection in @(@('database_url', 'delivery_backoffice', 'delivery_app'),
        @('test_database_url', 'delivery_backoffice_test', 'delivery_app'), @('odoo_database_url', 'odoo_mock', 'odoo_reader'))) {
    $uri = [Uri](Get-Content -LiteralPath (Join-Path $backupSecrets $connection[0]) -Raw).Trim()
    if ($uri.Scheme -notin @('postgres', 'postgresql') -or $uri.Host -cne 'db' -or $uri.Port -ne 55432 -or
        $uri.AbsolutePath -cne ('/' + $connection[1]) -or $uri.UserInfo.Split(':')[0] -cne $connection[2] -or
        $uri.Query -ne '' -or $uri.Fragment -ne '') { throw 'Recovery connections must use only the isolated db service and expected roles/databases.' }
}
$bootstrapRole = 'restore_bootstrap'
if ((Get-Content -LiteralPath (Join-Path $backupPath 'globals.sql') -Raw).Contains($bootstrapRole)) {
    throw 'The backup globals already mention the reserved recovery bootstrap role.'
}
if ($ApiPort -in @(3000, 3001, 3002, 3010, 3011, 3012, 55432, 55433)) {
    throw 'The recovery API port must not reuse a current application, demo or database port.'
}
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $ApiPort)
try { $listener.Start() } finally { $listener.Stop() }

# Resolve tags once; the Compose file and temporary tools then use the actual IDs.
$images = [ordered]@{
    postgres = Resolve-Image 'postgres:18.6-bookworm'
    backend = Resolve-Image 'delivery-backoffice-backend:0.1.0'
    tools = Resolve-Image 'delivery-backoffice-tools:0.1.0'
}
$runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '_' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$project = 'delivery-restore-' + $runId.ToLowerInvariant().Replace('_', '-')
$pgVolume = $project + '_pg-data'
$appVolume = $project + '_app-data'
$network = $project + '_default'
$hostNetwork = $project + '_host-access'
$existingVolumes = @(Docker-Checked -Arguments @('volume', 'ls', '--format', '{{.Name}}'))
$existingNetworks = @(Docker-Checked -Arguments @('network', 'ls', '--format', '{{.Name}}'))
$existingContainers = @(Docker-Checked -Arguments @('ps', '-a', '--filter', ('label=com.docker.compose.project=' + $project), '--format', '{{.ID}}'))
if ($pgVolume -in $existingVolumes -or $appVolume -in $existingVolumes -or $network -in $existingNetworks -or
    $hostNetwork -in $existingNetworks -or $existingContainers.Count) {
    throw 'The generated recovery project already exists; existing targets will never be reused.'
}
$restoreRoot = Join-Path $projectRoot '.local/restore-checks'
if (-not (Test-Path -LiteralPath $restoreRoot)) { New-Item -ItemType Directory -Path $restoreRoot | Out-Null }
Assert-OrdinaryPath $restoreRoot $true
$runDirectory = Join-Path $restoreRoot $runId
Write-PrivateDirectory $runDirectory
$secretDirectory = Join-Path $runDirectory 'secrets'
New-Item -ItemType Directory -Path $secretDirectory | Out-Null
$bootstrapPassword = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(36))
[IO.File]::WriteAllText((Join-Path $secretDirectory 'bootstrap_password'), $bootstrapPassword, [Text.UTF8Encoding]::new($false))
$bootstrapPassword = $null
foreach ($secret in $manifest.recoverySecrets) {
    Copy-Item -LiteralPath (Join-Path $backupSecrets $secret.name) -Destination (Join-Path $secretDirectory $secret.name)
    Assert-Hash (Join-Path $secretDirectory $secret.name) $secret.sha256
}
$composePath = Join-Path $runDirectory 'compose.yaml'
$composeArguments = @('--project-name', $project, '--file', $composePath)
$connections = @('database_url', 'test_database_url', 'odoo_database_url')
$secrets = [ordered]@{ bootstrap_password = @{ file = (Join-Path $secretDirectory 'bootstrap_password') } }
foreach ($name in $connections) { $secrets[$name] = @{ file = (Join-Path $secretDirectory $name) } }
$compose = [ordered]@{
    name = $project
    services = [ordered]@{
        db = [ordered]@{
            image = $images.postgres
            restart = 'unless-stopped'
            command = @('postgres', '-p', '55432')
            environment = @{
                POSTGRES_USER = $bootstrapRole; POSTGRES_DB = 'postgres'; PGPORT = '55432'
                POSTGRES_PASSWORD_FILE = '/run/secrets/bootstrap_password'
                POSTGRES_INITDB_ARGS = '--encoding=UTF8 --locale=C --auth-host=scram-sha-256'
            }
            secrets = @('bootstrap_password')
            volumes = @(
                @{ type = 'volume'; source = 'pg-data'; target = '/var/lib/postgresql' },
                @{ type = 'bind'; source = $backupPath; target = '/restore-backup'; read_only = $true }
            )
            healthcheck = @{
                test = @('CMD', 'pg_isready', '-h', '127.0.0.1', '-p', '55432', '-U', $bootstrapRole, '-d', 'postgres')
                interval = '5s'; timeout = '3s'; retries = 12; start_period = '15s'
            }
        }
        backend = [ordered]@{
            image = $images.backend; profiles = @('restored'); init = $true; restart = 'unless-stopped'
            read_only = $true; tmpfs = @('/tmp'); cap_drop = @('ALL'); security_opt = @('no-new-privileges:true')
            environment = @{
                BACKOFFICE_RUNTIME = 'docker'; NODE_ENV = 'production'; PORT = '3001'
                FRONTEND_ORIGIN = 'http://127.0.0.1:3000'; CREW_FRONTEND_ORIGIN = 'http://127.0.0.1:3002'
                ROUTE_PUBLICATION_ENABLED = 'true'
            }
            secrets = $connections
            volumes = @(@{ type = 'volume'; source = 'app-data'; target = '/app/.local'; volume = @{ nocopy = $true } })
            ports = @('127.0.0.1:' + $ApiPort + ':3001')
            # Docker suppresses published ports for an internal-only container.
            # Only the API joins this second project-owned bridge; PostgreSQL
            # remains exclusively on the internal database network.
            networks = @('default', 'host-access')
            depends_on = @{ db = @{ condition = 'service_healthy' } }
            healthcheck = @{
                test = @('CMD', 'node', '-e', "fetch('http://127.0.0.1:3001/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))")
                interval = '10s'; timeout = '5s'; retries = 6; start_period = '15s'
            }
        }
    }
    volumes = @{ 'pg-data' = @{}; 'app-data' = @{} }
    networks = @{ default = @{ internal = $true }; 'host-access' = @{ driver = 'bridge' } }
    secrets = $secrets
}
Write-Json $composePath $compose
Write-Json (Join-Path $runDirectory 'expected-app-data.json') $manifest.appData
$metadata = [ordered]@{
    formatVersion = 1; createdAt = [DateTime]::UtcNow.ToString('o'); project = $project; backupId = $manifest.backupId
    backupDirectory = $backupPath; composeFile = $composePath; composeArguments = $composeArguments
    apiPort = $ApiPort; apiUrl = ('http://127.0.0.1:' + $ApiPort + '/api'); images = $images
    volumes = @($pgVolume, $appVolume); network = $network; hostNetwork = $hostNetwork
    backendStarted = $false; externalDemoFileBindingsIncluded = $false
}
Write-Json (Join-Path $runDirectory 'run.json') $metadata

function Restore-Compose([string[]]$Command) {
    Docker-Checked -Arguments (@('compose') + $composeArguments + $Command)
}
function Assert-RestoreTarget {
    $container = Restore-Compose @('ps', '-q', 'db')
    if ($container -notmatch '^[a-f0-9]{12,64}$') { throw 'Expected exactly one recovery database container.' }
    $inspection = (Docker-Checked -Arguments @('inspect', $container) | ConvertFrom-Json)[0]
    if ($inspection.Config.Labels.'com.docker.compose.project' -cne $project -or $inspection.Image -cne $images.postgres) {
        throw 'Recovery database identity differs from this run.'
    }
    $mounts = @($inspection.Mounts | Where-Object { $_.Type -eq 'volume' })
    if ($mounts.Count -ne 1 -or $mounts[0].Name -cne $pgVolume -or $mounts[0].Destination -cne '/var/lib/postgresql') {
        throw 'Recovery database does not use its new dedicated volume.'
    }
    if (@($inspection.Mounts | Where-Object { $_.Destination.StartsWith('/var/lib/postgresql/') }).Count -ne 0) {
        throw 'Recovery database has an unexpected nested data mount.'
    }
    $networks = @($inspection.NetworkSettings.Networks.PSObject.Properties.Name)
    if ($networks.Count -ne 1 -or $networks[0] -cne $network) { throw 'Recovery database network is not isolated.' }
    foreach ($name in @($pgVolume, $appVolume)) {
        $label = Docker-Checked -Arguments @('volume', 'inspect', '--format', '{{index .Labels "com.docker.compose.project"}}', $name)
        if ($label -cne $project) { throw 'Recovery volume belongs to another project.' }
    }
    $networkState = (Docker-Checked -Arguments @('network', 'inspect', $network) | ConvertFrom-Json)[0]
    if ($networkState.Internal -ne $true -or $networkState.Labels.'com.docker.compose.project' -cne $project) {
        throw 'Recovery network must be internal and owned by this project.'
    }
}

$fileRestoreScript = @'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const expected = JSON.parse(fs.readFileSync('/run-data/expected-app-data.json', 'utf8').replace(/^\uFEFF/, ''));
function safeName(name) {
  if (typeof name !== 'string' || !name || /[\\\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || name.includes(':') || name.split('/').some(p => !p || p === '.' || p === '..')) throw Error('Unsafe backup path');
  return name;
}
if (!Array.isArray(expected.directories) || !Array.isArray(expected.files)) throw Error('Invalid app-data inventory');
const expectedEntries = new Map([['./', 'd']]);
for (const name of expected.directories) {
  const entry = './' + safeName(name) + '/';
  if (expectedEntries.has(entry)) throw Error('Duplicate directory in backup');
  expectedEntries.set(entry, 'd');
}
for (const file of expected.files) {
  const entry = './' + safeName(file.name);
  if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[0-9a-f]{64}$/.test(file.sha256) || expectedEntries.has(entry) || expectedEntries.has(entry + '/')) throw Error('Invalid file in backup');
  expectedEntries.set(entry, '-');
}
const entries = cp.execFileSync('tar', ['-tf', '/backup/app-data.tar'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trimEnd().split('\n');
const types = cp.execFileSync('tar', ['-tvf', '/backup/app-data.tar'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trimEnd().split('\n').map(line => line[0]);
if (entries.length !== expectedEntries.size || new Set(entries).size !== entries.length || entries.length !== types.length) throw Error('Archive entry count differs from manifest');
entries.forEach((entry, index) => { if (expectedEntries.get(entry) !== types[index]) throw Error('Archive names/types differ; links and special files are forbidden'); });
if (fs.readdirSync('/data').length !== 0) throw Error('Recovery app-data volume is not empty');
cp.execFileSync('tar', ['--extract', '--file', '/backup/app-data.tar', '--directory', '/data', '--no-same-owner', '--no-same-permissions', '--delay-directory-restore']);
const actual = { directories: [], files: [] };
function walk(relative) {
  const full = path.join('/data', relative), entry = fs.lstatSync(full);
  if (entry.isSymbolicLink()) throw Error('Restored data contains a link');
  if (entry.isDirectory()) {
    if (relative) actual.directories.push(relative);
    for (const name of fs.readdirSync(full).sort()) walk(path.posix.join(relative, name));
    fs.chmodSync(full, 0o700);
    fs.chownSync(full, 1000, 1000);
  } else if (entry.isFile()) {
    actual.files.push({ name: relative, size: entry.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') });
    fs.chmodSync(full, 0o600);
    fs.chownSync(full, 1000, 1000);
  } else throw Error('Restored data contains a special entry');
}
walk('');
if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Restored app-data names, sizes or hashes differ');
fs.writeFileSync('/run-data/restored-app-data.json', JSON.stringify(actual, null, 2));
process.stdout.write('Restored application files match the complete backup inventory.\n');
'@

$phase = 'compose_validation'
try {
    Restore-Compose @('config', '--quiet')
    $phase = 'create_isolated_database'
    Restore-Compose @('up', '-d', '--wait', '--wait-timeout', '120', 'db')
    Docker-Checked -Arguments @('volume', 'create', '--label', ('com.docker.compose.project=' + $project),
        '--label', 'com.docker.compose.volume=app-data', $appVolume) | Out-Null
    Assert-RestoreTarget
    $existingDatabases = Restore-Compose @('exec', '-T', 'db', 'psql', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1',
        '-U', $bootstrapRole, '-d', 'postgres', '-c', "SELECT datname FROM pg_database WHERE datname NOT IN ('postgres','template0','template1') ORDER BY datname")
    if (@($existingDatabases | Where-Object { $_ -ne '' }).Count) { throw 'Recovery database cluster was not empty.' }
    $phase = 'restore_globals'
    # Suppress SQL diagnostics: a failing ALTER ROLE can include a password hash.
    $globalsOutput = & docker compose @composeArguments exec -T db psql -X -q -v ON_ERROR_STOP=1 -U $bootstrapRole -d postgres -f /restore-backup/globals.sql 2>&1
    if ($LASTEXITCODE -ne 0) {
        $globalsOutput | Set-Content -LiteralPath (Join-Path $runDirectory 'private-globals-restore-error.txt') -Encoding utf8
        throw 'Globals restoration failed; private diagnostics retained in this run directory.'
    }
    $globalsOutput = $null
    foreach ($entry in @(@('delivery_backoffice', 'application.dump'), @('odoo_mock', 'source.dump'), @('delivery_backoffice_test', 'test.dump'))) {
        $phase = 'restore_' + $entry[0]
        Assert-RestoreTarget
        Restore-Compose @('exec', '-T', 'db', 'pg_restore', '--list', ('/restore-backup/' + $entry[1])) | Out-Null
        Restore-Compose @('exec', '-T', 'db', 'pg_restore', '--exit-on-error', '--create', '-U', $bootstrapRole,
            '--dbname', 'postgres', ('/restore-backup/' + $entry[1]))
    }
    $phase = 'restore_files'
    Docker-Checked -Arguments @('run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
        '--security-opt', 'no-new-privileges:true', '--user', '0:0',
        '--mount', ('type=volume,src=' + $appVolume + ',dst=/data'),
        '--mount', ('type=bind,src=' + $backupPath + ',dst=/backup,readonly'),
        '--mount', ('type=bind,src=' + $runDirectory + ',dst=/run-data'),
        '--entrypoint', 'node', $images.tools, '-e', $fileRestoreScript)
    $phase = 'verify_database_content'
    $actualSnapshots = [ordered]@{}
    $actualStructures = [ordered]@{}
    $differences = @()
    foreach ($database in $databases) {
        $actualSnapshots[$database] = Database-Snapshot $database -Container -ComposeArguments $composeArguments
        $actualStructures[$database] = Database-StructureSnapshot $database -ComposeArguments $composeArguments
        if ((Json-Text $manifest.snapshots[$database]) -cne (Json-Text $actualSnapshots[$database])) {
            $differences += [ordered]@{ database = $database; category = 'rows_and_sequences'; expected = $manifest.snapshots[$database]; actual = $actualSnapshots[$database] }
        }
        if ((Json-Text $manifest.structures[$database]) -cne (Json-Text $actualStructures[$database])) {
            foreach ($section in $manifest.structures[$database].Keys) {
                $actualSection = $actualStructures[$database].$section
                if ((Json-Text $manifest.structures[$database][$section]) -cne (Json-Text $actualSection)) {
                    $differences += [ordered]@{ database = $database; category = ('structure_' + $section); expected = $manifest.structures[$database][$section]; actual = $actualSection }
                }
            }
        }
    }
    Write-Json (Join-Path $runDirectory 'restored-database-snapshots.json') $actualSnapshots
    Write-Json (Join-Path $runDirectory 'restored-database-structures.json') $actualStructures
    Write-Json (Join-Path $runDirectory 'differences.json') @($differences)
    $phase = 'verify_file_records'
    $recordsSql = "SELECT COALESCE(json_agg(t ORDER BY id),'[]'::json)::text FROM (SELECT id::text,size,status FROM public.file_record) t"
    $recordJson = Query-Database 'delivery_backoffice' $recordsSql -Container -ComposeArguments $composeArguments
    $records = ($recordJson -join "`n") | ConvertFrom-Json -NoEnumerate
    $filesByName = @{}
    foreach ($file in $manifest.appData.files) { $filesByName[$file.name] = $file }
    $readyCount = 0
    foreach ($record in $records) {
        if ($record.status -eq 'ready') {
            $readyCount += 1
            $filename = 'files/' + $record.id
            if (-not $filesByName.ContainsKey($filename)) { throw 'A ready application file has no restored private bytes.' }
            if ($filesByName[$filename].size -ne $record.size) { throw 'A ready application file size does not match restored metadata.' }
        }
    }
    $result = [ordered]@{
        formatVersion = 1; checkedAt = [DateTime]::UtcNow.ToString('o'); project = $project; backupId = $manifest.backupId
        status = $(if ($differences.Count) { 'database_comparison_requires_review' } else { 'restored_and_verified' })
        databases = $databases; databaseDifferences = $differences.Count; fileInventoryMatches = $true
        readyApplicationFilesVerified = $readyCount; applicationFileRecords = @($records).Count
        physicalApplicationFiles = @($manifest.appData.files).Count; backendStarted = $false
        externalDemoFileBindingsIncluded = $false
        scope = 'Three database archives and main app-data only. Separate host-bound demo evidence is not included.'
    }
    Write-Json (Join-Path $runDirectory 'verification.json') $result
    if ($differences.Count) {
        throw 'Restoration retained, but database differences require review. Inspect differences.json; the API was not started.'
    }
    Write-Output ('Restore verified in separate project: ' + $project)
    Write-Output ('Report: ' + (Join-Path $runDirectory 'verification.json'))
    Write-Output 'The restored backend is still stopped. No main containers, databases or volumes were changed.'
} catch {
    Write-Json (Join-Path $runDirectory 'failure.json') ([ordered]@{
        occurredAt = [DateTime]::UtcNow.ToString('o'); phase = $phase; project = $project
        resourcesRetained = $true; backendStarted = $false
        instruction = 'Inspect this run and its private diagnostics. Do not reset, reuse or delete current data to retry.'
    })
    throw
}
