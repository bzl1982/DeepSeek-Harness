# prepare-runtime.ps1 - Prepare runtime resources before building the Windows desktop app.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-runtime.ps1
# Outputs:
#   resources/dsh-runtime/    dsh production dependencies (npm install --omit=dev)
#   resources/node-runtime/   official Node.js win-x64 runtime
#   build/icon.ico            app icon generated from icon.png

$ErrorActionPreference = 'Stop'

$root      = Split-Path -Parent $PSScriptRoot
$resources = Join-Path $root 'resources'
$build     = Join-Path $root 'build'
$staging   = Join-Path $env:TEMP 'dsh-runtime-staging'
$iconPng   = Join-Path $build 'icon.png'
$iconIco   = Join-Path $build 'icon.ico'

# Pin the same versions that were verified to work.
$dshVersion = '0.1.5-rc.2'
$nodeVer    = 'v22.23.2'
$nodeZip    = Join-Path $resources "node-$nodeVer-win-x64.zip"
$nodeDir    = Join-Path $resources 'node-runtime'

Write-Host "[1/4] Installing dsh production deps (v$dshVersion)..." -ForegroundColor Cyan
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Force -Path $staging | Out-Null
Push-Location $staging
try {
  npm init -y | Out-Null
  npm install "@deepseek-ai/dsh@$dshVersion" --omit=dev --no-audit --no-fund
  $probe = Join-Path $staging 'node_modules\@deepseek-ai\dsh\lib\bin.js'
  if (-not (Test-Path $probe)) { throw 'dsh install incomplete: lib/bin.js missing' }
} finally {
  Pop-Location
}

Write-Host "[2/4] Copying dsh-runtime ..." -ForegroundColor Cyan
$target = Join-Path $resources 'dsh-runtime'
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
Copy-Item -Recurse $staging $target
Remove-Item -Recurse -Force $staging

Write-Host "[2.5/4] Applying whale-blue theme patch ..." -ForegroundColor Cyan
$themeClient = Join-Path $target 'node_modules\@deepseek-ai\dsh-client-ui-theme\lib\client.js'
if (-not (Test-Path $themeClient)) { throw "theme patch target missing: $themeClient" }
& node (Join-Path $root 'scripts\patch-dsh-theme.js') $themeClient
if ($LASTEXITCODE -ne 0) { throw 'whale-blue theme patch failed' }

Write-Host "[2.6/4] Applying session-cost patch (V4.1 model list + usage cost) ..." -ForegroundColor Cyan
& node (Join-Path $root 'scripts\patch-dsh-cost.js') (Join-Path $target 'node_modules')
if ($LASTEXITCODE -ne 0) { throw 'session-cost patch failed' }

Write-Host "[2.7/4] Applying about-page patch ..." -ForegroundColor Cyan
$aboutClient = Join-Path $target 'node_modules\@deepseek-ai\dsh-client-ui-settings-general\lib\client.js'
if (Test-Path $aboutClient) {
  & node (Join-Path $root 'scripts\patch-dsh-about.js') $aboutClient
  if ($LASTEXITCODE -ne 0) { throw 'about-page patch failed' }
} else {
  Write-Host "  (skip about patch: settings-general client not found)" -ForegroundColor Yellow
}

Write-Host "[3/4] Preparing official Node.js runtime ($nodeVer) ..." -ForegroundColor Cyan
if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) {
  if (-not (Test-Path $nodeZip)) {
    $url = "https://nodejs.org/dist/$nodeVer/node-$nodeVer-win-x64.zip"
    Write-Host "Downloading $url ..."
    curl.exe -sL -o $nodeZip $url
  }
  Write-Host "Extracting node runtime ..."
  $extractTo = Join-Path $resources "node-$nodeVer-win-x64"
  if (Test-Path $extractTo) { Remove-Item -Recurse -Force $extractTo }
  Expand-Archive -Path $nodeZip -DestinationPath $resources -Force
  if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
  New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
  Move-Item (Join-Path $extractTo 'node.exe') (Join-Path $nodeDir 'node.exe')
  $lic = Join-Path $extractTo 'LICENSE'
  if (Test-Path $lic) { Copy-Item $lic (Join-Path $nodeDir 'LICENSE') }
  Remove-Item -Recurse -Force $extractTo
  Remove-Item -Force $nodeZip
} else {
  Write-Host "node.exe already present, skipping download."
}

Write-Host "[4/4] Generating icon.ico ..." -ForegroundColor Cyan
if (-not (Test-Path $iconIco)) {
  Push-Location $root
  try {
    # NOTE: use cmd redirection - PowerShell '>' would corrupt the binary output.
    cmd /c "npx png-to-ico ""build\icon.png"" > ""icon.ico"" 2>nul"
    $icoInCwd = Join-Path $root 'icon.ico'
    if (Test-Path $icoInCwd) { Move-Item -Force $icoInCwd $iconIco }
  } finally {
    Pop-Location
  }
}
if (-not (Test-Path $iconIco)) { throw 'icon.ico generation failed' }

Write-Host "Runtime resources ready." -ForegroundColor Green
