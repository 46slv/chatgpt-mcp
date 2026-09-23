@echo off
setlocal
cd /d "%~dp0"

set "EPHEMERA_URL=http://127.0.0.1:4318"

start "EPHEMERA Console Server" cmd /k "cd /d ""%CD%"" && npm run console:devexec"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Milliseconds 750; $edge = Get-Command msedge.exe -ErrorAction SilentlyContinue; if ($edge) { Start-Process $edge.Source -ArgumentList '--app=%EPHEMERA_URL%' } else { Start-Process '%EPHEMERA_URL%' }"

endlocal
