$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$localRoot = Join-Path $projectRoot '.local'
$dockerRoot = Join-Path $localRoot 'docker'
$secretsRoot = Join-Path $dockerRoot 'secrets'
$expectedNames = @('admin_password','app_password','source_owner_password','source_reader_password','database_url','test_database_url','odoo_database_url')
$utf8 = [Text.UTF8Encoding]::new($false, $true)

function Assert-PlainDirectory([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Docker configuration paths must be ordinary directories.' }
}
function Assert-Password([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 1024 -or $Value.IndexOfAny([char[]]@([char]0,[char]10,[char]13)) -ge 0) { throw 'A required local database password is missing or invalid; no credentials were replaced.' }
}
function Expected-Urls($Values) {
    $app = [Uri]::EscapeDataString($Values['app_password'])
    $reader = [Uri]::EscapeDataString($Values['source_reader_password'])
    return @{
        database_url = "postgresql://delivery_app:${app}@db:55432/delivery_backoffice"
        test_database_url = "postgresql://delivery_app:${app}@db:55432/delivery_backoffice_test"
        odoo_database_url = "postgresql://odoo_reader:${reader}@db:55432/odoo_mock"
    }
}
function Read-ValidatedSecrets {
    Assert-PlainDirectory $secretsRoot
    $entries = @(Get-ChildItem -LiteralPath $secretsRoot -Force)
    if ($entries.Count -ne $expectedNames.Count) { throw 'Docker secrets are incomplete or contain unexpected entries. Inspect the existing directory; nothing was overwritten.' }
    $values = @{}
    foreach ($entry in $entries) {
        if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $entry.Name -cnotin $expectedNames) { throw 'Docker secrets contain an unexpected file or link; nothing was overwritten.' }
        $value = [IO.File]::ReadAllText($entry.FullName, $utf8)
        if ($value.Length -eq 0) { throw 'Docker secrets contain an empty file; nothing was overwritten.' }
        $values[$entry.Name] = $value
    }
    foreach ($name in @('admin_password','app_password','source_owner_password','source_reader_password')) { Assert-Password $values[$name] }
    $urls = Expected-Urls $values
    foreach ($name in @('database_url','test_database_url','odoo_database_url')) {
        if ($values[$name] -cne $urls[$name]) { throw 'Docker connection files do not match the local role/password/database allowlist; nothing was overwritten.' }
    }
}

foreach ($directory in @($localRoot,$dockerRoot)) {
    if (Test-Path -LiteralPath $directory) { Assert-PlainDirectory $directory }
    else { New-Item -ItemType Directory -Path $directory | Out-Null }
}
if (Test-Path -LiteralPath $secretsRoot) {
    Read-ValidatedSecrets
    Write-Output 'Docker secrets verified: seven coherent existing files retained without changes.'
    exit 0
}

$values = @{}
$credentialsPath = Join-Path $localRoot 'postgres-credentials.json'
if (Test-Path -LiteralPath $credentialsPath) {
    $credentialFile = Get-Item -LiteralPath $credentialsPath -Force
    if ($credentialFile.PSIsContainer -or ($credentialFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Native credentials must be an ordinary file.' }
    try { $native = [IO.File]::ReadAllText($credentialsPath, $utf8) | ConvertFrom-Json -AsHashtable }
    catch { throw 'Native credential file is invalid; no Docker credentials were generated.' }
    $mapping = @{ admin_password='admin'; app_password='app'; source_owner_password='sourceOwner'; source_reader_password='sourceReader' }
    foreach ($name in $mapping.Keys) {
        if ($native -isnot [Collections.IDictionary] -or -not $native.Contains($mapping[$name]) -or $native[$mapping[$name]] -isnot [string]) { throw 'Native credentials are incomplete; no Docker credentials were generated.' }
        $values[$name] = $native[$mapping[$name]]
        Assert-Password $values[$name]
    }
} else {
    foreach ($name in @('admin_password','app_password','source_owner_password','source_reader_password')) { $values[$name] = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant() }
}
$urls = Expected-Urls $values
foreach ($name in $urls.Keys) { $values[$name] = $urls[$name] }
New-Item -ItemType Directory -Path $secretsRoot | Out-Null
if ($IsWindows) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($null -eq $identity) { throw 'Unable to identify the secret-directory owner; incomplete directory retained.' }
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    $propagation = [Security.AccessControl.PropagationFlags]::None
    foreach ($sid in @($identity,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inheritance,$propagation,[Security.AccessControl.AccessControlType]::Allow))
    }
    Set-Acl -LiteralPath $secretsRoot -AclObject $acl
} else { [IO.File]::SetUnixFileMode($secretsRoot, [IO.UnixFileMode]'UserRead,UserWrite,UserExecute') }

foreach ($name in $expectedNames) {
    $stream = [IO.FileStream]::new((Join-Path $secretsRoot $name), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = $utf8.GetBytes($values[$name])
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
    if (-not $IsWindows) { [IO.File]::SetUnixFileMode((Join-Path $secretsRoot $name), [IO.UnixFileMode]'UserRead,UserWrite') }
}
Read-ValidatedSecrets
Write-Output 'Docker secrets created: seven coherent files; existing native credentials reused when available. Secret values are hidden.'
