@echo off
rem Double-click: stop Novi from starting automatically at sign-in.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scriptsemove-autostart.ps1"
pause
