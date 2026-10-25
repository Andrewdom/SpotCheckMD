#!/bin/sh
set -eu

base=/mnt/user/appdata/spotcheckmd-postgres
web_config=/mnt/user/appdata/spotcheckmd-web/config/web.env
config="$base/config/postgres.env"
mkdir -p "$base/config" "$base/data" "$base/backups"
chmod 700 "$base" "$base/config" "$base/data" "$base/backups"
if [ -e "$config" ]; then echo "$config already exists" >&2; exit 1; fi
test -f "$web_config"
if grep -q '^DATABASE_URL=' "$web_config"; then echo "DATABASE_URL already exists in $web_config" >&2; exit 1; fi
password="$(openssl rand -hex 32)"
umask 077
cat >"$config" <<EOF
POSTGRES_USER=spotcheckmd
POSTGRES_PASSWORD=$password
POSTGRES_DB=spotcheckmd
EOF
chmod 600 "$config"
printf '\nDATABASE_URL=postgresql://spotcheckmd:%s@127.0.0.1:5433/spotcheckmd\nAUTH_RATE_LIMIT_SECRET=%s\n' "$password" "$(openssl rand -hex 32)" >>"$web_config"
chmod 600 "$web_config"
echo "Created private PostgreSQL and web configuration without printing credentials."
