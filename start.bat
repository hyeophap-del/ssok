@echo off
title Ssok
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo   Install the LTS version from https://nodejs.org and run this file again.
  echo   (Or use the ready-made zip from "npm run package", which includes Node.js.)
  echo.
  pause
  exit /b 1
)
rem Runs in the background without a window and opens the PC page.
rem To see the log in this window instead, run: node server.js
node server.js --launch %*
if errorlevel 1 pause
