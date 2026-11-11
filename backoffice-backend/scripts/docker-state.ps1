function Docker-Checked([string[]]$Arguments) {
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Docker operation failed; retained targets/backups must be inspected. Nothing is automatically reset.' }
}
function Query-Database([string]$Database, [string]$Sql, [switch]$Container) {
    if ($Database -notin @('postgres','delivery_backoffice','delivery_backoffice_test','odoo_mock')) { throw 'Unexpected database target.' }
    if ($Container) {
        $result = & docker compose exec -T db psql -X -A -t -q -v ON_ERROR_STOP=1 -U backoffice_local_admin -d $Database -c $Sql
    } else {
        $result = & $psql -X -A -t -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55432 -U backoffice_local_admin -d $Database -c $Sql
    }
    if ($LASTEXITCODE -ne 0) { throw "Snapshot query failed in $Database." }
    return $result
}
function Database-Snapshot([string]$Database, [switch]$Container) {
    $tables = @()
    $namesSql = 'SELECT schemaname || ''.'' || tablename FROM pg_tables WHERE schemaname NOT IN (''pg_catalog'',''information_schema'') AND schemaname !~ ''^pg_'' ORDER BY schemaname COLLATE "C",tablename COLLATE "C"'
    $names = @(Query-Database $Database $namesSql -Container:$Container)
    foreach ($name in $names) {
        if ($name -notmatch '^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$') { throw 'Unexpected table identifier; migration requires inspection.' }
        $quoted = '"' + $Matches[1] + '"."' + $Matches[2] + '"'
        $sql = 'SET TIME ZONE ''UTC''; SELECT json_build_object(''count'',count(*),''digest'',md5(COALESCE(string_agg(row_to_json(t)::text,E''\n'' ORDER BY row_to_json(t)::text COLLATE "C"),'''')))::text FROM ' + $quoted + ' t'
        $value = Query-Database $Database $sql -Container:$Container | ConvertFrom-Json
        $tables += [ordered]@{ name=$name; count=[long]$value.count; digest=$value.digest }
    }
    $sequenceJson = Query-Database $Database "SELECT COALESCE(json_agg(s ORDER BY schemaname,sequencename),'[]'::json)::text FROM (SELECT schemaname,sequencename,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value FROM pg_sequences WHERE schemaname !~ '^pg_' AND schemaname <> 'information_schema') s" -Container:$Container
    # psql returns JSON aggregates over several lines when several schemas exist.
    # ConvertFrom-Json needs one document, not one pipeline input per output line.
    $sequences = ($sequenceJson -join "`n") | ConvertFrom-Json -NoEnumerate
    return [ordered]@{ tables=$tables; sequences=$sequences }
}
function Local-FileInventory([string]$Directory, [string[]]$SelectedNames = @()) {
    $files = [Collections.Generic.SortedDictionary[string,object]]::new([StringComparer]::Ordinal)
    if (-not (Test-Path -LiteralPath $Directory)) { return [ordered]@{ files=@() } }
    $directoryItem = Get-Item -LiteralPath $Directory -Force
    if (-not $directoryItem.PSIsContainer -or ($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'File inventory requires an ordinary directory.' }
    $entries = if ($SelectedNames.Count) {
        foreach ($name in $SelectedNames) {
            $candidate = Join-Path $Directory $name
            if (Test-Path -LiteralPath $candidate) { Get-Item -LiteralPath $candidate -Force }
        }
    } else { Get-ChildItem -LiteralPath $Directory -Force }
    foreach ($entry in $entries) {
        if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'File inventory refuses nested directories or links.' }
        if (-not $SelectedNames.Count -and $entry.Name -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.pending)?$') { throw 'Unexpected private file name in exact inventory.' }
        $files.Add($entry.Name, [ordered]@{ name=$entry.Name; size=[long]$entry.Length; sha256=(Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash.ToLowerInvariant() })
    }
    return [ordered]@{ files=@($files.Values) }
}
function Docker-FileInventory {
    $inventoryScript = @'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const directory = process.argv[1];
const root = fs.lstatSync(directory);
if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Private storage must be an ordinary directory');
const files = fs.readdirSync(directory).sort().map((name) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.pending)?$/.test(name)) throw new Error('Unexpected private file name in exact inventory');
  const filename = path.join(directory, name);
  const entry = fs.lstatSync(filename);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('File inventory refuses nested directories or links');
  return { name, size: entry.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') };
});
process.stdout.write(JSON.stringify({ files }));
'@
    $value = Docker-Checked -Arguments @('compose','run','--rm','--no-deps','tools','node','-e',$inventoryScript,'.local/files')
    return ($value | ConvertFrom-Json)
}

function Database-StructureSnapshot([string]$Database) {
    $sql = @'
SELECT json_build_object(
'columns',(SELECT COALESCE(json_agg(t ORDER BY schema_name,table_name,position),'[]'::json) FROM (
  SELECT n.nspname AS schema_name,c.relname AS table_name,a.attnum AS position,a.attname AS name,
    format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,a.attidentity AS identity,a.attgenerated AS generated,
    pg_get_expr(d.adbin,d.adrelid) AS default_expression
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attnum>0 AND NOT a.attisdropped AND c.relkind='r' AND n.nspname NOT IN ('information_schema','pg_catalog') AND n.nspname !~ '^pg_'
) t),
'constraints',(SELECT COALESCE(json_agg(t ORDER BY schema_name,table_name,name),'[]'::json) FROM (
  SELECT n.nspname AS schema_name,c.relname AS table_name,k.conname AS name,k.contype AS type,
    pg_get_constraintdef(k.oid) AS definition,k.convalidated AS validated,k.condeferrable AS deferrable,k.condeferred AS deferred
  FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT IN ('information_schema','pg_catalog') AND n.nspname !~ '^pg_'
) t),
'indexes',(SELECT COALESCE(json_agg(t ORDER BY schemaname,tablename,indexname),'[]'::json) FROM (
  SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE schemaname NOT IN ('information_schema','pg_catalog') AND schemaname !~ '^pg_'
) t),
'tables',(SELECT COALESCE(json_agg(t ORDER BY schema_name,name),'[]'::json) FROM (
  SELECT n.nspname AS schema_name,c.relname AS name,pg_get_userbyid(c.relowner) AS owner,c.relacl::text AS acl,c.relrowsecurity AS row_security,c.relforcerowsecurity AS force_row_security
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname NOT IN ('information_schema','pg_catalog') AND n.nspname !~ '^pg_'
) t),
'schemas',(SELECT COALESCE(json_agg(t ORDER BY name),'[]'::json) FROM (
  SELECT nspname AS name,pg_get_userbyid(nspowner) AS owner,nspacl::text AS acl FROM pg_namespace WHERE nspname NOT IN ('information_schema','pg_catalog') AND nspname !~ '^pg_'
) t),
'defaultPrivileges',(SELECT COALESCE(json_agg(t ORDER BY role,schema_name,type),'[]'::json) FROM (
  SELECT pg_get_userbyid(d.defaclrole) AS role,n.nspname AS schema_name,d.defaclobjtype AS type,d.defaclacl::text AS acl FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
) t)
)::text
'@
    return (((Query-Database $Database $sql -Container) -join "`n") | ConvertFrom-Json)
}
