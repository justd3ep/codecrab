@echo off
setlocal
REM Start CodeCrab LLM Router and VS Code wrapper

echo ========================================================
echo               Starting CodeCrab LLM System               
echo ========================================================

:: Check for restart flag
if "%~1"=="restart" goto do_restart
if "%~1"=="-r" goto do_restart
goto check_port

:do_restart
echo Stopping previous router and unloading VRAM...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3141" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a /T >nul 2>&1
)
timeout /t 1 /nobreak >nul

:check_port
:: Check if Router is already listening on port 3141
netstat -ano | findstr ":3141" | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
    echo [1/2] Launching LLM Router live log window...
    start "CodeCrab LLM Router" cmd /k "title CodeCrab LLM Router && cd /d "%~dp0router" && npm run dev"
    echo Waiting for LLM Router to initialize on port 3141...
    :wait_router
    timeout /t 1 /nobreak >nul
    netstat -ano | findstr ":3141" | findstr "LISTENING" >nul 2>&1
    if errorlevel 1 (
        goto wait_router
    )
    echo LLM Router is online and ready!
) else (
    echo [1/2] LLM Router is already active on port 3141.
    echo       (Run 'stop.bat' to kill it, or 'start.bat restart' to relaunch the log window)
)

echo [2/2] Starting CodeCrab VS Code wrapper...
cd /d "%~dp0vscode"
call scripts\code.bat

endlocal
