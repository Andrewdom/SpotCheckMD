#!/bin/sh
set -eu

repo="${SPOTCHECK_REPOSITORY:-/mnt/user/appdata/spotcheckmd-web/repository}"
. /mnt/user/appdata/spotcheckmd-postgres/config/postgres.env
for migration in "$repo"/db/migrations/*.sql; do
  echo "Applying $(basename "$migration")"
  docker exec -i spotcheckmd-postgres psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <"$migration" >/dev/null
done
echo "PostgreSQL migrations are current."
