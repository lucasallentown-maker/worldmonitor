#!/bin/bash
# Stops only the scanner this folder started. It does not use sudo.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="$ROOT/local-state/scanner.pid"
if [ ! -f "$PIDFILE" ]; then
  echo "The scanner is not running."
  read -r -p "Press Return to close."
  exit 0
fi
PID="$(tr -d '[:space:]' < "$PIDFILE")"
if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
  rm -f "$PIDFILE"
  echo "The scanner is not running."
  read -r -p "Press Return to close."
  exit 0
fi
COMMAND="$(ps -p "$PID" -o command= 2>/dev/null || true)"
case "$COMMAND" in
  *src/local-server.mjs*|*local-server.mjs*)
    kill "$PID"
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25; do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "$PID" 2>/dev/null; then
      echo "The scanner did not stop."
      read -r -p "Press Return to close."
      exit 1
    fi
    rm -f "$PIDFILE"
    echo "Scanner stopped."
    ;;
  *)
    echo "The recorded process is not this scanner. It was not stopped."
    read -r -p "Press Return to close."
    exit 1
    ;;
esac
read -r -p "Press Return to close."
