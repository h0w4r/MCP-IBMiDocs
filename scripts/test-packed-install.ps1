$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

# Prueba el mismo artefacto npm que instalará un usuario final. Los assets se
# sirven por HTTP local para validar el flujo de descarga sin depender de red.
$root = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$testRoot = Join-Path $root ".tmp\packed-install-$stamp"
$packDirectory = Join-Path $testRoot 'npm-pack'
$prefix = Join-Path $testRoot 'prefix'
$testHome = Join-Path $testRoot 'home'
$assetDirectory = Join-Path $root '.tmp\release-assets'
New-Item -ItemType Directory -Force -Path $packDirectory, $prefix, $testHome | Out-Null

if (-not (Test-Path -LiteralPath $assetDirectory)) {
  throw "Primero ejecuta npm run release:assets. Falta: $assetDirectory"
}

$tarballName = (npm pack --pack-destination $packDirectory --silent).Trim()
$tarball = Join-Path $packDirectory $tarballName

# Obtiene un puerto libre y arranca un servidor efímero sin ventana visible.
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
$server = Start-Process -FilePath (Get-Command python).Source `
  -ArgumentList @('-m', 'http.server', "$port", '--bind', '127.0.0.1', '--directory', $assetDirectory) `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $testRoot 'http.out.log') `
  -RedirectStandardError (Join-Path $testRoot 'http.err.log')

try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      $client = [System.Net.Sockets.TcpClient]::new()
      $client.Connect('127.0.0.1', $port)
      $client.Dispose()
      $ready = $true
      break
    } catch {
      Start-Sleep -Milliseconds 300
    }
  }
  if (-not $ready) { throw 'El servidor local de assets no inició.' }

  $env:USERPROFILE = $testHome
  $env:HOME = $testHome
  $env:IBMI_DOCS_RUNTIME_ASSET_BASE_URL = "http://127.0.0.1:$port/"
  npm install -g $tarball --prefix $prefix

  Push-Location $testRoot
  try {
    & (Join-Path $prefix 'ibmi-docs.cmd') --version
    & (Join-Path $prefix 'ibmi-docs.cmd') doctor
    & (Join-Path $prefix 'ibmi-docs.cmd') validate-pack
    # La consulta ASCII evita que Windows PowerShell 5 convierta el archivo
    # UTF-8 en mojibake. Además se valida contenido, no solo código de salida.
    $answer = & (Join-Path $prefix 'ibmi-docs.cmd') assist `
      'Which IBM i command compiles ILE RPG source into a module object (*MODULE)? State the parameter that selects the source file.' `
      --language RPGLE --ibmi-version 7.6
    $answer | Write-Host
    $answerText = $answer -join "`n"
    if ($answerText.TrimStart() -notmatch '^(CRTRPGMOD Command|Create RPG Module \(CRTRPGMOD\))' `
      -or $answerText -notmatch 'SRCFILE') {
      throw 'La instalación funciona, pero ibmi-docs assist no priorizó CRTRPGMOD con SRCFILE.'
    }
  } finally {
    Pop-Location
  }

  $required = @(
    (Join-Path $testHome '.ibmi-docs\pack\manifest.json'),
    (Join-Path $testHome '.ibmi-docs\pack\ibmi-docs.sqlite'),
    (Join-Path $testHome '.ibmi-docs-mcp\models\ibmi-docs-embedding-model.json'),
    (Join-Path $testHome '.ibmi-docs-mcp\models\ibmi-docs-reranker-model.json'),
    (Join-Path $testHome '.ibmi-docs-mcp\models\ibmi-docs-query-head.json')
  )
  foreach ($file in $required) {
    if (-not (Test-Path -LiteralPath $file)) { throw "Falta artefacto instalado: $file" }
  }
  Write-Host "[ibmi-docs] Instalación empaquetada validada: $testRoot"
} finally {
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
}
