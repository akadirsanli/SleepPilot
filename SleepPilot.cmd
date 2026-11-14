@echo off
rem SleepPilot launcher - double-click to start. Keep this console window open while a run is active.
setlocal
cd /d "%~dp0"
title SleepPilot
for /f %%e in ('echo prompt $E^| cmd') do set "ESC=%%e"
echo(
echo(%ESC%[93m        _..._%ESC%[0m
echo(%ESC%[93m      .'  .-'%ESC%[0m        %ESC%[1;96mSleepPilot%ESC%[0m
echo(%ESC%[93m     /   /%ESC%[0m           %ESC%[37mPlan. Build. Verify. Sleep.%ESC%[0m
echo(%ESC%[93m    ;   ;%ESC%[0m
echo(%ESC%[93m    :   :%ESC%[0m            %ESC%[90mThe UI opens in your browser.%ESC%[0m
echo(%ESC%[93m     \   '.__.-'%ESC%[0m     %ESC%[90mKeep this window open while a run is active.%ESC%[0m
echo(%ESC%[93m      '.___.-'%ESC%[0m
echo(
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
rem First launch: add a "SleepPilot" shortcut with the logo next to this file (ignored by git; delete it any time).
if exist "%~dp0SleepPilot.lnk" goto :start
if not exist "%~dp0ui\icon.ico" goto :start
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%~dp0SleepPilot.lnk'); $s.TargetPath='%~dp0SleepPilot.cmd'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%~dp0ui\icon.ico,0'; $s.Description='SleepPilot - Plan. Build. Verify. Sleep.'; $s.Save()" >nul 2>nul
:start
node "%~dp0src\main.mjs" %*
if errorlevel 1 pause
