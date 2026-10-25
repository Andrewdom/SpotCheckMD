#!/bin/sh
set -eu

if docker container inspect spotcheckmd-web >/dev/null 2>&1; then
  docker stop --time 30 spotcheckmd-web
  docker rm spotcheckmd-web
else
  echo "spotcheckmd-web is not installed"
fi
