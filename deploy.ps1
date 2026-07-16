$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$zipPath = Join-Path $root "crypto-charts-deploy.zip"

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

$files = @(
  "index.html", "trading.html", "robots.txt", "sitemap.xml", "netlify.toml", ".nojekyll",
  "css\style.css",
  "js\app.js", "js\ta-math.js", "js\ta-extended.js", "js\indicator-catalog.js",
  "js\indicators.js", "js\drawings.js", "js\kline-loader.js",
  "js\futures-paper.js", "js\futures-strategy.js", "js\futures-api-client.js",
  "js\risk-sizing.js", "js\swing-levels.js", "js\futures-bot-app.js"
)

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')

foreach ($file in $files) {
  $fullPath = Join-Path $root $file
  if (Test-Path $fullPath) {
    $entryName = $file.Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $fullPath, $entryName) | Out-Null
  }
}
$zip.Dispose()

Write-Host ""
Write-Host "  배포 ZIP 생성 완료: $zipPath" -ForegroundColor Green
Write-Host ""
Write-Host "  [방법 1] Netlify (가장 쉬움)" -ForegroundColor Cyan
Write-Host "  1. https://app.netlify.com/drop 접속"
Write-Host "  2. crypto-charts-deploy.zip 파일을 드래그 앤 드롭"
Write-Host "  3. 생성된 URL을 구글에서 열기"
Write-Host ""
Write-Host "  [방법 2] Netlify CLI" -ForegroundColor Cyan
Write-Host "  npx netlify-cli deploy --dir . --prod"
Write-Host ""
Write-Host "  [방법 3] GitHub Pages" -ForegroundColor Cyan
Write-Host "  GitHub에 저장소 생성 후 push, Settings > Pages에서 활성화"
Write-Host ""

Start-Process "https://app.netlify.com/drop"
Start-Process "explorer.exe" -ArgumentList "/select,`"$zipPath`""
