#!/bin/sh
set -eu

base=/mnt/user/appdata/spotcheckmd-postgres
config="$base/config/postgres.env"
test -r "$config"
if docker container inspect spotcheckmd-postgres >/dev/null 2>&1; then echo "spotcheckmd-postgres already exists" >&2; exit 1; fi
docker run --detach \
  --name spotcheckmd-postgres \
  --restart unless-stopped \
  --publish 127.0.0.1:5433:5432 \
  --env-file "$config" \
  --volume "$base/data:/var/lib/postgresql/data" \
  --health-cmd 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  --health-interval 10s \
  --health-timeout 5s \
  --health-retries 12 \
  --security-opt no-new-privileges:true \
  postgres:16-alpine
