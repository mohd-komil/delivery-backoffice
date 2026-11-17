param([switch]$CustomerDevelopment)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'demo-catalogue-context.ps1')
$context=Get-DemoCatalogueContext -ProjectRoot $projectRoot -CustomerDevelopment:$CustomerDevelopment
$base=$context.api
$headers=$context.headers
$session=$context.session
try {
    # All identities, plates, contact details and ownership claims below are fictional.
    $definitions=@(
        @{name='Messina · Fiat Ducato';plate='DEMO-ME-01';ownership='company';providerName=$null;providerContact=$null;operationalStatus='available'},
        @{name='Catania · Ford Transit';plate='DEMO-CT-01';ownership='company';providerName=$null;providerContact=$null;operationalStatus='available'},
        @{name='Messina · Mercedes Sprinter';plate='DEMO-ME-02';ownership='company';providerName=$null;providerContact=$null;operationalStatus='maintenance'},
        @{name='Tirreno · Iveco Daily';plate='DEMO-EXT-01';ownership='external';providerName='Tirreno Trasporti (fictional)';providerContact='dispatch@tirreno.example.test';operationalStatus='available'},
        @{name='Etna · Renault Master';plate='DEMO-EXT-02';ownership='external';providerName='Etna Logistica (fictional)';providerContact='dispatch@etna.example.test';operationalStatus='available'}
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
    [ordered]@{synthetic=$true;api=$base;createdAt=[DateTime]::UtcNow.ToString('o');createdVehicles=$created;catalogue=@($prepared|Select-Object id,name,plate,ownership,operationalStatus,enabled)} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $reportRoot $reportName) -Encoding utf8
    Write-Output ('Fictional vehicle catalogue ready: '+$prepared.Count+' vehicles; newly created '+$created+'. Existing records and appointments preserved.')
} finally { Invoke-RestMethod -Uri ($base+'/auth/logout') -Method Post -Headers $headers -WebSession $session -ContentType 'application/json' -Body '{}' | Out-Null }
