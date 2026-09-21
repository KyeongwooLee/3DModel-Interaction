$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) {
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python venv creation failed' }
}
if (-not (Test-Path -LiteralPath '.venv/roi-ready')) {
    & ./.venv/Scripts/python.exe -m pip install -r requirements-lock.txt
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed' }
    & ./.venv/Scripts/python.exe prepare_runtime.py
    if ($LASTEXITCODE -ne 0) { throw 'Tracker compatibility preparation failed' }
    New-Item -ItemType File -Path '.venv/roi-ready' -Force | Out-Null
}
if (-not (Test-Path -LiteralPath 'node_modules/@sparkjsdev/spark')) {
    npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Viewer dependency installation failed' }
}
& ./.venv/Scripts/python.exe server.py --port 9443
