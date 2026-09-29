param([string]$Target = "dist")
function Publish-Site {
  param($Path)
  Write-Host "publishing $Path"
}
Publish-Site -Path $Target
