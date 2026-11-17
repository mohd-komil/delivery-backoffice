param(
    [string]$ProjectName = 'delivery-odoo-customerdev',
    [string]$DeliveryId = '90434962-0c7d-4680-90ac-05229bf37328'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'docker-odoo-state.ps1')
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$configuration = Get-OdooConfiguration $projectRoot $ProjectName
$parsedId = [Guid]::Empty
if (-not [Guid]::TryParse($DeliveryId, [ref]$parsedId)) { throw 'A delivery UUID is required.' }
$compose = Get-Content -LiteralPath $configuration.compose -Raw | ConvertFrom-Json
if ('127.0.0.1:3031:3001' -notin $compose.services.backend.ports) {
    throw 'This verification targets the isolated customer-development API on port 3031 only.'
}
$accountsPath = Join-Path $configuration.directory 'demo-accounts.json'
Assert-OdooOrdinaryPath $accountsPath $false
$accounts = Get-Content -LiteralPath $accountsPath -Raw | ConvertFrom-Json
$session = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
$origin = @{ Origin = 'http://127.0.0.1:3030' }
$api = 'http://127.0.0.1:3031/api'
$loggedIn = $false
try {
    Invoke-RestMethod -Uri "$api/auth/login" -Method Post -ContentType 'application/json' -Headers $origin -WebSession $session `
        -Body (@{ email = $accounts.operator.email; password = $accounts.operator.password } | ConvertTo-Json -Compress) | Out-Null
    $loggedIn = $true
    # Only the ordinary import endpoint mutates state. No Locate address request is made.
    $runs = @()
    $previousState = $null
    foreach ($attempt in 1..2) {
        $run = Invoke-RestMethod -Uri "$api/imports" -Method Post -ContentType 'application/json' -Body '{}' `
            -Headers $origin -WebSession $session -TimeoutSec 300
        if ($run.status -notin @('succeeded', 'partial')) { throw 'Source import did not complete successfully. Inspect Import history.' }
        if (@($run.details | Where-Object { $_ -match '^Geocoding:' }).Count -ne 1) {
            throw 'Import did not report its automatic geocoding phase.'
        }
        $state = Invoke-RestMethod -Uri "$api/deliveries/$DeliveryId/geocoding" -WebSession $session
        if ($state.status -ne 'accepted') {
            throw "The selected address is not accepted: $($state.status) / $($state.reason). No approximate result was accepted by this verification."
        }
        if ($null -ne $previousState -and ($state.recordVersion -ne $previousState.recordVersion -or $state.addressKey -ne $previousState.addressKey)) {
            throw 'The repeated import changed the geocoding record. Inspect concurrent source edits before retrying.'
        }
        $previousState = $state
        $runs += [ordered]@{ attempt = $attempt; id = $run.id; status = $run.status; processed = $run.processed; details = $run.details }
    }
    $map = Invoke-RestMethod -Uri "$api/deliveries/map?view=inbox" -WebSession $session
    $markers = @($map.markers | Where-Object { $_.deliveryId -eq $DeliveryId })
    if ($markers.Count -ne 1 -or $markers[0].pointSource -ne 'geocoded') { throw 'Expected one geocoded map marker for the selected delivery.' }
    if ($markers[0].point.latitude -ne $previousState.candidate.point.latitude -or $markers[0].point.longitude -ne $previousState.candidate.point.longitude) {
        throw 'The map point differs from the persisted geocoding result.'
    }
    [ordered]@{
        deliveryId = $DeliveryId; runs = $runs; cacheReused = $true; locateAddressRequests = 0
        recordVersion = $previousState.recordVersion; mapTotal = $map.total
        mappedCount = $map.mappedCount; missingCount = $map.missingCount
    } | ConvertTo-Json -Depth 8
} finally {
    if ($loggedIn) {
        Invoke-RestMethod -Uri "$api/auth/logout" -Method Post -ContentType 'application/json' -Body '{}' -Headers $origin -WebSession $session | Out-Null
    }
}
