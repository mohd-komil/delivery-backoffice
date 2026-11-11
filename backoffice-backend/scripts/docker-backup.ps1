param([switch]$WritersStopped)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
. (Join-Path $PSScriptRoot 'docker-state.ps1')
if (-not $WritersStopped) { throw 'Stop Docker backend/importer/tests/tools/source writers, then pass -WritersStopped. Databases and files do not share a transaction.' }
Docker-Checked -Arguments @('compose','config','--quiet')
$running = @(& docker compose ps --status running --services)
if ($LASTEXITCODE -ne 0 -or 'db' -notin $running -or @($running | Where-Object { $_ -ne 'db' }).Count) { throw 'Only db may be running in this Compose project during a joint backup.' }
$dbContainer = & docker compose ps -q db
$projectLabel = & docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' $dbContainer
if ($LASTEXITCODE -ne 0 -or $projectLabel -ne 'delivery-backoffice') { throw 'Backup requires the exact task-owned Compose project.' }
if ((Query-Database 'postgres' 'SHOW data_directory' -Container) -ne '/var/lib/postgresql/18/docker' -or
    (Query-Database 'postgres' 'SHOW port' -Container) -ne '55432') { throw 'Unexpected Docker PostgreSQL target.' }
$dbMounts = (& docker inspect --format '{{json .Mounts}}' $dbContainer) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or @($dbMounts | Where-Object { $_.Type -eq 'volume' -and $_.Name -eq 'delivery-backoffice_pg-data' -and $_.Destination -eq '/var/lib/postgresql' }).Count -ne 1 -or
    @($dbMounts | Where-Object { $_.Destination.StartsWith('/var/lib/postgresql/') }).Count) { throw 'Database container does not use the exact expected data volume.' }
$backendContainer = & docker compose ps -a -q backend
if ($LASTEXITCODE -ne 0 -or $backendContainer -notmatch '^[a-f0-9]{12,64}$') { throw 'Expected one stopped backend container for volume association checks.' }
$appMounts = (& docker inspect --format '{{json .Mounts}}' $backendContainer) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or @($appMounts | Where-Object { $_.Type -eq 'volume' -and $_.Name -eq 'delivery-backoffice_app-data' -and $_.Destination -eq '/app/.local' }).Count -ne 1 -or
    @($appMounts | Where-Object { $_.Destination.StartsWith('/app/.local/') }).Count) { throw 'Backend application data differs from the exact volume being backed up.' }
$active = Query-Database 'postgres' "SELECT count(*) FROM pg_stat_activity WHERE datname IN ('delivery_backoffice','delivery_backoffice_test','odoo_mock') AND state <> 'idle' AND pid <> pg_backend_pid()" -Container
if ($active -ne '0') { throw 'A database client is still active; stop all writers before backup.' }
$volume = 'delivery-backoffice_app-data'
$volumeProject = & docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' $volume
if ($LASTEXITCODE -ne 0 -or $volumeProject -ne 'delivery-backoffice') { throw 'Unexpected application data volume ownership.' }

function App-DataInventory {
    $script = @'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const files=[],directories=[];
function walk(relative){
  const full=path.join('/data',relative),entry=fs.lstatSync(full);
  if(entry.isSymbolicLink())throw Error('Backup refuses symbolic links');
  if(entry.isDirectory()){
    if(relative)directories.push(relative);
    for(const name of fs.readdirSync(full).sort())walk(path.posix.join(relative,name));
  }else if(entry.isFile()){
    files.push({name:relative,size:entry.size,sha256:crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')});
  }else throw Error('Backup refuses special filesystem entries');
}
walk('');process.stdout.write(JSON.stringify({directories,files}));
'@
    $value = Docker-Checked -Arguments @('run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','1000:1000','--mount',('type=volume,src='+$volume+',dst=/data,readonly'),'--entrypoint','node','delivery-backoffice-tools:0.1.0','-e',$script)
    return ($value | ConvertFrom-Json)
}

$backupId = 'docker_' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '_' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$backupRoot = Join-Path $projectRoot '.local/backups'
if (-not (Test-Path -LiteralPath $backupRoot)) { New-Item -ItemType Directory -Path $backupRoot | Out-Null }
if ((Get-Item -LiteralPath $backupRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Backup root must not be a link.' }
$backupPath = Join-Path $backupRoot $backupId
New-Item -ItemType Directory -Path $backupPath | Out-Null
if ($IsWindows) {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($null -eq $identity) { throw 'Unable to establish the private backup owner.' }
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($sid in @($identity,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
    }
    Set-Acl -LiteralPath $backupPath -AclObject $acl
} else { [IO.File]::SetUnixFileMode($backupPath,[IO.UnixFileMode]'UserRead,UserWrite,UserExecute') }

$before=[ordered]@{}
$structures=[ordered]@{}
foreach ($database in @('delivery_backoffice','odoo_mock','delivery_backoffice_test')) { $before[$database]=Database-Snapshot $database -Container }
foreach ($database in @('delivery_backoffice','odoo_mock','delivery_backoffice_test')) { $structures[$database]=Database-StructureSnapshot $database }
$fileInventory=App-DataInventory
$fileInventory | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $backupPath 'app-data-inventory.json') -Encoding utf8
$tempPath='/tmp/'+$backupId
Docker-Checked -Arguments @('compose','exec','-T','--user','postgres','db','mkdir','-m','700',$tempPath)
$archives=[ordered]@{}
foreach ($entry in @(@('delivery_backoffice','application.dump'),@('odoo_mock','source.dump'),@('delivery_backoffice_test','test.dump'))) {
    Docker-Checked -Arguments @('compose','exec','-T','--user','postgres','db','pg_dump','-U','backoffice_local_admin','-d',$entry[0],'--format=custom','--file',($tempPath+'/'+$entry[1]))
    Docker-Checked -Arguments @('compose','exec','-T','--user','postgres','db','pg_restore','--list',($tempPath+'/'+$entry[1])) | Out-Null
    Docker-Checked -Arguments @('compose','cp',('db:'+$tempPath+'/'+$entry[1]),(Join-Path $backupPath $entry[1]))
    $archives[$entry[1]]=(Get-FileHash -LiteralPath (Join-Path $backupPath $entry[1]) -Algorithm SHA256).Hash
}
Docker-Checked -Arguments @('compose','exec','-T','--user','postgres','db','pg_dumpall','-U','backoffice_local_admin','--globals-only','--file',($tempPath+'/globals.sql'))
Docker-Checked -Arguments @('compose','cp',('db:'+$tempPath+'/globals.sql'),(Join-Path $backupPath 'globals.sql'))
Docker-Checked -Arguments @('run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','1000:1000','--mount',('type=volume,src='+$volume+',dst=/data,readonly'),'--mount',('type=bind,src='+$backupPath+',dst=/backup'),'--entrypoint','tar','delivery-backoffice-tools:0.1.0','-C','/data','-cf','/backup/app-data.tar','.')
$verifyTar = @'
const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process');
const expected=JSON.parse(fs.readFileSync('/backup/app-data-inventory.json','utf8').replace(/^\uFEFF/,''));
const entries=cp.execFileSync('tar',['-tf','/backup/app-data.tar'],{encoding:'utf8'}).trimEnd().split('\n').sort();
const names=['./',...expected.directories.map(n=>'./'+n+'/'),...expected.files.map(f=>'./'+f.name)].sort();
if(JSON.stringify(entries)!==JSON.stringify(names))throw Error('Archive inventory differs from stopped application data');
for(const file of expected.files){
  const bytes=cp.execFileSync('tar',['-xOf','/backup/app-data.tar','./'+file.name],{maxBuffer:32*1024*1024});
  if(bytes.length!==file.size||crypto.createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('Archived file bytes differ from snapshot');
}
process.stdout.write('Application data archive verified against exact names, sizes and SHA256.\n');
'@
Docker-Checked -Arguments @('run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','1000:1000','--mount',('type=bind,src='+$backupPath+',dst=/backup,readonly'),'--entrypoint','node','delivery-backoffice-tools:0.1.0','-e',$verifyTar)
$secretSource=Join-Path $projectRoot '.local/docker/secrets'
$secretTarget=Join-Path $backupPath 'secrets'
New-Item -ItemType Directory -Path $secretTarget | Out-Null
$secretInventory=@()
foreach ($name in @('admin_password','app_password','source_owner_password','source_reader_password','database_url','test_database_url','odoo_database_url')) {
    $sourcePath=Join-Path $secretSource $name
    if ((Get-Item -LiteralPath $sourcePath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Secret source must not be a link.' }
    Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $secretTarget $name)
    if ((Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath (Join-Path $secretTarget $name) -Algorithm SHA256).Hash) { throw 'Recovery secret copy changed.' }
    $secretInventory += [ordered]@{name=$name;size=(Get-Item -LiteralPath $sourcePath).Length;sha256=(Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash}
}
foreach ($database in @('delivery_backoffice','odoo_mock','delivery_backoffice_test')) {
    $after=Database-Snapshot $database -Container
    if (($before[$database] | ConvertTo-Json -Depth 20 -Compress) -cne ($after | ConvertTo-Json -Depth 20 -Compress)) { throw "Docker $database changed during backup; no usable manifest was written." }
    if (($structures[$database] | ConvertTo-Json -Depth 20 -Compress) -cne ((Database-StructureSnapshot $database) | ConvertTo-Json -Depth 20 -Compress)) { throw "Docker $database structure changed during backup." }
}
if (($fileInventory | ConvertTo-Json -Depth 20 -Compress) -cne ((App-DataInventory) | ConvertTo-Json -Depth 20 -Compress)) { throw 'Application data volume changed during backup.' }
$archives['globals.sql']=(Get-FileHash -LiteralPath (Join-Path $backupPath 'globals.sql') -Algorithm SHA256).Hash
$archives['app-data.tar']=(Get-FileHash -LiteralPath (Join-Path $backupPath 'app-data.tar') -Algorithm SHA256).Hash
[ordered]@{formatVersion=1;backupId=$backupId;createdAt=[DateTime]::UtcNow.ToString('o');writersStopped=$true;project='delivery-backoffice';serverVersion=(Query-Database 'postgres' 'SHOW server_version' -Container);snapshots=$before;structures=$structures;appData=$fileInventory;archives=$archives;recoverySecrets=$secretInventory;containsPrivateRecoverySecrets=$true} |
    ConvertTo-Json -Depth 25 | Set-Content -LiteralPath (Join-Path $backupPath 'docker-backup-manifest.json') -Encoding utf8
Write-Output "Docker backup complete: $backupPath"
Write-Output 'Three databases, globals, complete app-data and recovery secrets copied. Writers stayed stopped; no native cluster was accessed.'
