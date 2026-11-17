param([Parameter(Mandatory)][string]$RunDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$runPath = (Resolve-Path -LiteralPath $RunDirectory).Path
$run = Get-Content -LiteralPath (Join-Path $runPath 'run.json') -Raw | ConvertFrom-Json -AsHashtable
$project = $run.project
if ($project -notmatch '^delivery-restore-[a-z0-9-]+$') { throw 'Only a separate delivery-restore project is supported.' }
$composePath = (Resolve-Path -LiteralPath $run.composeFile).Path
if ((Split-Path -Parent $composePath) -cne $runPath) { throw 'Compose file must belong to this restore run directory.' }
$composeArguments = @('--project-name', $project, '--file', $composePath)
$volumeName = $project + '_app-data'
if ($volumeName -notin $run.volumes -or $run.images.tools -notmatch '^sha256:[0-9a-f]{64}$') { throw 'Unexpected restore volume or helper image identity.' }
function Invoke-DemoRestoreDocker([string[]]$Arguments) {
    $output = & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Demo supplement restore failed; retained target must be inspected. No automatic reset is performed.' }
    return $output
}
$volume = (Invoke-DemoRestoreDocker @('volume','inspect',$volumeName) | ConvertFrom-Json)[0]
if ($volume.Labels.'com.docker.compose.project' -cne $project -or $volume.Name -cne $volumeName) { throw 'Unexpected target volume owner.' }
$dbId = Invoke-DemoRestoreDocker (@('compose') + $composeArguments + @('ps','-q','db'))
if ($dbId -notmatch '^[a-f0-9]{12,64}$') { throw 'Expected one restored database container.' }
$db = (Invoke-DemoRestoreDocker @('inspect',$dbId) | ConvertFrom-Json)[0]
if ($db.Config.Labels.'com.docker.compose.project' -cne $project -or
    @($db.Mounts | Where-Object { $_.Type -eq 'volume' -and $_.Name -ceq ($project + '_pg-data') -and $_.Destination -ceq '/var/lib/postgresql' }).Count -ne 1) { throw 'Unexpected restored database association.' }
$backupPath = (Resolve-Path -LiteralPath $run.backupDirectory).Path
$supplementPath = Join-Path $backupPath 'acceptance-browser-demo'
$manifestPath = Join-Path $backupPath 'acceptance-files-manifest.json'
foreach ($path in @($backupPath,$supplementPath,$manifestPath)) {
    if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Supplement sources must not be links.' }
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -AsHashtable
if (-not $manifest.writersStopped -or $manifest.source -cne 'acceptance-browser-demo' -or $manifest.files.Count -eq 0) { throw 'A stopped-writer acceptance-file supplement is required.' }
$expectedNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$schemas = [Collections.Generic.SortedSet[string]]::new([StringComparer]::Ordinal)
foreach ($file in $manifest.files) {
    $name = $file.name
    if ($name -isnot [string] -or $file.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $file.size -lt 0) { throw 'Invalid supplement inventory entry.' }
    if ($name -match '^(route_acceptance_demo_[a-f0-9]{32})/files/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') {
        [void]$schemas.Add($Matches[1])
    } elseif ($name -notin @('connection.json','connection-first-run-preserved.json','result.json')) {
        throw 'Unexpected supplement path; only the captured acceptance schemas and metadata are supported.'
    }
    if (-not $expectedNames.Add($name)) { throw 'Duplicate supplement path.' }
    $source = Join-Path $supplementPath $name
    $item = Get-Item -LiteralPath $source -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -ne $file.size -or
        (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ine $file.sha256) { throw 'Supplement source bytes differ from the captured inventory.' }
}
$actualNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($entry in Get-ChildItem -LiteralPath $supplementPath -Force -Recurse) {
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Supplement refuses links, including parent directories.' }
    if (-not $entry.PSIsContainer) { [void]$actualNames.Add([IO.Path]::GetRelativePath($supplementPath,$entry.FullName).Replace('\','/')) }
}
if (-not $expectedNames.SetEquals($actualNames) -or $schemas.Count -eq 0) { throw 'Supplement inventory must match exact source files and contain a captured schema.' }

# Read the restored test schemas before copying. Identifiers come solely from the fixed pattern above.
$readyBySchema = @()
foreach ($schema in $schemas) {
    $sql = 'SELECT COALESCE(json_agg(json_build_object(''id'',id,''size'',size) ORDER BY id),''[]''::json)::text FROM "' + $schema + '".file_record WHERE status=''ready'''
    $raw = Invoke-DemoRestoreDocker (@('compose') + $composeArguments + @('exec','-T','db','psql','-X','-A','-t','-q','-v','ON_ERROR_STOP=1','-U','backoffice_local_admin','-d','delivery_backoffice_test','-c',$sql))
    $ready = ($raw -join "`n") | ConvertFrom-Json -AsHashtable -NoEnumerate
    foreach ($file in $ready) {
        $name = $schema + '/files/' + $file.id
        if (-not $expectedNames.Contains($name)) { throw 'A ready file in the restored acceptance schema is absent from the supplement.' }
        $snapshot = @($manifest.files | Where-Object { $_.name -ceq $name })
        if ($snapshot.Count -ne 1 -or $snapshot[0].size -ne $file.size) { throw 'Restored ready-file size differs from the supplement.' }
    }
    $readyBySchema += [ordered]@{schema=$schema;readyFiles=$ready.Count}
}
$copyScript = @'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const expected=JSON.parse(fs.readFileSync('/backup/acceptance-files-manifest.json','utf8').replace(/^\uFEFF/,''));
const backup=JSON.parse(fs.readFileSync('/backup/docker-backup-manifest.json','utf8').replace(/^\uFEFF/,''));
const source='/backup/acceptance-browser-demo',target='/data/acceptance-browser-demo';
if(!fs.lstatSync('/data').isDirectory()||fs.lstatSync('/data').isSymbolicLink())throw Error('Target volume root is invalid');
if(!fs.lstatSync(source).isDirectory()||fs.lstatSync(source).isSymbolicLink())throw Error('Source root is invalid');
if(fs.existsSync(target)){
  const entry=fs.lstatSync(target);
  const wasEmptyPlaceholder=backup.appData.directories.includes('acceptance-browser-demo')&&!backup.appData.files.some(f=>f.name.startsWith('acceptance-browser-demo/'));
  if(!entry.isDirectory()||entry.isSymbolicLink()||fs.readdirSync(target).length!==0||!wasEmptyPlaceholder)throw Error('Supplement destination exists and is not the backed-up empty mountpoint');
}
function hash(filename){return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');}
for(const file of expected.files){
  if(!/^(?:route_acceptance_demo_[a-f0-9]{32}\/files\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|connection(?:-first-run-preserved)?\.json|result\.json)$/.test(file.name))throw Error('Invalid supplement path');
  let cursor=source;
  for(const segment of file.name.split('/')){cursor=path.join(cursor,segment);if(fs.lstatSync(cursor).isSymbolicLink())throw Error('Source link rejected');}
  const entry=fs.lstatSync(cursor);
  if(!entry.isFile()||entry.size!==file.size||hash(cursor)!==file.sha256.toLowerCase())throw Error('Source bytes changed');
}
if(!fs.existsSync(target))fs.mkdirSync(target,{mode:0o700});
fs.chmodSync(target,0o700);
for(const file of expected.files){
  const filename=path.join(target,file.name);
  fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
  fs.copyFileSync(path.join(source,file.name),filename,fs.constants.COPYFILE_EXCL);
  fs.chmodSync(filename,0o600);
}
const actual=[];
function walk(relative){for(const name of fs.readdirSync(path.join(target,relative)).sort()){
  const child=path.posix.join(relative,name),filename=path.join(target,child),entry=fs.lstatSync(filename);
  if(entry.isSymbolicLink())throw Error('Restored link rejected');
  if(entry.isDirectory())walk(child);
  else if(entry.isFile())actual.push({name:child,size:entry.size,sha256:hash(filename)});
  else throw Error('Unexpected restored entry');
}}
walk('');
const wanted=expected.files.map(f=>({name:f.name,size:f.size,sha256:f.sha256.toLowerCase()})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
actual.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
if(JSON.stringify(actual)!==JSON.stringify(wanted))throw Error('Restored inventory differs');
process.stdout.write(JSON.stringify({files:actual.length,bytes:actual.reduce((total,f)=>total+f.size,0),sha256Verified:true}));
'@
$resultRaw = Invoke-DemoRestoreDocker @('run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','1000:1000','--mount',('type=volume,src='+$volumeName+',dst=/data'),'--mount',('type=bind,src='+$backupPath+',dst=/backup,readonly'),'--entrypoint','node',$run.images.tools,'-e',$copyScript)
$result = ($resultRaw -join "`n") | ConvertFrom-Json -AsHashtable
$report = [ordered]@{formatVersion=1;project=$project;checkedAt=[DateTime]::UtcNow.ToString('o');source='acceptance-browser-demo';volume=$volumeName;destination='/app/.local/acceptance-browser-demo';files=$result.files;bytes=$result.bytes;sha256Verified=$result.sha256Verified;schemas=$readyBySchema;passed=$true;scope='Only acceptance schemas captured in the supplement; other test schemas are outside this attachment check.'}
$reportPath = Join-Path $runPath 'external-demo-verification.json'
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
Write-Output "Acceptance supplement restored and verified: $($result.files) files, $($schemas.Count) schemas. Report: $reportPath"
