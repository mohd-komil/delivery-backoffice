$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$base='http://127.0.0.1:3001/api'
$headers=@{Origin='http://127.0.0.1:3000'}
$session=[Microsoft.PowerShell.Commands.WebRequestSession]::new()
$health=Invoke-RestMethod -Uri ($base+'/health')
if($health.database -ne 'delivery_backoffice' -or $health.sourceModel -ne 'synthetic Odoo teaching model'){throw 'Expected the isolated teaching backoffice API.'}
$accounts=Get-Content -Raw -LiteralPath (Join-Path $projectRoot '.local/demo-accounts.json') | ConvertFrom-Json
$user=Invoke-RestMethod -Uri ($base+'/auth/login') -Method Post -Headers $headers -WebSession $session -ContentType 'application/json' -Body (@{email=$accounts.admin.email;password=$accounts.admin.password}|ConvertTo-Json -Compress)
if($user.role -ne 'admin'){throw 'Administrator account required.'}
try {
    # All identities, plates, contact details and ownership claims below are fictional.
    $definitions=@(
        @{name='Messina · Fiat Ducato';plate='DEMO-ME-01';ownership='company';providerName=$null;providerContact=$null;operationalStatus='available'},
        @{name='Catania · Ford Transit';plate='DEMO-CT-01';ownership='company';providerName=$null;providerContact=$null;operationalStatus='available'},
        @{name='Messina · Mercedes Sprinter';plate='DEMO-ME-02';ownership='company';providerName=$null;providerContact=$null;operationalStatus='maintenance'},
        @{name='Tirreno · Iveco Daily';plate='DEMO-EXT-01';ownership='external';providerName='Tirreno Trasporti (fictional)';providerContact='+39 000 200 0001';operationalStatus='available'}
    )
    $vehicles=Invoke-RestMethod -Uri ($base+'/vehicles') -WebSession $session
    if($null -eq $vehicles){$vehicles=@()}
    $created=0
    $prepared=@()
    foreach($definition in $definitions){
        $matchesByPlate=@($vehicles | Where-Object {$_.plate -eq $definition.plate})
        if($matchesByPlate.Count -gt 1){throw 'Ambiguous existing vehicle plate; no existing vehicle was changed.'}
        if($matchesByPlate.Count){$vehicle=$matchesByPlate[0]}
        else {
            $body=$definition.Clone()
            $body.enabled=$true
            $body.notes='Fictional local teaching vehicle. Capacity, insurance, licence and route feasibility are not verified.'
            $vehicle=Invoke-RestMethod -Uri ($base+'/vehicles') -Method Post -Headers $headers -WebSession $session -ContentType 'application/json' -Body ($body|ConvertTo-Json -Depth 5 -Compress)
            $vehicles+= $vehicle
            $created++
        }
        $prepared+= $vehicle
    }
    $reportRoot=Join-Path $projectRoot '.local/vehicle-demo-runs'
    New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
    $reportName=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')+'_'+[Guid]::NewGuid().ToString('N').Substring(0,8)+'.json'
    [ordered]@{synthetic=$true;createdAt=[DateTime]::UtcNow.ToString('o');createdVehicles=$created;catalogue=@($prepared|Select-Object id,name,plate,ownership,operationalStatus,enabled)} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $reportRoot $reportName) -Encoding utf8
    Write-Output ('Fictional vehicle catalogue ready: '+$prepared.Count+' vehicles; newly created '+$created+'. Existing records and appointments preserved.')
} finally { Invoke-RestMethod -Uri ($base+'/auth/logout') -Method Post -Headers $headers -WebSession $session -ContentType 'application/json' -Body '{}' | Out-Null }
