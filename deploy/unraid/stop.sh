#!/bin/sh
set -eu

if docker container inspect spotcheckmd-medgemma >/dev/null 2>&1; then
  docker stop spotcheckmd-medgemma
else
  echo "spotcheckmd-medgemma does not exist"
fi
