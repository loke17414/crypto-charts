$ErrorActionPreference = "SilentlyContinue"
$taskName = "CryptoChartsBot"

function Get-BotDistDir {
    param([string]$Root)
    if (Test-Path (Join-Path $Root "CryptoChartsBot.exe")) {
        return $Root
    }
    return Join-Path $Root "dist"
}

$dist = Get-BotDistDir -Root $PSScriptRoot

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Get-Process CryptoChartsBot -ErrorAction SilentlyContinue | Stop-Process -Force

$lock = Join-Path $dist "bot.lock"
if (Test-Path $lock) { Remove-Item $lock -Force }

Write-Host "백그라운드 봇을 중지했습니다." -ForegroundColor Green
