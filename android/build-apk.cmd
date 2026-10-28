@echo off
rem Builds the Novi phone app (debug APK) on this laptop. Double-click, or run from any folder.
rem Two Windows quirks handled here:
rem  - Java can't load files from a folder named ドキュメント, so the build runs through an ASCII
rem    junction %LOCALAPPDATA%\NoviPhoneSrc that points at this folder (made once, no admin needed).
rem  - Java's internal pipes fail in a temp folder with "~" or spaces, so they go to C:\Users\Public\NoviTmp.
setlocal
if not defined JAVA_HOME for /d %%d in ("C:\Program Files\Eclipse Adoptium\jdk-21*") do set "JAVA_HOME=%%d"
if not exist "C:\Users\Public\NoviTmp" mkdir "C:\Users\Public\NoviTmp"
set "JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:/Users/Public/NoviTmp"
set "SRC=%LOCALAPPDATA%\NoviPhoneSrc"
if not exist "%SRC%\gradlew.bat" mklink /J "%SRC%" "%~dp0." >nul
if not exist "%SRC%\local.properties" (
  echo sdk.dir=%LOCALAPPDATA:\=/%/Android/Sdk> "%SRC%\local.properties"
)
cd /d "%SRC%"
call gradlew.bat testDebugUnitTest assembleDebug --console=plain
if errorlevel 1 (
  echo.
  echo Build failed - see the messages above.
  pause
  exit /b 1
)
echo.
echo APK: %LOCALAPPDATA%\NoviPhoneBuild\app\outputs\apk\debug\app-debug.apk
pause
