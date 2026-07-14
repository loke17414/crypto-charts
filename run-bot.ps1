$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

if (-not (Test-Path "$root\.env")) {
    Copy-Item "$root\.env.example" "$root\.env"
    Write-Host ""
    Write-Host "  .env 파일이 생성되었습니다." -ForegroundColor Yellow
    Write-Host "  .env 를 열어 API 키를 설정한 뒤 다시 실행하세요." -ForegroundColor Yellow
    Write-Host "  처음에는 DRY_RUN=true, BINANCE_TESTNET=true 로 테스트하세요." -ForegroundColor Gray
    Write-Host ""
    exit 0
}

$venv = "$root\.venv"
if (-not (Test-Path "$venv\Scripts\python.exe")) {
    Write-Host "Python 가상환경 생성 중..." -ForegroundColor Cyan
    python -m venv $venv
    & "$venv\Scripts\pip.exe" install -r "$root\requirements.txt"
}

Write-Host ""
Write-Host "  Binance 자동매매 봇 시작" -ForegroundColor Green
Write-Host "  종료: Ctrl+C" -ForegroundColor Gray
Write-Host ""

Set-Location $root
& "$venv\Scripts\python.exe" -m bot.bot
