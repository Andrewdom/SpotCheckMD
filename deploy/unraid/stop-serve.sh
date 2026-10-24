#!/bin/sh
set -eu

pid_file=/mnt/user/appdata/spotcheckmd-medgemma/tailscale-serve.pid
if [ ! -s "$pid_file" ]; then
  echo "Tailscale Serve is not running"
  exit 0
fi

pid=$(cat "$pid_file")
if kill -0 "$pid" 2>/dev/null; then
  kill "$pid"
fi
: >"$pid_file"
echo "Tailscale Serve stopped"
