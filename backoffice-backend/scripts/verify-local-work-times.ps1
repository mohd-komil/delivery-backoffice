param([string]$ProjectName = 'delivery-odoo-customerdev')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'docker-odoo-state.ps1')
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$configuration = Get-OdooConfiguration $projectRoot $ProjectName
$compose = Get-Content -LiteralPath $configuration.compose -Raw | ConvertFrom-Json
if ($ProjectName -ne 'delivery-odoo-customerdev' -or '127.0.0.1:3031:3001' -notin $compose.services.backend.ports) {
    throw 'This scenario is restricted to the explicitly authorized customer-schema development stand on API 3031.'
}
$accountsPath = Join-Path $configuration.directory 'demo-accounts.json'
Assert-OdooOrdinaryPath $accountsPath $false
$accounts = Get-Content -LiteralPath $accountsPath -Raw | ConvertFrom-Json
$session = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
$origin = @{ Origin = 'http://127.0.0.1:3030' }
$api = 'http://127.0.0.1:3031/api'
# Explicit teaching rates, not customer-approved standards. Only application HTTP endpoints write.
$cases = @(
    @{ id='90434962-0c7d-4680-90ac-05229bf37328'; name='MTO/OUT/00697'; service='delivery_installation'; delivery=10; installation=20; collection=$null; minutes=30 },
    @{ id='4f1195b3-3c36-4eda-8672-5565de086c07'; name='MTO/OUT/00893'; service='collection_only'; delivery=$null; installation=$null; collection=25; minutes=25 },
    @{ id='cd78006c-73ad-4e6a-a3ea-ff5f2a185f51'; name='MTO/OUT/00973'; service='delivery_only'; delivery=15; installation=$null; collection=$null; minutes=15 }
)
function Invoke-WorkTimeApi([string]$Path, [string]$Method = 'GET', $Body = $null) {
    $parameters = @{ Uri="$api$Path"; Method=$Method; WebSession=$session; TimeoutSec=300 }
    if ($Method -ne 'GET') {
        $parameters.Headers = $origin
        $parameters.ContentType = 'application/json'
        $parameters.Body = $Body | ConvertTo-Json -Depth 30 -Compress
    }
    Invoke-RestMethod @parameters
}
$loggedIn = $false
try {
    Invoke-WorkTimeApi '/auth/login' 'POST' @{email=$accounts.operator.email;password=$accounts.operator.password} | Out-Null
    $loggedIn = $true
    $before = @($cases | ForEach-Object { Invoke-WorkTimeApi "/deliveries/$($_.id)" })
    foreach ($case in $cases) {
        $detail = $before | Where-Object { $_.delivery.id -eq $case.id }
        if ($detail.delivery.source.pickingName -ne $case.name -or @($detail.delivery.source.items).Count -ne 1 -or @($detail.delivery.appointments).Count -ne 0) {
            throw 'A fixture no longer matches this unbooked, single-line development scenario. No further edits are safe.'
        }
        if ($detail.delivery.source.items[0].quantity -ne 1 -or $null -ne $detail.delivery.source.estimatedMinutes) {
            throw 'Source quantity/time changed. Review this scenario before updating its teaching rates.'
        }
        if ($null -ne $detail.lineServices[0].service -and $detail.lineServices[0].service -ne $case.service) {
            throw 'An existing service differs; this script will not overwrite another service decision.'
        }
        if ($detail.delivery.PSObject.Properties.Name -contains 'servicePlan' -and $null -ne $detail.delivery.servicePlan -and $detail.delivery.servicePlan.PSObject.Properties.Name -contains 'timeEstimates') {
            $saved = @($detail.delivery.servicePlan.timeEstimates | Where-Object { $_.sourceLineId -eq $detail.delivery.source.items[0].sourceLineId })
            if ($saved.Count -gt 0 -and ($saved[0].deliveryMinutesPerUnit -ne $case.delivery -or $saved[0].installationMinutesPerUnit -ne $case.installation -or $saved[0].collectionMinutesPerUnit -ne $case.collection)) {
                throw 'Existing local work times differ. Review the scenario instead of replacing them.'
            }
        }
    }
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
    $before | ConvertTo-Json -Depth 60 | Set-Content -LiteralPath (Join-Path $configuration.directory "work-times-before-$stamp.json") -Encoding utf8
    $expected = @{}
    foreach ($case in $cases) {
        $detail = Invoke-WorkTimeApi "/deliveries/$($case.id)"
        $lineId = $detail.delivery.source.items[0].sourceLineId
        if ($null -eq $detail.lineServices[0].service) {
            $detail = Invoke-WorkTimeApi "/deliveries/$($case.id)/services" 'PATCH' @{version=$detail.delivery.version;sourceLineId=$lineId;service=$case.service}
        }
        $detail = Invoke-WorkTimeApi "/deliveries/$($case.id)/work-times" 'PATCH' @{
            version=$detail.delivery.version; sourceLineId=$lineId
            deliveryMinutesPerUnit=$case.delivery; installationMinutesPerUnit=$case.installation; collectionMinutesPerUnit=$case.collection
        }
        if ($detail.lineWorkTimes[0].remainingMinutes -ne $case.minutes -or $detail.lineWorkTimes[0].basis -ne 'local') {
            throw 'The product-line estimate does not match the explicit teaching rates.'
        }
        $expected[$case.id] = $detail.delivery.servicePlan | ConvertTo-Json -Depth 30 -Compress
    }
    $run = Invoke-WorkTimeApi '/imports' 'POST' @{}
    if ($run.status -ne 'succeeded') { throw 'The source reimport did not fully succeed.' }
    $results = @($cases | ForEach-Object {
        $case = $_
        $detail = Invoke-WorkTimeApi "/deliveries/$($case.id)"
        if (($detail.delivery.servicePlan | ConvertTo-Json -Depth 30 -Compress) -cne $expected[$case.id]) {
            throw 'Reimport changed a local service or time estimate.'
        }
        $jobs = Invoke-WorkTimeApi ("/routes/jobs?search=" + [Uri]::EscapeDataString($case.name))
        $job = @($jobs.jobs | Where-Object { $_.deliveryId -eq $case.id })
        if ($job.Count -ne 1 -or $job[0].suggestedWorkMinutes -ne $case.minutes -or $job[0].remainingWorkEstimate.basis -ne 'local_operation_rates') {
            throw 'Routes did not use the preserved local estimate.'
        }
        [ordered]@{picking=$case.name;deliveryId=$case.id;sourceLineId=$detail.delivery.source.items[0].sourceLineId;service=$case.service;remainingMinutes=$case.minutes;preserved=$true;routeMinutes=$job[0].suggestedWorkMinutes;hasCoordinates=($null -ne $job[0].point)}
    })
    $report = [ordered]@{checkedAt=[DateTime]::UtcNow.ToString('o');importId=$run.id;processed=$run.processed;status=$run.status;externalWrites=0;assumption='Explicit teaching minutes per source unit for the whole team, excluding travel';pickings=$results}
    $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $configuration.directory 'work-times-verification.json') -Encoding utf8
    $report | ConvertTo-Json -Depth 10
} finally {
    if ($loggedIn) { Invoke-WorkTimeApi '/auth/logout' 'POST' @{} | Out-Null }
}
