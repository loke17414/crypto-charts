$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$venv = "$root\.venv"

if (-not (Test-Path "$venv\Scripts\python.exe")) {
    Write-Host "Python 가상환경 생성 중..." -ForegroundColor Cyan
    py -m venv $venv
    & "$venv\Scripts\pip.exe" install -r "$root\requirements.txt"
}

Write-Host ""
Write-Host "  API 서버 시작 (Binance Futures Testnet)" -ForegroundColor Green
Write-Host "  http://127.0.0.1:8000" -ForegroundColor Cyan
Write-Host "  웹 페이지: http://localhost:8081/trading.html" -ForegroundColor Cyan
Write-Host "  종료: Ctrl+C" -ForegroundColor Gray
Write-Host ""

Set-Location $root
& "$venv\Scripts\python.exe" -m bot.server
