$port = 8080
$root = $PSScriptRoot

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()

Write-Host ""
Write-Host "  CryptoCharts 서버가 시작되었습니다!" -ForegroundColor Green
Write-Host "  브라우저에서 http://localhost:$port 를 열어주세요." -ForegroundColor Cyan
Write-Host "  종료하려면 Ctrl+C 를 누르세요." -ForegroundColor Gray
Write-Host ""

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $path = $ctx.Request.Url.LocalPath
  if ($path -eq '/') { $path = '/index.html' }

  $file = Join-Path $root ($path.TrimStart('/').Replace('/', '\'))

  if (Test-Path $file -PathType Leaf) {
    $bytes = [System.IO.File]::ReadAllBytes($file)
    $ctx.Response.ContentType = switch -Regex ($file) {
      '\.css$' { 'text/css; charset=utf-8' }
      '\.js$'  { 'application/javascript; charset=utf-8' }
      '\.html$'{ 'text/html; charset=utf-8' }
      default  { 'application/octet-stream' }
    }
    $ctx.Response.Headers.Add('Cache-Control', 'no-cache')
    $ctx.Response.ContentLength64 = $bytes.Length
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $ctx.Response.StatusCode = 404
  }
  $ctx.Response.Close()
}
