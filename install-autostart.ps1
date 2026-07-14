$ErrorActionPreference = "Stop"

function Get-BotDistDir {
    param([string]$Root)
    if (Test-Path (Join-Path $Root "CryptoChartsBot.exe")) {
        return $Root
    }
    return Join-Path $Root "dist"
}

$root = $PSScriptRoot
$dist = Get-BotDistDir -Root $root
$exe = Join-Path $dist "CryptoChartsBot.exe"
$taskName = "CryptoChartsBot"

if (-not (Test-Path $exe)) {
    Write-Host "CryptoChartsBot.exe 가 없습니다. 먼저 .\build-exe.ps1 를 실행하세요." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path (Join-Path $dist ".env"))) {
    Write-Host ""
    Write-Host "  .env 파일이 없습니다." -ForegroundColor Yellow
    Write-Host "  .env.example 을 .env 로 복사하고 API 키를 입력하세요." -ForegroundColor Yellow
    Write-Host "  위치: $dist" -ForegroundColor Gray
    Write-Host ""
    exit 1
}

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $dist
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "CryptoCharts RSI auto-trading bot (background)" `
    | Out-Null

Start-ScheduledTask -TaskName $taskName

Write-Host ""
Write-Host "  자동 시작 등록 완료!" -ForegroundColor Green
Write-Host ""
Write-Host "  봇 EXE:     $exe" -ForegroundColor Cyan
Write-Host "  로그:       $dist\logs\" -ForegroundColor Gray
Write-Host "  상태 파일:  $dist\bot-state.json" -ForegroundColor Gray
Write-Host ""
Write-Host "  Windows 로그인 시 자동 실행됩니다." -ForegroundColor Gray
Write-Host "  브라우저 없이 백그라운드에서 매매합니다." -ForegroundColor Gray
Write-Host ""
Write-Host "  중지:       .\stop-background.ps1" -ForegroundColor Gray
Write-Host "  등록 해제:  .\uninstall-autostart.ps1" -ForegroundColor Gray
Write-Host ""
Write-Host "  참고: PC 전원이 꺼지면 봇도 멈춥니다." -ForegroundColor Yellow
Write-Host "        24시간 운영은 PC를 켜 두거나 클라우드 VPS가 필요합니다." -ForegroundColor Yellow
Write-Host ""
