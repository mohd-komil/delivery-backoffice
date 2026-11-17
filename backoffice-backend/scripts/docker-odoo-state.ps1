# Shared validation for the separate local Odoo integration project.
function Assert-OdooOrdinaryPath([string]$Path, [bool]$Directory) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -ne $Directory -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Odoo integration configuration requires ordinary files and directories, not links.'
    }
}
function New-OdooPrivateDirectory([string]$Path) {
    New-Item -ItemType Directory -Path $Path | Out-Null
    if ($IsWindows) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
        if ($null -eq $identity) { throw 'Unable to identify the private integration directory owner.' }
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($sid in @($identity, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                $sid, [Security.AccessControl.FileSystemRights]::FullControl,
                [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
                [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
        }
        Set-Acl -LiteralPath $Path -AclObject $acl
    } else { [IO.File]::SetUnixFileMode($Path, [IO.UnixFileMode]'UserRead,UserWrite,UserExecute') }
}
function Write-OdooPrivateFile([string]$Path, [string]$Text) {
    $stream = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($Text)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
    if (-not $IsWindows) { [IO.File]::SetUnixFileMode($Path, [IO.UnixFileMode]'UserRead,UserWrite') }
}
function Invoke-OdooDocker([string[]]$Arguments) {
    $output = & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'The isolated Odoo Docker operation failed. Existing data and configuration were retained.' }
    return $output
}
function Get-OdooConfiguration([string]$ProjectRoot, [string]$ProjectName) {
    if ($ProjectName -notmatch '^delivery-odoo-[a-z0-9]+(?:-[a-z0-9]+)*$' -or $ProjectName.Length -gt 60) { throw 'Use a separate delivery-odoo-* project name.' }
    $local = Join-Path $ProjectRoot '.local'
    $integration = Join-Path $local 'odoo-integration'
    $directory = Join-Path $integration $ProjectName
    foreach ($path in @($local, $integration, $directory, (Join-Path $directory 'secrets'))) { Assert-OdooOrdinaryPath $path $true }
    $manifestPath = Join-Path $directory 'manifest.json'
    Assert-OdooOrdinaryPath $manifestPath $false
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -AsHashtable
    if ($manifest.formatVersion -ne 1 -or $manifest.project -cne $ProjectName -or $manifest.apiPort -ne 3031 -or $manifest.manualImportsOnly -ne $true) {
        throw 'The selected directory is not a supported isolated Odoo integration configuration.'
    }
    foreach ($entry in $manifest.files.GetEnumerator()) {
        if ($entry.Key -notmatch '^(compose\.yaml|secrets/(admin_password|app_password|source_owner_password|source_reader_password|database_url|test_database_url|odoo_database_url|source_ca))$') {
            throw 'Unexpected integration manifest file entry.'
        }
        $path = Join-Path $directory $entry.Key
        Assert-OdooOrdinaryPath $path $false
        if ($entry.Value -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $entry.Value) {
            throw 'Integration configuration changed after validation. Inspect it before starting; nothing was overwritten.'
        }
    }
    if (-not $manifest.files.Contains('compose.yaml') -or $manifest.files.Count -notin @(8, 9)) { throw 'Integration file inventory is incomplete.' }
    return @{ directory = $directory; compose = (Join-Path $directory 'compose.yaml'); manifest = $manifest }
}
