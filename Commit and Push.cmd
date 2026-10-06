@echo off
rem Double-click: commits all Novi changes under your name and pushes them to GitHub.
rem Your private notes (NOVI CONTEXT.txt), .env keys and data/ are never included.
cd /d "%~dp0"
echo Changes:
git status --short
echo.
set "MSG="
set /p "MSG=Commit message (press Enter to cancel): "
if not defined MSG (echo Cancelled.& pause & exit /b)
git add -A -- . ":(exclude)NOVI CONTEXT.txt"
git commit -m "%MSG%"
if errorlevel 1 (echo Nothing to commit, or the commit failed.& pause & exit /b)
for /f %%b in ('git branch --show-current') do set "BR=%%b"
git push origin %BR%
echo.
echo Done: committed and pushed to %BR%.
pause
