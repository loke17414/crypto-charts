$ErrorActionPreference = "SilentlyContinue"
$taskName = "CryptoChartsBot"

& "$PSScriptRoot\stop-background.ps1" | Out-Null
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false

Write-Host "자동 시작 등록을 해제했습니다." -ForegroundColor Green
