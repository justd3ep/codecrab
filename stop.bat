@echo off
setlocal
echo ========================================================
echo             Stopping CodeCrab & Unloading Models         
echo ========================================================

:: 1. Stop LLM Router process listening on port 3141
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3141" ^| findstr "LISTENING"') do (
    echo Terminating LLM Router [PID %%a] and freeing VRAM...
    taskkill /F /PID %%a /T >nul 2>&1
)

:: 2. Stop any CodeCrab editor processes
taskkill /F /IM CodeCrab.exe /T >nul 2>&1

echo [OK] All models unloaded from VRAM and memory.
echo [OK] All CodeCrab processes stopped.
echo ========================================================
timeout /t 2 >nul
endlocal
