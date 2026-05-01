@echo off
title Gleo Node API
cd /d "%~dp0gleo-node-api"
echo.
echo  ========================================
echo   Gleo API  (http://localhost:8765)
echo  ========================================
echo   Leave this window OPEN while you use
echo   Gleo in WordPress. Close it to stop.
echo  ========================================
echo.
where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm was not found. Install Node.js from https://nodejs.org
  echo Then try this file again.
  pause
  exit /b 1
)
if not exist "node_modules\" (
  echo First-time setup: installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)
call npm start
pause
