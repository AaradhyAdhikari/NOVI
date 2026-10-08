@echo off
chcp 65001 >nul
rem One-time setup for "Only my voice" + "Hey Novi" interrupt. Put this file in the NOVI folder
rem (next to Start Novi.cmd) and double-click it.
cd /d "%~dp0"
if not exist "Start Novi.cmd" (
  echo This file must be in the NOVI folder, next to "Start Novi.cmd". Move it there and try again.
  pause
  exit /b 1
)
echo [1/4] Getting the new Novi code...
git stash -u
git fetch origin claude/ecstatic-brahmagupta-0bsazo || goto :fail
git switch claude/ecstatic-brahmagupta-0bsazo || git switch -c claude/ecstatic-brahmagupta-0bsazo --track origin/claude/ecstatic-brahmagupta-0bsazo || goto :fail
git pull --ff-only
git stash pop
echo [2/4] Installing...
call npm.cmd install || goto :fail
echo [3/4] Downloading the speaker model (about 26 MB)...
if not exist models\speaker mkdir models\speaker
if not exist models\speaker\wespeaker_en_voxceleb_resnet34.onnx curl.exe -L -o models\speaker\wespeaker_en_voxceleb_resnet34.onnx https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34.onnx || goto :fail
echo [4/4] Done. Starting Novi - then open Settings, "Hey Novi", and press "Learn my voice".
call "Start Novi.cmd"
exit /b 0
:fail
echo.
echo Something went wrong (see the red text above). Take a screenshot of this window and send it to Claude.
pause
exit /b 1
