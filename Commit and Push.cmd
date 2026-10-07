@echo off
rem Double-click: commits all Novi changes under your name and pushes them to GitHub.
rem Your private notes (NOVI CONTEXT.txt), .env keys and data/ are never included.
rem With nothing new to commit, it still pushes commits that are not on GitHub yet.
cd /d "%~dp0"
git status --porcelain -- . ":(exclude)NOVI CONTEXT.txt" | findstr . >nul
if errorlevel 1 (echo No new changes to commit.& goto push)
echo Changes:
git status --short -- . ":(exclude)NOVI CONTEXT.txt"
echo.
set "MSG="
set /p "MSG=Commit message (press Enter to cancel): "
if not defined MSG (echo Cancelled.& pause & exit /b)
git add -A -- . ":(exclude)NOVI CONTEXT.txt"
git commit -m "%MSG%"
if errorlevel 1 (echo The commit failed.& pause & exit /b)
:push
for /f %%b in ('git branch --show-current') do set "BR=%%b"
git push origin %BR%
if errorlevel 1 (echo Push failed - check your internet or GitHub sign-in.& pause & exit /b)
echo.
echo Done: everything is on GitHub (%BR%).
pause
