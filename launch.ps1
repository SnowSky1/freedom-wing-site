param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$previewUrl = 'http://127.0.0.1:8788/'
$previewRoot = $PSScriptRoot
$previewLogRoot = Join-Path $previewRoot 'output'

function Test-FreedomWingServer {
    try {
        $response = Invoke-WebRequest -Uri $previewUrl -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -eq 200 -and $response.Content.Contains('FREEDOM WING / LIVE VIEW')
    } catch {
        return $false
    }
}

if (-not (Test-FreedomWingServer)) {
    $previewNode = Get-Command node -ErrorAction Stop
    New-Item -ItemType Directory -Path $previewLogRoot -Force | Out-Null
    $previewServerFile = Join-Path $previewRoot 'server.mjs'
    $previewProcess = Start-Process -FilePath $previewNode.Source `
        -ArgumentList @(('"' + $previewServerFile + '"'), '8788') `
        -WorkingDirectory $previewRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $previewLogRoot 'preview-server.log') `
        -RedirectStandardError (Join-Path $previewLogRoot 'preview-server-error.log')
    $previewReady = $false
    for ($previewAttempt = 0; $previewAttempt -lt 30; $previewAttempt++) {
        if (Test-FreedomWingServer) { $previewReady = $true; break }
        if ($previewProcess.HasExited) { break }
        Start-Sleep -Milliseconds 150
    }
    if (-not $previewReady) {
        throw 'Preview could not start. Check output/preview-server-error.log. Port 8788 may be in use.'
    }
    Set-Content -LiteralPath (Join-Path $previewLogRoot 'preview-server.pid') -Value $previewProcess.Id -Encoding Ascii
}

Write-Host "Freedom Wing: $previewUrl"
if (-not $NoBrowser) { Start-Process $previewUrl }
