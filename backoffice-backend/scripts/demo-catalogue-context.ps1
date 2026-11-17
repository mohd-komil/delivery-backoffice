function Get-DemoCatalogueContext {
    param([string]$ProjectRoot, [switch]$CustomerDevelopment)
    # These are the two explicitly local development stands, never a caller-supplied URL.
    $api = if ($CustomerDevelopment) { 'http://127.0.0.1:3031/api' } else { 'http://127.0.0.1:3001/api' }
    $origin = if ($CustomerDevelopment) { 'http://127.0.0.1:3030' } else { 'http://127.0.0.1:3000' }
    $expectedModel = if ($CustomerDevelopment) { 'Odoo customer-schema test copy (read only)' } else { 'synthetic Odoo teaching model' }
    $health = Invoke-RestMethod -Uri ($api + '/health')
    if ($health.status -ne 'ok' -or $health.database -ne 'delivery_backoffice' -or $health.sourceModel -ne $expectedModel) {
        throw 'The selected local development API does not match the expected catalogue seed target.'
    }
    $relativeAccounts = if ($CustomerDevelopment) { '.local/odoo-integration/delivery-odoo-customerdev/demo-accounts.json' } else { '.local/demo-accounts.json' }
    $accounts = Get-Content -Raw -LiteralPath (Join-Path $ProjectRoot $relativeAccounts) | ConvertFrom-Json
    $session = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
    $headers = @{ Origin = $origin }
    $user = Invoke-RestMethod -Uri ($api + '/auth/login') -Method Post -Headers $headers -WebSession $session -ContentType 'application/json' -Body (@{ email = $accounts.admin.email; password = $accounts.admin.password } | ConvertTo-Json -Compress)
    if ($user.role -ne 'admin') { throw 'Administrator account required.' }
    return @{ api = $api; headers = $headers; session = $session }
}
