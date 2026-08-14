@echo off
setlocal
cd /d "%~dp0"
title LLM API Tester - Development

call npm.cmd run desktop
if errorlevel 1 (
  echo.
  echo Launch failed. Run npm install in this folder first.
  pause
)

endlocal
