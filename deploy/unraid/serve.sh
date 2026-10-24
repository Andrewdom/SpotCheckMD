#!/bin/sh
set -eu

base=/mnt/user/appdata/spotcheckmd-medgemma
pid_file="$base/tailscale-serve.pid"
log_file="$base/tailscale-serve.log"

if [ -s "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  echo "Tailscale Serve is already running"
  exit 0
fi

# This Unraid Tailscale package removes a --bg Serve configuration when the
# invoking shell exits. Keep foreground mode supervised by nohup instead.
nohup tailscale serve --yes 8321 >"$log_file" 2>&1 </dev/null &
pid=$!
echo "$pid" >"$pid_file"
sleep 2
kill -0 "$pid"
echo "Tailscale Serve started: https://f-15.tail1297e1.ts.net/"
