$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

Write-Host "[1/4] Building extension..."
npm run build | Out-Host

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$releaseRoot = Join-Path $root "release"
$targetRoot = Join-Path $releaseRoot "store-upload-$timestamp"
$unpackedDir = Join-Path $targetRoot "unpacked"
$zipPath = Join-Path $targetRoot "gemini-project-extension-store.zip"

Write-Host "[2/4] Preparing release folder..."
New-Item -ItemType Directory -Path $unpackedDir -Force | Out-Null

Write-Host "[3/4] Copying dist files..."
Copy-Item -Path (Join-Path $root "dist\*") -Destination $unpackedDir -Recurse -Force

Write-Host "[4/4] Creating zip..."
Compress-Archive -Path (Join-Path $unpackedDir "*") -DestinationPath $zipPath -Force

$manifestCount = (Get-ChildItem -Path $unpackedDir -Recurse -Filter "manifest.json" | Measure-Object).Count
if ($manifestCount -ne 1) {
  throw "Invalid package: expected exactly one manifest.json, found $manifestCount"
}

Write-Host ""
Write-Host "Done."
Write-Host "Unpacked: $unpackedDir"
Write-Host "Zip:      $zipPath"
