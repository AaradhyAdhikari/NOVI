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
echo Installing anything new Novi needs...
call npm.cmd install --no-audit --no-fund
netstat -ano | findstr /r /c:":3001 .*LISTENING" >nul
if not errorlevel 1 (
  echo Novi is running. Restarting it with the new version ^(this can take a minute^)...
  curl.exe -sk -m 10 -X POST https://localhost:3001/api/restart >nul
  call :waitForNovi
  if not defined UP (
    echo Novi is stuck. Ending the stuck copy so it starts again...
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":3001 .*LISTENING"') do taskkill /F /T /PID %%p >nul 2>&1
    call :waitForNovi
  )
  if not defined UP (
    echo Novi did not come back. Take a screenshot of this window and of the newest file in data\logs and send them to Claude.
    pause
    exit /b 1
  )
  start "" https://localhost:3001
  exit /b
)
call npm.cmd start
pause
exit /b

rem Waits up to 3 minutes for Novi to answer (the screen may be rebuilt first). Sets UP when it does.
:waitForNovi
set UP=
for /l %%i in (1,1,36) do (
  if not defined UP (
    timeout /t 5 >nul
    curl.exe -sk -o nul -m 4 https://localhost:3001/api/health && set UP=1
  )
)
exit /b
