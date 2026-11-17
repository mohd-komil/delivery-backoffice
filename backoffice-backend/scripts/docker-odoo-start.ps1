param(
    [string]$ProjectName = 'delivery-odoo-integration',
    [string]$GeocodingSettingsFile,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'docker-odoo-state.ps1')
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$configuration = Get-OdooConfiguration $projectRoot $ProjectName
$composeArguments = @('compose', '--project-name', $ProjectName, '--file', $configuration.compose)
if ($GeocodingSettingsFile) {
    # Keep the provider key out of the image, environment values and tracked configuration.
    # The base source configuration and its integrity manifest remain unchanged.
    $settingsPath = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $GeocodingSettingsFile).Path)
    Assert-OdooOrdinaryPath $settingsPath $false
    $geocodingOverride = [ordered]@{
        services = @{
            backend = @{
                environment = @{ GEOAPIFY_SETTINGS_FILE = '/run/secrets/geoapify_settings.json' }
                volumes = @(@{
                    type = 'bind'; source = $settingsPath; target = '/run/secrets/geoapify_settings.json'
                    read_only = $true; bind = @{ create_host_path = $false }
                })
            }
        }
    }
    $overridePath = Join-Path $configuration.directory 'geocoding.compose.yaml'
    $overrideText = (ConvertTo-Json -InputObject $geocodingOverride -Depth 10).Replace('$', '$$')
    if (Test-Path -LiteralPath $overridePath) {
        Assert-OdooOrdinaryPath $overridePath $false
        # JSON object key order is not stable across PowerShell processes. Validate the
        # exact allowed shape and values instead of treating formatting as configuration.
        $existing = Get-Content -LiteralPath $overridePath -Raw | ConvertFrom-Json -AsHashtable
        $backendOverride = $existing.services.backend
        $mount = @($backendOverride.volumes)[0]
        $matches = $existing.Count -eq 1 -and $existing.services.Count -eq 1 -and
            $backendOverride.Count -eq 2 -and $backendOverride.environment.Count -eq 1 -and
            $backendOverride.environment.GEOAPIFY_SETTINGS_FILE -ceq '/run/secrets/geoapify_settings.json' -and
            @($backendOverride.volumes).Count -eq 1 -and $mount.Count -eq 5 -and
            $mount.type -ceq 'bind' -and $mount.source -ceq $settingsPath -and
            $mount.target -ceq '/run/secrets/geoapify_settings.json' -and
            $mount.read_only -is [bool] -and $mount.read_only -and
            $mount.bind.Count -eq 1 -and $mount.bind.create_host_path -is [bool] -and -not $mount.bind.create_host_path
        if (-not $matches) {
            throw 'The existing geocoding override differs. Inspect it before changing the settings-file path; nothing was overwritten.'
        }
    } elseif (-not $ValidateOnly) {
        Write-OdooPrivateFile $overridePath $overrideText
    }
    if (Test-Path -LiteralPath $overridePath) { $composeArguments += @('--file', $overridePath) }
    elseif ($ValidateOnly) {
        throw 'The geocoding override has not been created. Run startup once with -GeocodingSettingsFile before validating this optional configuration.'
    }
}
Invoke-OdooDocker ($composeArguments + @('config', '--quiet')) | Out-Null
# Existing resources may be reused only when they belong to this separate project.
foreach ($name in @('pg-data', 'app-data')) {
    $volumeName = $ProjectName + '_' + $name
    $existing = @(Invoke-OdooDocker @('volume', 'ls', '--filter', ('name=^' + $volumeName + '$'), '--format', '{{.Name}}'))
    if ($existing.Count) {
        $label = Invoke-OdooDocker @('volume', 'inspect', '--format', '{{index .Labels "com.docker.compose.project"}}', $volumeName)
        if ($label -cne $ProjectName) { throw 'An integration volume name is owned by another project; startup refused.' }
    }
}
foreach ($name in @('default', 'source-access')) {
    $networkName = $ProjectName + '_' + $name
    $existing = @(Invoke-OdooDocker @('network', 'ls', '--filter', ('name=^' + $networkName + '$'), '--format', '{{.Name}}'))
    if ($existing.Count) {
        $label = Invoke-OdooDocker @('network', 'inspect', '--format', '{{index .Labels "com.docker.compose.project"}}', $networkName)
        if ($label -cne $ProjectName) { throw 'An integration network name is owned by another project; startup refused.' }
        $internal = Invoke-OdooDocker @('network', 'inspect', '--format', '{{.Internal}}', $networkName)
        $expected = if ($name -eq 'default') { 'true' } else { 'false' }
        if ($internal -cne $expected) { throw 'Integration network isolation differs from the configured network role.' }
    }
}
if ($ValidateOnly) {
    Write-Output 'Odoo integration configuration and existing volume ownership validated. No service was started.'
    exit 0
}
Invoke-OdooDocker ($composeArguments + @('build', 'backend', 'migrate')) | Out-Host
Invoke-OdooDocker ($composeArguments + @('up', '--detach', '--wait', '--wait-timeout', '120', 'db', 'backend')) | Out-Host
Write-Output 'Isolated Odoo API is available at http://127.0.0.1:3031/api. Imports are manual; no polling worker was created.'
