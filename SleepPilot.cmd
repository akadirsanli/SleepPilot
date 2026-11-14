@echo off
rem SleepPilot launcher - double-click to start. Keep this console window open while a run is active.
setlocal
cd /d "%~dp0"
title SleepPilot
where node >nul 2>nul
if errorlevel 1 (
  echo [SleepPilot] Node.js not found. Install Node.js 20.10 or newer from https://nodejs.org
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node --version') do set NODE_MAJOR=%%v
set NODE_MAJOR=%NODE_MAJOR:v=%
if %NODE_MAJOR% LSS 20 (
  echo [SleepPilot] Node.js 20.10 or newer is required. Installed version:
  node --version
  pause
  exit /b 1
)
node "%~dp0src\main.mjs" %*
if errorlevel 1 pause
