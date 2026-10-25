#!/bin/sh
set -eu

base=/mnt/user/appdata/spotcheckmd-web
name=spotcheckmd-web
image="${1:-spotcheckmd-web:latest}"
config="$base/config/web.env"

test -r "$config"
grep -q '^MEDGEMMA_API_KEY=.' "$config"
mkdir -p "$base/data" "$base/cache"
chown -R 1001:1001 "$base/data" "$base/cache"

if docker container inspect "$name" >/dev/null 2>&1; then
  echo "$name already exists; use web-stop.sh before replacing it" >&2
  exit 1
fi

docker run --detach \
  --name "$name" \
  --restart unless-stopped \
  --network host \
  --env-file "$config" \
  --env HOSTNAME=127.0.0.1 \
  --env PORT=3340 \
  --env AURA_DATA_DIR=/data \
  --env MEDGEMMA_URL=http://127.0.0.1:8321 \
  --volume "$base/data:/data" \
  --volume "$base/cache:/app/.next/cache" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m,uid=1001,gid=1001,mode=0700 \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --memory 4g \
  --cpus 4 \
  --health-cmd 'node -e "fetch(\"http://127.0.0.1:3340/api/health\").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"' \
  --health-interval 15s \
  --health-timeout 5s \
  --health-retries 8 \
  --health-start-period 30s \
  "$image"
