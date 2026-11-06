#!/bin/bash
# Double-click starter. It does not install Node, use sudo, or change security settings.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

find_node() {
  local candidate version major
  local candidates=()
  if command -v node >/dev/null 2>&1; then
    candidates+=("$(command -v node)")
  fi
  candidates+=("/opt/homebrew/bin/node" "/usr/local/bin/node")
  local nvm_node
  for nvm_node in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$nvm_node" ] && candidates+=("$nvm_node")
  done
  for candidate in "${candidates[@]}"; do
    [ -x "$candidate" ] || continue
    version="$("$candidate" -p "process.versions.node" 2>/dev/null || true)"
    major="${version%%.*}"
    if [ -n "$major" ] && [ "$major" -ge 20 ] 2>/dev/null; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE="$(find_node || true)"
if [ -z "$NODE" ]; then
  echo "Node.js 20 or newer was not found."
  echo "Install it yourself from https://nodejs.org/ and then double-click Start Scanner.command again."
  echo "This launcher will not install Node, and it will not ask for an administrator password."
  read -r -p "Press Return to close."
  exit 1
fi

mkdir -p "$ROOT/local-state"
PIDFILE="$ROOT/local-state/scanner.pid"
if [ -f "$PIDFILE" ]; then
  OLD="$(tr -d '[:space:]' < "$PIDFILE")"
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    PORT="$(tr -d '[:space:]' < "$ROOT/local-state/port.txt" 2>/dev/null || echo 8787)"
    echo "The scanner is already running."
    echo "Open http://127.0.0.1:${PORT}/"
    if command -v open >/dev/null 2>&1; then
      open "http://127.0.0.1:${PORT}/"
    fi
    read -r -p "Press Return to close."
    exit 0
  fi
fi

nohup "$NODE" "$ROOT/src/local-server.mjs" >> "$ROOT/local-state/server.log" 2>&1 &
echo "$!" > "$PIDFILE"
disown "$!" 2>/dev/null || true

PORT=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [ -f "$ROOT/local-state/port.txt" ]; then
    PORT="$(tr -d '[:space:]' < "$ROOT/local-state/port.txt")"
    break
  fi
  sleep 0.5
done
if [ -z "$PORT" ]; then
  echo "The scanner did not start. The last lines of the log are:"
  tail -n 20 "$ROOT/local-state/server.log" 2>/dev/null || true
  read -r -p "Press Return to close."
  exit 1
fi
echo "Scanner is running at http://127.0.0.1:${PORT}/"
echo "The page refreshes itself. Leave it open. Double-click Stop Scanner.command when you want to stop."
if command -v open >/dev/null 2>&1; then
  open "http://127.0.0.1:${PORT}/"
fi
read -r -p "Press Return to close this window. The scanner keeps running."
