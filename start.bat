@echo off
REM Start the router and the VS Code wrapper

echo Starting router in a new window...
cd router
start "CrabKode Router" cmd /c npm run dev

cd ..

echo Starting VSC
cd vscode
call scripts\code.bat
