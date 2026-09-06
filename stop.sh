#!/bin/bash
# Stop CodeCrab LLM router and wrapper

if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
    DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W 2>/dev/null || pwd)"
    cmd.exe /c "cd /d $DIR && stop.bat"
    exit 0
fi

# Linux/macOS
echo "Stopping LLM Router on port 3141..."
PID=$(lsof -ti :3141)
if [ -n "$PID" ]; then
    kill -9 $PID 2>/dev/null
fi
pkill -f CodeCrab 2>/dev/null

echo "All models unloaded and processes stopped."
