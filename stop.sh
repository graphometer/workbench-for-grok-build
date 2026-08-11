#!/usr/bin/env bash
#
# Graphometer — stop.
#
#   ./stop.sh                    stop the server on the default port (4311)
#   STUDIO_PORT=4318 ./stop.sh   stop the server on another port
#
# Use this when the server is running in another terminal or in the background
# (so Ctrl+C can't reach it). It only ever stops OUR own server, never anything
# else on the port. Shutdown is graceful: it cleans up the agent and re-checks
# ~/.grok/config.toml on the way out.

set -uo pipefail
cd "$(dirname "$0")"
PORT="${STUDIO_PORT:-4311}"

PID="$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)"
if [ -z "${PID:-}" ]; then
  echo "Nothing is listening on port $PORT."
  exit 0
fi

if ps -o cmd= -p "$PID" 2>/dev/null | grep -q 'studio/server.ts'; then
  echo "Stopping Graphometer (pid $PID) …"
  kill -TERM "$PID" 2>/dev/null || true
  for _ in $(seq 1 15); do
    ss -ltn 2>/dev/null | grep -q ":$PORT " || { echo "Stopped."; exit 0; }
    sleep 1
  done
  echo "Still shutting down — give it a moment, then check again."
else
  echo "Port $PORT is used by something that is not Graphometer; leaving it alone."
  exit 1
fi
