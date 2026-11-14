# Servidor local simples para testar o GRC + no computador (pasta docs).
# Uso: powershell -ExecutionPolicy Bypass -File tools\servidor-local.ps1   -> http://localhost:5173
param([int]$Porta = 5173)

$raiz = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\docs'))
$tipos = @{ '.html'='text/html; charset=utf-8'; '.css'='text/css; charset=utf-8'; '.js'='text/javascript; charset=utf-8';
            '.json'='application/json'; '.png'='image/png'; '.jpg'='image/jpeg'; '.svg'='image/svg+xml'; '.ico'='image/x-icon' }

$servidor = [Net.HttpListener]::new()
$servidor.Prefixes.Add("http://localhost:$Porta/")
$servidor.Start()
Write-Host "GRC + em http://localhost:$Porta  (Ctrl+C para parar)"

while ($servidor.IsListening) {
  $ctx = $servidor.GetContext()
  try {
    $caminho = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ($caminho -eq '') { $caminho = 'index.html' }
    $arquivo = [IO.Path]::GetFullPath((Join-Path $raiz $caminho))
    if ($arquivo.StartsWith($raiz) -and (Test-Path $arquivo -PathType Leaf)) {
      $bytes = [IO.File]::ReadAllBytes($arquivo)
      $ext = [IO.Path]::GetExtension($arquivo).ToLower()
      $ctx.Response.ContentType = if ($tipos[$ext]) { $tipos[$ext] } else { 'application/octet-stream' }
      $ctx.Response.Headers.Add('Cache-Control', 'no-store')
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
    }
  } catch {
    $ctx.Response.StatusCode = 500
  } finally {
    $ctx.Response.Close()
  }
}
