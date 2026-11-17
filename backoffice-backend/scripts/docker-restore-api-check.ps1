param(
    [Parameter(Mandatory)][string]$ProjectName,
    [Parameter(Mandatory)][string]$ComposeFile,
    [Parameter(Mandatory)][string]$BackupDirectory,
    [int]$ApiPort = 3021,
    [string]$CredentialsFile = (Join-Path $PSScriptRoot '../.local/demo-accounts.json')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($ProjectName -notmatch '^delivery-restore-[a-z0-9-]+$' -or $ApiPort -lt 3020 -or $ApiPort -gt 65535) {
    throw 'Only a separate delivery-restore project and API port >= 3020 are supported.'
}
$composePath = (Resolve-Path -LiteralPath $ComposeFile).Path
$backupPath = (Resolve-Path -LiteralPath $BackupDirectory).Path
$composeArguments = @('--project-name', $ProjectName, '--file', $composePath)
$reportPath = Join-Path (Split-Path -Parent $composePath) 'api-verification.json'
function Invoke-RestoreDocker([string[]]$Arguments) {
    $output = & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Restore verification Docker operation failed.' }
    return $output
}
function Assert-JsonEqual($Expected, $Actual, [string]$Message) {
    $left = [System.Text.Json.Nodes.JsonNode]::Parse((ConvertTo-Json -InputObject $Expected -Depth 100 -Compress))
    $right = [System.Text.Json.Nodes.JsonNode]::Parse((ConvertTo-Json -InputObject $Actual -Depth 100 -Compress))
    if (-not [System.Text.Json.Nodes.JsonNode]::DeepEquals($left, $right)) { throw $Message }
}

# Establish the destination before either reading credentials or making HTTP requests.
$dbId = Invoke-RestoreDocker (@('compose') + $composeArguments + @('ps', '-q', 'db'))
$apiId = Invoke-RestoreDocker (@('compose') + $composeArguments + @('ps', '-q', 'backend'))
foreach ($id in @($dbId, $apiId)) {
    if ($id -notmatch '^[a-f0-9]{12,64}$') { throw 'Expected one running restored DB and backend container.' }
}
$db = (Invoke-RestoreDocker @('inspect', $dbId) | ConvertFrom-Json)[0]
$api = (Invoke-RestoreDocker @('inspect', $apiId) | ConvertFrom-Json)[0]
foreach ($container in @($db, $api)) {
    if ($container.Config.Labels.'com.docker.compose.project' -cne $ProjectName) { throw 'Container project mismatch.' }
    foreach ($mount in $container.Mounts) {
        if (($mount.Type -eq 'bind' -and $mount.RW) -or $mount.Destination.StartsWith('/var/lib/postgresql/', [StringComparison]::Ordinal) -or $mount.Destination.StartsWith('/app/.local/', [StringComparison]::Ordinal)) {
            throw 'Restore verification refuses writable binds or nested data mounts.'
        }
        if ($mount.Type -eq 'volume' -and -not $mount.Name.StartsWith($ProjectName + '_', [StringComparison]::Ordinal)) {
            throw 'Restore container is attached to a volume from another project.'
        }
        if ($mount.Type -eq 'volume') {
            $volume = (Invoke-RestoreDocker @('volume', 'inspect', $mount.Name) | ConvertFrom-Json)[0]
            if ($volume.Labels.'com.docker.compose.project' -cne $ProjectName) { throw 'Restore volume project label mismatch.' }
        }
    }
    $networks = @($container.NetworkSettings.Networks.PSObject.Properties)
    $expectedNetworks = if ($container.Id -ceq $db.Id) { @($ProjectName + '_default') } else { @(($ProjectName + '_default'), ($ProjectName + '_host-access')) }
    $actualNetworkNames = @($networks | ForEach-Object { $_.Name } | Sort-Object)
    if (($actualNetworkNames -join '|') -cne (@($expectedNetworks | Sort-Object) -join '|')) {
        throw 'Restore DB must use only its internal network; backend must use exactly its internal and host-access networks.'
    }
    foreach ($entry in $networks) {
        $network = (Invoke-RestoreDocker @('network', 'inspect', $entry.Value.NetworkID) | ConvertFrom-Json)[0]
        $mustBeInternal = $entry.Name -ceq ($ProjectName + '_default')
        if ($network.Internal -ne $mustBeInternal -or $network.Labels.'com.docker.compose.project' -cne $ProjectName) {
            throw 'Restore network isolation or project ownership differs from its expected role.'
        }
    }
}
$bindings = @($api.HostConfig.PortBindings.'3001/tcp')
if ($bindings.Count -ne 1 -or $bindings[0].HostIp -cne '127.0.0.1' -or $bindings[0].HostPort -cne [string]$ApiPort) {
    throw 'Restored API port is not bound exclusively to the requested loopback port.'
}
$actualBindings = $api.NetworkSettings.Ports.'3001/tcp'
if ($null -eq $actualBindings -or @($actualBindings).Count -ne 1 -or $actualBindings[0].HostIp -cne '127.0.0.1' -or $actualBindings[0].HostPort -cne [string]$ApiPort) {
    throw 'Docker has not published the restored API on the requested loopback port.'
}
if (@($db.Mounts | Where-Object { $_.Type -eq 'volume' -and $_.Name -ceq ($ProjectName + '_pg-data') -and $_.Destination -ceq '/var/lib/postgresql' }).Count -ne 1 -or
    @($api.Mounts | Where-Object { $_.Type -eq 'volume' -and $_.Name -ceq ($ProjectName + '_app-data') -and $_.Destination -ceq '/app/.local' }).Count -ne 1) {
    throw 'Restored data volume association is unexpected.'
}
$originSetting = @($api.Config.Env | Where-Object { $_.StartsWith('FRONTEND_ORIGIN=', [StringComparison]::Ordinal) })
if ($originSetting.Count -ne 1 -or $originSetting[0] -cne 'FRONTEND_ORIGIN=http://127.0.0.1:3000') {
    throw 'Expected the ordinary Backoffice origin in the restored main application.'
}
$origin = 'http://127.0.0.1:3000'
$baseUri = [Uri]::new("http://127.0.0.1:$ApiPort/api/")
$manifest = Get-Content -LiteralPath (Join-Path $backupPath 'docker-backup-manifest.json') -Raw | ConvertFrom-Json -AsHashtable
if ($manifest.formatVersion -ne 1 -or $manifest.project -cne 'delivery-backoffice' -or -not $manifest.writersStopped) { throw 'Unexpected backup manifest.' }
$inventory = @{}
foreach ($file in $manifest.appData.files) { $inventory[$file.name] = $file }

# Fixed read-only SQL. No source DB, credentials or delivery identifiers enter SQL text.
$sql = @'
SELECT json_build_object(
 'deliveries',(SELECT COALESCE(json_agg(json_build_object('id',id,'data',data) ORDER BY id),'[]'::json) FROM delivery),
 'files',(SELECT COALESCE(json_agg(json_build_object('id',id,'deliveryId',delivery_id,'size',size,'kind',kind,'status',status) ORDER BY id),'[]'::json) FROM file_record),
 'history',(SELECT COALESCE(json_agg(json_build_object('id',id,'deliveryId',delivery_id,'actorId',actor_id,'actorName',actor_name,'action',action,'details',details) ORDER BY at DESC,id DESC),'[]'::json) FROM audit WHERE delivery_id IS NOT NULL)
)::text
'@
$raw = Invoke-RestoreDocker (@('compose') + $composeArguments + @('exec', '-T', 'db', 'psql', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'backoffice_local_admin', '-d', 'delivery_backoffice', '-c', $sql))
$expected = ($raw -join "`n") | ConvertFrom-Json -AsHashtable
if ($expected.deliveries.Count -eq 0 -or $expected.files.Count -eq 0) { throw 'The restored demo must contain deliveries and private attachments.' }
$credentials = Get-Content -LiteralPath $CredentialsFile -Raw | ConvertFrom-Json -AsHashtable
if ($credentials.operator.email -isnot [string] -or $credentials.operator.password -isnot [string] -or $credentials.operator.password.Length -eq 0) { throw 'Operator credentials are missing.' }

$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.AllowAutoRedirect = $false
$handler.UseCookies = $true
$handler.CookieContainer = [Net.CookieContainer]::new()
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds(30)
$anonymousHandler = [System.Net.Http.HttpClientHandler]::new()
$anonymousHandler.AllowAutoRedirect = $false
$anonymousHandler.UseCookies = $false
$anonymous = [System.Net.Http.HttpClient]::new($anonymousHandler)
$anonymous.Timeout = [TimeSpan]::FromSeconds(30)
function Request-RestoreApi([System.Net.Http.HttpClient]$HttpClient, [string]$Method, [string]$Path, $Body = $null, [string]$RequestOrigin = $origin) {
    if ($Path -notmatch '^[a-z0-9/\-?=&]+$') { throw 'Unexpected verifier API path.' }
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), [Uri]::new($baseUri, $Path))
    $request.Headers.Add('Origin', $RequestOrigin)
    if ($null -ne $Body) { $request.Content = [System.Net.Http.StringContent]::new(($Body | ConvertTo-Json -Depth 100 -Compress), [Text.Encoding]::UTF8, 'application/json') }
    try {
        $response = $HttpClient.SendAsync($request).GetAwaiter().GetResult()
        try {
            $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
            return [pscustomobject]@{ Status = [int]$response.StatusCode; Bytes = $bytes; Headers = $response.Headers.ToString(); ContentHeaders = $response.Content.Headers.ToString() }
        } finally { $response.Dispose() }
    } finally { $request.Dispose() }
}
function Read-JsonReply($Response, [int]$Status, [string]$Purpose) {
    if ($Response.Status -ne $Status) { throw "$Purpose returned HTTP $($Response.Status), expected $Status." }
    return ([Text.Encoding]::UTF8.GetString($Response.Bytes) | ConvertFrom-Json -AsHashtable)
}
$loggedIn = $false
$checks = [ordered]@{ formatVersion = 1; project = $ProjectName; api = $baseUri.AbsoluteUri; backupId = $manifest.backupId; checkedAt = [DateTime]::UtcNow.ToString('o'); deliveries = 0; historyRecords = 0; signedResults = 0; readyFiles = 0; downloadedBytes = 0L; anonymousDenied = $false; wrongOriginDenied = $false; passed = $false }
try {
    $health = Request-RestoreApi $anonymous 'GET' 'health'
    if ($health.Status -ne 200) { throw 'Restored API is not healthy.' }
    $denied = Request-RestoreApi $anonymous 'GET' 'deliveries'
    if ($denied.Status -ne 401) { throw 'Anonymous delivery access was not denied.' }
    # Invalid origin is rejected before authentication; no credentials are sent in this check.
    $wrongOrigin = Request-RestoreApi $anonymous 'POST' 'auth/login' @{} 'http://127.0.0.1:3029'
    if ($wrongOrigin.Status -ne 403) { throw 'Unexpected cross-origin authentication response.' }
    $checks.wrongOriginDenied = $true
    $login = Request-RestoreApi $client 'POST' 'auth/login' @{email = $credentials.operator.email; password = $credentials.operator.password}
    $principal = Read-JsonReply $login 201 'Operator login'
    if ($principal.role -cne 'operator') { throw 'Expected the restored ordinary operator account.' }
    $loggedIn = $true
    $me = Read-JsonReply (Request-RestoreApi $client 'GET' 'auth/me') 200 'Session authentication'
    if ($me.id -cne $principal.id) { throw 'Authenticated principal changed unexpectedly.' }
    foreach ($row in $expected.deliveries) {
        $id = $row.id
        if ($id -notmatch '^[0-9a-f-]{36}$') { throw 'Unexpected delivery ID.' }
        $detail = Read-JsonReply (Request-RestoreApi $client 'GET' "deliveries/$id") 200 'Delivery detail'
        if ($detail.delivery.id -cne $id -or $detail.delivery.version -ne $row.data.version -or $detail.delivery.appointments.Count -ne $row.data.appointments.Count) { throw 'Restored delivery identity/version/appointment count differs.' }
        foreach ($appointment in $row.data.appointments) {
            $actualAppointment = @($detail.delivery.appointments | Where-Object { $_.id -ceq $appointment.id })
            if ($actualAppointment.Count -ne 1) { throw 'Restored appointment missing from HTTP delivery detail.' }
            Assert-JsonEqual $appointment.results $actualAppointment[0].results 'Stored report or signature differs through the HTTP API.'
            foreach ($result in $appointment.results) {
                if ($null -ne $result.customerSignature -or $null -ne $result.crewSignature) { $checks.signedResults++ }
            }
        }
        $expectedHistory = @($expected.history | Where-Object { $_.deliveryId -ceq $id } | Select-Object -First 1000)
        if ($detail.history.Count -ne $expectedHistory.Count) { throw 'History record count differs through the HTTP API.' }
        for ($index = 0; $index -lt $expectedHistory.Count; $index++) {
            $stored = $expectedHistory[$index]
            $actual = $detail.history[$index]
            foreach ($property in @('id','actorId','actorName','action','details')) { Assert-JsonEqual $stored[$property] $actual[$property] 'History differs through the HTTP API.' }
        }
        $checks.deliveries++
        $checks.historyRecords += $detail.history.Count
    }
    foreach ($file in $expected.files) {
        if ($file.status -cne 'ready') { continue }
        if ($file.id -notmatch '^[0-9a-f-]{36}$' -or $file.deliveryId -notmatch '^[0-9a-f-]{36}$') { throw 'Unexpected file identifier.' }
        $name = 'files/' + $file.id
        if (-not $inventory.ContainsKey($name)) { throw 'Ready database file is missing from the backup inventory.' }
        $archived = $inventory[$name]
        if ($file.size -ne $archived.size) { throw 'Ready file database size differs from its backup.' }
        $endpoint = 'deliveries/' + $file.deliveryId + '/files/' + $file.id
        $privateFile = Request-RestoreApi $client 'GET' $endpoint
        if ($privateFile.Status -ne 200 -or $privateFile.Bytes.Length -ne $file.size) { throw 'Restored private-file download failed or is incomplete.' }
        $sha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($privateFile.Bytes)).ToLowerInvariant()
        if ($sha256 -cne $archived.sha256.ToLowerInvariant()) { throw 'Downloaded bytes differ from the fresh backup SHA256.' }
        if ($privateFile.Headers -notmatch '(?im)^Cache-Control: no-store\s*$' -or $privateFile.Headers -notmatch '(?im)^X-Content-Type-Options: nosniff\s*$') { throw 'Private download security headers are missing.' }
        $privateDenied = Request-RestoreApi $anonymous 'GET' $endpoint
        if ($privateDenied.Status -ne 401) { throw 'Anonymous private-file access was not denied.' }
        $checks.readyFiles++
        $checks.downloadedBytes += $privateFile.Bytes.Length
    }
    if ($checks.readyFiles -eq 0 -or $checks.signedResults -eq 0 -or $checks.historyRecords -eq 0) { throw 'Expected files, signed results and History were not exercised.' }
    $checks.anonymousDenied = $true
    $checks.passed = $true
} finally {
    $logoutFailed = $false
    try {
        if ($loggedIn) {
            $logout = Request-RestoreApi $client 'POST' 'auth/logout' @{}
            if ($logout.Status -ne 201) { $logoutFailed = $true }
        }
    } catch {
        $logoutFailed = $true
    } finally {
        if ($logoutFailed) { $checks.passed = $false }
        $client.Dispose()
        $anonymous.Dispose()
        $checks | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
    }
    if ($logoutFailed) { throw 'Could not end the cloned verification session; inspect its retained report.' }
}
Write-Output ("Restored API verified: {0} deliveries, {1} History records, {2} signed results, {3} private files ({4} bytes); anonymous access and cross-origin login denied." -f $checks.deliveries,$checks.historyRecords,$checks.signedResults,$checks.readyFiles,$checks.downloadedBytes)
Write-Output "Report: $reportPath"
