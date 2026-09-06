#!/bin/bash
# Start the router and the VS Code wrapper

# Detect Windows environment (Git Bash, MINGW, MSYS, Cygwin)
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
    DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W 2>/dev/null || pwd)"
    cmd.exe /c "cd /d $DIR && start.bat"
    exit 0
fi

echo "Starting router in the background..."
cd router || exit 1
npm run dev &
ROUTER_PID=$!

cd ..

echo "Starting VSC"
cd vscode || exit 1
./scripts/code.sh

echo "VS Code wrapper exited. Stopping router..."
kill $ROUTER_PID
