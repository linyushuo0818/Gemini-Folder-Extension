$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

Write-Host "[1/5] Building extension..."
npm run build | Out-Host

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$releaseRoot = Join-Path $root "release"
$targetRoot = Join-Path $releaseRoot "firefox-upload-$timestamp"
$unpackedDir = Join-Path $targetRoot "unpacked"
$zipPath = Join-Path $targetRoot "gemini-project-extension-firefox.zip"
$manifestPath = Join-Path $unpackedDir "manifest.json"

Write-Host "[2/5] Preparing release folder..."
New-Item -ItemType Directory -Path $unpackedDir -Force | Out-Null

Write-Host "[3/5] Copying dist files..."
Copy-Item -Path (Join-Path $root "dist\*") -Destination $unpackedDir -Recurse -Force

if (!(Test-Path $manifestPath)) {
  throw "manifest.json not found in $unpackedDir"
}

Write-Host "[4/5] Adapting manifest for Firefox..."
$manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json

# Firefox currently accepts service_worker but does not require "type: module" here.
if ($manifest.background -and $manifest.background.type) {
  $manifest.background.PSObject.Properties.Remove("type")
}

$manifest | Add-Member -NotePropertyName browser_specific_settings -NotePropertyValue @{
  gecko = @{
    id = "gemini-projects@linyushuo0818.github"
    strict_min_version = "142.0"
    data_collection_permissions = @{
      required = @("none")
    }
  }
} -Force

$manifest | ConvertTo-Json -Depth 50 | Set-Content -Path $manifestPath -Encoding UTF8

Write-Host "[5/5] Creating zip..."
Compress-Archive -Path (Join-Path $unpackedDir "*") -DestinationPath $zipPath -Force

Write-Host ""
Write-Host "Done."
Write-Host "Unpacked: $unpackedDir"
Write-Host "Zip:      $zipPath"
