@echo off
rem Double-click to start Novi (builds the UI, then serves https://localhost:3001).
rem A supervisor keeps it running and restarts it if it crashes.
cd /d "%~dp0"
rem Ask Novi itself (2026-11-16: netstat stopped listing Novi's port, so a running Novi looked stopped and
rem nothing opened). Falls back to the old port check if curl is missing.
where curl.exe >nul 2>nul && (curl.exe -sk -m 4 -o nul https://localhost:3001/api/health) || (netstat -ano | findstr /r /c:":3001 .*LISTENING" >nul)
if not errorlevel 1 (
  echo Novi is already running. Opening it...
  start "" https://localhost:3001
  timeout /t 3 >nul
  exit /b
)
call npm.cmd start
pause
