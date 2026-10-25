#!/bin/sh
set -eu

base=/mnt/user/appdata/spotcheckmd-postgres
. "$base/config/postgres.env"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$base/backups/spotcheckmd-$stamp.dump"
umask 077
docker exec spotcheckmd-postgres pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB" >"$target"
chmod 600 "$target"
echo "$target"
