@echo off
rem Builds the Novi phone app (debug APK) on this laptop. Double-click, or run from any folder.
rem Java's internal pipes fail in a temp folder with "~" in its name (C:\Users\AARADH~1\...),
rem so they go to C:\Users\Public\NoviTmp instead.
setlocal
if not defined JAVA_HOME for /d %%d in ("C:\Program Files\Eclipse Adoptium\jdk-21*") do set "JAVA_HOME=%%d"
if not exist "C:\Users\Public\NoviTmp" mkdir "C:\Users\Public\NoviTmp"
set "JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:/Users/Public/NoviTmp"
cd /d "%~dp0"
if not exist local.properties (
  echo sdk.dir=%LOCALAPPDATA:\=/%/Android/Sdk> local.properties
)
call gradlew.bat testDebugUnitTest assembleDebug --console=plain
if errorlevel 1 (
  echo.
  echo Build failed - see the messages above.
  pause
  exit /b 1
)
copy /y app\build\outputs\apk\debug\app-debug.apk Novi.apk >nul
echo.
echo APK: %~dp0Novi.apk
pause
