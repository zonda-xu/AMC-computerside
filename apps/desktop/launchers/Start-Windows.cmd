@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24.13 or later in the 24.x series.
  echo Download: https://nodejs.org/en/download/archive/v24.18.0
  echo See START-HERE.html for the setup guide.
  pause
  exit /b 1
)
node launch.mjs
if errorlevel 1 pause
