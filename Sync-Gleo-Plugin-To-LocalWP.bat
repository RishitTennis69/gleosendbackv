@echo off
title Sync Gleo plugin to LocalWP
set "SRC=%~dp0gleo-wp-plugin"
set "DEST=C:\Users\Krish Grover\Local Sites\gleo-test\app\public\wp-content\plugins\gleo-wp-plugin"

if not exist "%DEST%\" (
  echo ERROR: Local site folder not found:
  echo   %DEST%
  echo Fix the path in this .bat file if your Local site name is different.
  pause
  exit /b 1
)

echo Copying plugin files ^(skipping node_modules^)...
robocopy "%SRC%" "%DEST%" /E /XD node_modules /R:2 /W:2
set "RC=%ERRORLEVEL%"
if %RC% GEQ 8 (
  echo Robocopy failed with code %RC%.
  pause
  exit /b 1
)
echo.
echo Done. In WordPress admin, refresh the Gleo page if it was already open.
pause
