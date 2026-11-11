param([switch]$AssignSimoneExample)
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
    $definitions=@(
        @{name='Product inspection';description='Identify and check products against delivery paperwork.'},
        @{name='Quantity verification';description='Check delivered quantities and record partial deliveries accurately.'},
        @{name='Integrity inspection';description='Inspect product condition and identify damage or missing parts.'},
        @{name='Furniture assembly';description='Assemble furniture according to the product instructions.'},
        @{name='Site cleanup';description='Leave the customer work area clean after the visit.'},
        @{name='Packaging removal';description='Collect and separate packaging after delivery and assembly.'}
    )
    $skills=Invoke-RestMethod -Uri ($base+'/skills') -WebSession $session
    if($null -eq $skills){$skills=@()}
    $prepared=@()
    $created=0
    foreach($definition in $definitions){
        $existingSkills=@($skills | Where-Object {$_.name -eq $definition.name})
        if($existingSkills.Count -gt 1){throw 'Ambiguous existing catalogue; no existing skill was changed.'}
        if($existingSkills.Count){$skill=$existingSkills[0]}
        else {
            $skill=Invoke-RestMethod -Uri ($base+'/skills') -Method Post -Headers $headers -WebSession $session -ContentType 'application/json' -Body (@{name=$definition.name;description=$definition.description;enabled=$true}|ConvertTo-Json -Compress)
            $skills+= $skill
            $created++
        }
        $prepared+= $skill
    }
    $changes=@()
    if($AssignSimoneExample){
        $people=Invoke-RestMethod -Uri ($base+'/participants') -WebSession $session
        $person=@($people | Where-Object {$_.id -eq '394f4f47-b646-477c-8794-192a26d90c83'})
        if($person.Count -ne 1){throw 'The explicit synthetic Simone example UUID is unavailable; no other participant is substituted.'}
        $person=$person[0]
        if(-not $person.enabled){throw 'The explicit synthetic example participant is disabled; no qualification or template requirement was changed.'}
        $enabledIds=@($prepared | Where-Object enabled | ForEach-Object id)
        $desired=@(@($person.skillIds)+$enabledIds | Sort-Object -Unique)
        if((@($person.skillIds|Sort-Object) -join ',') -ne (@($desired|Sort-Object) -join ',')){
            $saved=Invoke-RestMethod -Uri ($base+'/participants/'+$person.id+'/skills') -Method Patch -Headers $headers -WebSession $session -ContentType 'application/json' -Body (@{version=$person.version;skillIds=$desired}|ConvertTo-Json -Depth 5 -Compress)
            $changes+=@{kind='participant.skills_updated';id=$person.id;beforeVersion=$person.version;afterVersion=$saved.version;skillIds=$saved.skillIds}
        }
        $assembly=@($prepared | Where-Object {$_.name -eq 'Furniture assembly' -and $_.enabled})
        if($assembly.Count -eq 1){
            $templates=Invoke-RestMethod -Uri ($base+'/templates') -WebSession $session
            $template=@($templates | Where-Object {$_.id -eq '30000000-0000-4000-8000-000000000004'})
            if($template.Count -ne 1){throw 'The explicit synthetic assembly template UUID is unavailable; no other template is substituted.'}
            $template=$template[0]
            if($template.title -ne 'Assemble'){throw 'The known synthetic assembly template was repurposed; its requirements were not modified.'}
            $requirements=@(@($template.requiredSkillIds)+@($assembly[0].id) | Sort-Object -Unique)
            if((@($template.requiredSkillIds|Sort-Object) -join ',') -ne (@($requirements|Sort-Object) -join ',')){
                $saved=Invoke-RestMethod -Uri ($base+'/templates/'+$template.id) -Method Patch -Headers $headers -WebSession $session -ContentType 'application/json' -Body (@{version=$template.version;title=$template.title;severity=$template.severity;order=$template.order;checklist=@($template.checklist);enabled=$template.enabled;requiredSkillIds=$requirements}|ConvertTo-Json -Depth 6 -Compress)
                $changes+=@{kind='template.saved';id=$template.id;beforeVersion=$template.version;afterVersion=$saved.version;requiredSkillIds=$saved.requiredSkillIds}
            }
        }
    }
    $reportRoot=Join-Path $projectRoot '.local/skill-demo-runs'
    New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
    $reportName=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')+'_'+[Guid]::NewGuid().ToString('N').Substring(0,8)+'.json'
    [ordered]@{synthetic=$true;createdAt=[DateTime]::UtcNow.ToString('o');createdSkills=$created;catalogue=@($prepared|Select-Object id,name,enabled);changes=$changes} | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $reportRoot $reportName) -Encoding utf8
    Write-Output ('Synthetic skill catalogue ready: '+$prepared.Count+' skills; newly created '+$created+'; explicit example updates '+$changes.Count+'.')
    Write-Output 'No crew, visit, source, contact, login, password or signed history was changed.'
} finally { Invoke-RestMethod -Uri ($base+'/auth/logout') -Method Post -Headers $headers -WebSession $session -ContentType 'application/json' -Body '{}' | Out-Null }
