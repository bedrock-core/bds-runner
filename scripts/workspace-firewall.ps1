[CmdletBinding(SupportsShouldProcess = $true)]
param([Parameter(Mandatory = $true)][string]$Plan)
$ErrorActionPreference = 'Stop'

$configuration = Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json
if ($configuration.policy -ne 'local-only') { throw 'Only the local-only BDS policy is supported.' }

if (-not $WhatIfPreference) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run workspace-bds --apply from an Administrator terminal.'
    }
}

# Block all external addresses; loopback remains available to local clients.
$external = @('0.0.0.0-126.255.255.255', '128.0.0.0-255.255.255.255', '::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')
$root = [IO.Path]::GetFullPath($configuration.root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar

foreach ($rule in $configuration.rules) {
    $program = [IO.Path]::GetFullPath($rule.program)
    if (-not $program.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or
        $program -notmatch '[\\/]\.bds[\\/]server[\\/][^\\/]+[\\/][^\\/]+\.exe$' -or
        $rule.name -notmatch '^BedrockCore-[a-f0-9]{24}$') {
        throw "Invalid workspace executable rule: $program"
    }

    if ($PSCmdlet.ShouldProcess($program, 'Block external inbound BDS traffic on all profiles')) {
        $existing = Get-NetFirewallRule -Name $rule.name -PolicyStore PersistentStore -ErrorAction SilentlyContinue
        $settings = @{
            Direction = 'Inbound'; Action = 'Block'; Profile = 'Any'; Enabled = 'True'
            Program = $program; Protocol = 'Any'; RemoteAddress = $external
            LocalAddress = 'Any'
            PolicyStore = 'PersistentStore'
        }
        if ($existing) {
            Set-NetFirewallRule -Name $rule.name @settings
        } else {
            New-NetFirewallRule -Name $rule.name -DisplayName "@bedrock-core BDS: $program" `
                -Group '@bedrock-core GameTests' @settings | Out-Null
        }
    }
}
