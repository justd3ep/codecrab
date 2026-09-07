@echo off
title CodeCrab LLM Router
cd /d "%~dp0router"

:: Clean up any leftover or orphaned router on port 3141
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3141" ^| findstr "LISTENING"') do (
    echo Freeing port 3141 from previous process [PID %%a]...
    taskkill /F /PID %%a /T >nul 2>&1
)

echo ========================================================
echo               CodeCrab LLM Router - Live Logs           
echo ========================================================
npm run dev
pause
