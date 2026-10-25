#!/bin/sh
set -eu

dump="${1:-}"
[ -f "$dump" ] || { echo "Usage: SPOTCHECK_RESTORE_CONFIRMED=yes $0 /path/to/spotcheckmd.dump" >&2; exit 1; }
[ "${SPOTCHECK_RESTORE_CONFIRMED:-}" = yes ] || { echo "Set SPOTCHECK_RESTORE_CONFIRMED=yes after stopping the web container and preserving current data." >&2; exit 1; }
if docker inspect spotcheckmd-web --format '{{.State.Running}}' 2>/dev/null | grep -q true; then echo "Stop spotcheckmd-web before restoring PostgreSQL." >&2; exit 1; fi
. /mnt/user/appdata/spotcheckmd-postgres/config/postgres.env
docker exec -i spotcheckmd-postgres pg_restore --exit-on-error --clean --if-exists -U "$POSTGRES_USER" -d "$POSTGRES_DB" <"$dump"
echo "Database restore completed. Restore the matching media archive and validate before starting the web container."
