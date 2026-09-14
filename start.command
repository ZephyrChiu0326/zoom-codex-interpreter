#!/bin/zsh
cd "$(dirname "$0")" || exit 1
echo "Starting Zoom Codex Interpreter local service..."
python3 server.py
echo
echo "Service stopped. Press Enter to close."
read -r
