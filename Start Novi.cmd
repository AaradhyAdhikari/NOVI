@echo off
rem Double-click to start Novi (builds the UI, then serves https://localhost:3001)
cd /d "%~dp0"
call npm.cmd start
pause
