#!/bin/bash
# Start the router and the VS Code wrapper

echo "Starting router in the background..."
cd router || exit 1
npm run dev &
ROUTER_PID=$!

cd ..

echo "Starting VS Code wrapper..."
cd vscode || exit 1
./scripts/code.sh

echo "VS Code wrapper exited. Stopping router..."
kill $ROUTER_PID
