#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repository"
docker build \
  --file services/medgemma/Dockerfile.unraid \
  --tag spotcheckmd-medgemma:q8-cuda \
  .
