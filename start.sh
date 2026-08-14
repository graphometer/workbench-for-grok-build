#!/usr/bin/env bash
#
# Graphometer — start.
#
#   ./start.sh                    start on the default port (4311)
#   STUDIO_PORT=4318 ./start.sh   start on a different port
#
# It stops any older copy already on the port, starts a fresh server, and opens
# the app in your browser with its one-time token. Leave this terminal open;
# press Ctrl+C here to stop it, or run ./stop.sh from another terminal.
#
# AGENTS AND REVIEWERS: never run this bare. The default port (4311) may hold
# the operator's live app, and this script will stop and replace whatever
# Graphometer is there. Always set a disposable port: STUDIO_PORT=43xx ./start.sh
#
# Per-machine settings (workspace root, excluded folders) live in the untracked
# graphometer.env next to this script; the server reads it itself (D50).

set -uo pipefail
cd "$(dirname "$0")"
PORT="${STUDIO_PORT:-4311}"

# The PID listening on our port, if any (same user, so ss shows it without sudo).
port_pid() { ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2; }

# 1) Clear the port if an older Graphometer is holding it. Only ever stop OUR own
#    server (a node process running studio/server.ts) — never anything else.
OLD="$(port_pid || true)"
if [ -n "${OLD:-}" ]; then
  if ps -o cmd= -p "$OLD" 2>/dev/null | grep -q 'studio/server.ts'; then
    echo "Stopping the previous Graphometer (pid $OLD) …"
    kill -TERM "$OLD" 2>/dev/null || true
    for _ in $(seq 1 15); do [ -z "$(port_pid || true)" ] && break; sleep 1; done
  else
    echo "Port $PORT is in use by something that is not Graphometer."
    echo "Start on another port, for example:  STUDIO_PORT=4318 ./start.sh"
    exit 1
  fi
fi

# 2) Start fresh. Echo the server's own output here, and open the app the moment
#    its token URL appears — best effort, so if no browser opens, the URL is
#    still printed right here to copy. The token is never written to a file.
echo "Starting Graphometer on http://127.0.0.1:$PORT  …  (press Ctrl+C to stop)"
echo
node studio/server.ts 2>&1 | {
  # Ctrl+C signals the whole foreground process group — including this reader.
  # If the reader dies first, the server's output loses its sink exactly when
  # shutdown logging begins (the WSL release-test wedge). Ignore INT/TERM here:
  # node gets the same signal directly and shuts itself down, and this loop
  # then ends on its own when node exits and closes the pipe.
  trap '' INT TERM
  opened=""
  while IFS= read -r line; do
    printf '%s\n' "$line"
    if [ -z "$opened" ]; then
      case "$line" in
        *"127.0.0.1:$PORT/?token="*)
          url="$(printf '%s' "$line" | grep -oE "http://127\.0\.0\.1:$PORT/\?token=[0-9a-f]+")"
          if [ -n "$url" ]; then
            opened=1
            ( xdg-open "$url" >/dev/null 2>&1 \
              || sensible-browser "$url" >/dev/null 2>&1 \
              || x-www-browser "$url" >/dev/null 2>&1 \
              || true ) &
          fi
          ;;
      esac
    fi
  done
}
