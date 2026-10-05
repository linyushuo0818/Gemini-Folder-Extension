$ErrorActionPreference = "Stop"
node (Join-Path $PSScriptRoot "package-store.mjs")
if ($LASTEXITCODE -ne 0) {
  throw "Chrome store packaging failed with exit code $LASTEXITCODE"
}
