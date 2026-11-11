param(
    [Parameter(Mandatory=$true)][string]$BaselinePath,
    [string]$PostgresBin = 'C:/Program Files/PostgreSQL/18/bin'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$resolvedBaseline = (Resolve-Path -LiteralPath $BaselinePath).Path
$localRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.local')) + [IO.Path]::DirectorySeparatorChar
if (-not $resolvedBaseline.StartsWith($localRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Use an owned baseline under backend .local.' }
$baseline = Get-Content -Raw -LiteralPath $resolvedBaseline | ConvertFrom-Json
if ($baseline.database -ne 'delivery_backoffice') { throw 'Unexpected baseline database.' }
$credentials = Get-Content -Raw -LiteralPath (Join-Path $projectRoot '.local/postgres-credentials.json') | ConvertFrom-Json
$previousPgPassword = $env:PGPASSWORD
$env:PGPASSWORD = $credentials.app
$sql = @'
BEGIN TRANSACTION READ ONLY;
SELECT jsonb_build_object(
  'database',current_database(),
  'crews',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'version',c.version,'data',
    jsonb_build_object('id',c.id,'version',c.version,'name',c.name,'classification',c.classification,
      'area',c.area,'enabled',c.enabled,'people',(SELECT coalesce(jsonb_agg(
        jsonb_build_object('id',p.id,'name',coalesce(p.preferred_name,nullif(concat_ws(' ',p.first_name,p.last_name),''),p.legacy_name),
          'external',p.external) ORDER BY m.position),'[]'::jsonb)
        FROM crew_member m JOIN person p ON p.id=m.person_id WHERE m.crew_id=c.id))) ORDER BY c.id),'[]'::jsonb) FROM crew c),
  'archives',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version,'data',legacy_data) ORDER BY id),'[]'::jsonb) FROM crew),
  'deliveries',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version,'digest',md5(data::text)) ORDER BY id),'[]'::jsonb) FROM delivery),
  'files',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'status',status,'size',size) ORDER BY id),'[]'::jsonb) FROM file_record),
  'personCount',(SELECT count(*) FROM person),
  'membershipCount',(SELECT count(*) FROM crew_member)
);
COMMIT;
'@
try {
    $raw = $sql | & (Join-Path $PostgresBin 'psql.exe') -X -q -A -t -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55432 -U delivery_app -d delivery_backoffice
    if ($LASTEXITCODE -ne 0) { throw 'Read-only migration verification query failed.' }
    $actual = ($raw -join "`n") | ConvertFrom-Json
    if ($actual.database -ne $baseline.database) { throw 'Wrong target database.' }
    foreach ($field in @('crews','deliveries','files')) {
        $expectedJson = ConvertTo-Json -InputObject $baseline.$field -Depth 50 -Compress
        $actualJson = ConvertTo-Json -InputObject $actual.$field -Depth 50 -Compress
        if ($actualJson -cne $expectedJson) { throw "Migration preservation check failed for $field. Inspect the owned baseline; no data was changed by this verifier." }
    }
    if ((ConvertTo-Json -InputObject $actual.archives -Depth 50 -Compress) -cne (ConvertTo-Json -InputObject $baseline.crews -Depth 50 -Compress)) { throw 'Original crew archives differ from baseline.' }
    $report = [ordered]@{
        verifiedAt = [DateTime]::UtcNow.ToString('o')
        database = $actual.database
        baseline = [IO.Path]::GetFileName($resolvedBaseline)
        crewCount = @($actual.crews).Count
        personCount = $actual.personCount
        membershipCount = $actual.membershipCount
        deliveryCount = @($actual.deliveries).Count
        fileCount = @($actual.files).Count
        preserved = @('crew IDs, versions, fields and ordered participants','original crew JSON archives','all delivery JSON digests and versions','private file records')
    }
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath ($resolvedBaseline + '.verified.json') -Encoding utf8
    Write-Output "PASS: $($report.crewCount) crews, $($report.personCount) people, $($report.membershipCount) memberships; $($report.deliveryCount) deliveries and $($report.fileCount) file records unchanged."
} finally {
    if ($null -eq $previousPgPassword) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
    else { $env:PGPASSWORD = $previousPgPassword }
}
