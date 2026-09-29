# Turbo for Claude Code — Windows installer wrapper.
# Usage (PowerShell):  .\install.ps1            install or update
#                      .\install.ps1 -Uninstall
#                      .\install.ps1 -WithPlaywright   (also installs the headless browser for /turbo:smoke)
#                      .\install.ps1 -NoPermissions    (do not touch ~/.claude/settings.json)
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$WithPlaywright,
  [switch]$NoPermissions,
  [switch]$InPlace,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js is required but was not found on PATH." -ForegroundColor Yellow
  Write-Host "Install it with:  winget install OpenJS.NodeJS.LTS   (or from https://nodejs.org), open a new terminal, and run this again."
  exit 1
}

$argsList = @()
if ($Uninstall)      { $argsList += '--uninstall' }
if ($WithPlaywright) { $argsList += '--with-playwright' }
if ($NoPermissions)  { $argsList += '--no-permissions' }
if ($InPlace)        { $argsList += '--in-place' }
if ($DryRun)         { $argsList += '--dry-run' }

& node "$PSScriptRoot\install.js" @argsList
exit $LASTEXITCODE
