$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$venv = Join-Path $root ".venv"
$python = Join-Path $venv "Scripts\python.exe"
$pip = Join-Path $venv "Scripts\pip.exe"

if (-not (Test-Path $python)) {
    Write-Host "가상환경 생성 중..." -ForegroundColor Cyan
    py -m venv $venv
    & $pip install -r (Join-Path $root "requirements.txt")
}

Write-Host "PyInstaller 설치 확인..." -ForegroundColor Cyan
& $pip install pyinstaller --quiet

Set-Location $root
Write-Host "UI EXE 빌드 중 (1~3분)..." -ForegroundColor Cyan
& $python -m PyInstaller crypto-charts.spec --noconfirm
Write-Host "백그라운드 봇 EXE 빌드 중..." -ForegroundColor Cyan
& $python -m PyInstaller crypto-charts-bot.spec --noconfirm

$exe = Join-Path $root "dist\CryptoCharts.exe"
$botExe = Join-Path $root "dist\CryptoChartsBot.exe"
$dist = Join-Path $root "dist"

if ((Test-Path $exe) -and (Test-Path $botExe)) {
    Copy-Item (Join-Path $root ".env.example") (Join-Path $dist ".env.example") -Force
    Copy-Item (Join-Path $root "install-autostart.ps1") (Join-Path $dist "install-autostart.ps1") -Force
    Copy-Item (Join-Path $root "stop-background.ps1") (Join-Path $dist "stop-background.ps1") -Force
    Copy-Item (Join-Path $root "uninstall-autostart.ps1") (Join-Path $dist "uninstall-autostart.ps1") -Force

    Write-Host ""
    Write-Host "  빌드 완료!" -ForegroundColor Green
    Write-Host "  UI:         $exe" -ForegroundColor Cyan
    Write-Host "  백그라운드: $botExe" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  [차트/UI]  CryptoCharts.exe" -ForegroundColor Gray
    Write-Host "  [24h 봇]   dist\.env 설정 → .\install-autostart.ps1" -ForegroundColor Gray
    Write-Host ""
} else {
    Write-Host "빌드 실패 — dist 폴더의 exe 파일을 확인하세요." -ForegroundColor Red
    exit 1
}
