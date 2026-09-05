@echo off
setlocal
cd /d "%~dp0"

set "NATIVE_CONSOLE_URL=http://127.0.0.1:4319"

start "Native Dev Exec Console" cmd /k "cd /d ""%CD%"" && npm run console:native"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Milliseconds 750; $edge = Get-Command msedge.exe -ErrorAction SilentlyContinue; if ($edge) { Start-Process $edge.Source -ArgumentList '--app=%NATIVE_CONSOLE_URL%' } else { Start-Process '%NATIVE_CONSOLE_URL%' }"

endlocal

