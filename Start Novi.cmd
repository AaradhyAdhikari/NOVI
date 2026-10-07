@echo off
rem Double-click to start Novi (builds the UI, then serves https://localhost:3001).
rem A supervisor keeps it running and restarts it if it crashes.
cd /d "%~dp0"
netstat -ano | findstr /r /c:":3001 .*LISTENING" >nul
if not errorlevel 1 (
  echo Novi is already running. Opening it...
  start "" https://localhost:3001
  timeout /t 3 >nul
  exit /b
)
call npm.cmd start
pause
