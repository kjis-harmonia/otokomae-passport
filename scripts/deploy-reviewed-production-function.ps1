param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('johnny-notify','johnny-agent','hq-johnny','customer-passkeys','johnny-style-advice')]
  [string]$Name
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
# Human-run only AFTER DB steps 01-20 and the readiness checks in guide ⑤.
# A failure here throws before npx is invoked. There is no retry/fallback.
& (Join-Path $PSScriptRoot 'assert-production-platform-source.ps1')
& npx --yes supabase@2.121.0 functions deploy $Name --use-api --project-ref ufyzynpmkxytnhebombq --workdir $taskRoot
if ($LASTEXITCODE -ne 0) { throw ('Production function deployment failed; stop: ' + $Name) }
