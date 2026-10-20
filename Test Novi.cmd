@echo off
rem Double-click to start a TEST COPY of Novi on https://localhost:3002 next to your real Novi (3001).
rem It uses a fresh copy of your data, never the mic, orb, reminders or backups. Close this window to stop it.
cd /d "%~dp0"
title Novi TEST COPY (3002)
node scripts\test-copy.mjs
pause
