@echo off
rem Double-click: start Novi automatically every time you sign in to Windows (no admin needed).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\install-autostart.ps1"
choice /m "Start Novi now as well"
if errorlevel 2 goto end
schtasks /run /tn Novi >nul
:end
pause
