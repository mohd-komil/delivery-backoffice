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
    $before = Invoke-RestMethod -Uri "$api/deliveries/$DeliveryId" -WebSession $session
    $beforeJson = $before.delivery | ConvertTo-Json -Depth 50 -Compress
    $entrance = Invoke-RestMethod -Uri "$api/deliveries/$DeliveryId/entrance" -WebSession $session
    $state = Invoke-RestMethod -Uri "$api/deliveries/$DeliveryId/geocoding" -WebSession $session
    $body = @{ addressKey = $state.addressKey; deliveryVersion = $state.deliveryVersion } | ConvertTo-Json -Compress
    $located = Invoke-RestMethod -Uri "$api/deliveries/$DeliveryId/geocoding" -Method Post -ContentType 'application/json' `
        -Body $body -Headers $origin -WebSession $session
    if ($located.status -ne 'accepted') {
        throw "Address lookup requires attention: $($located.status) / $($located.reason). No approximate point was accepted by this verification."
    }
    $repeated = Invoke-RestMethod -Uri "$api/deliveries/$DeliveryId/geocoding" -Method Post -ContentType 'application/json' `
        -Body $body -Headers $origin -WebSession $session
    if ($repeated.status -ne 'accepted' -or $repeated.recordVersion -ne $located.recordVersion) {
        throw 'Repeated lookup did not reuse the saved result.'
    }
    $map = Invoke-RestMethod -Uri "$api/deliveries/map?view=inbox" -WebSession $session
    $markers = @($map.markers | Where-Object { $_.deliveryId -eq $DeliveryId })
    if ($markers.Count -ne 1 -or $markers[0].pointSource -ne 'geocoded') { throw 'Expected one geocoded map marker.' }
    if ($markers[0].point.latitude -ne $located.candidate.point.latitude -or $markers[0].point.longitude -ne $located.candidate.point.longitude) {
        throw 'The map point differs from the persisted provider result.'
    }
    $after = Invoke-RestMethod -Uri "$api/deliveries/$DeliveryId" -WebSession $session
    if (($after.delivery | ConvertTo-Json -Depth 50 -Compress) -cne $beforeJson) { throw 'The delivery changed during verification. Inspect concurrent updates before retrying.' }
    $afterEntrance = Invoke-RestMethod -Uri "$api/deliveries/$DeliveryId/entrance" -WebSession $session
    if (($afterEntrance.entrance | ConvertTo-Json -Depth 10 -Compress) -cne ($entrance.entrance | ConvertTo-Json -Depth 10 -Compress)) {
        throw 'The confirmed unloading entrance changed during verification.'
    }
    [ordered]@{
        deliveryId = $DeliveryId; status = $located.status; recordVersion = $located.recordVersion
        precision = $located.candidate.precision; point = $located.candidate.point
        mapTotal = $map.total; mappedCount = $map.mappedCount; missingCount = $map.missingCount
        cacheReused = $true; deliveryUnchanged = $true; entranceUnchanged = $true
    } | ConvertTo-Json -Depth 5
} finally {
    if ($loggedIn) {
        Invoke-RestMethod -Uri "$api/auth/logout" -Method Post -ContentType 'application/json' -Body '{}' -Headers $origin -WebSession $session | Out-Null
    }
}
