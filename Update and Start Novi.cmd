@echo off
rem Double-click to get the latest Novi from GitHub and start it (or restart it if it is running).
rem The screen is rebuilt automatically when its code changed.
cd /d "%~dp0"
echo Getting the latest Novi...
git checkout main
git pull --no-rebase --no-edit origin main
if errorlevel 1 (
  echo.
  echo Could not update. Take a screenshot of the message above and send it to Claude.
  pause
  exit /b 1
)
netstat -ano | findstr /r /c:":3001 .*LISTENING" >nul
if not errorlevel 1 (
  echo Novi is running. Restarting it with the new version...
  curl.exe -sk -X POST https://localhost:3001/api/restart >nul
  timeout /t 20 >nul
  start "" https://localhost:3001
  exit /b
)
call npm.cmd start
pause
