#!/bin/sh
set -eu

base=/mnt/user/appdata/spotcheckmd-web
repo="$base/repository"
export SPOTCHECK_REPOSITORY="$repo"
cd "$repo"

test -z "$(git status --porcelain)"
git fetch origin main
git checkout main
git pull --ff-only origin main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git status --porcelain)"

new_image="$(deploy/unraid/web-build.sh | tail -n 1)"
old_image="$(docker inspect spotcheckmd-web --format '{{.Config.Image}}' 2>/dev/null || true)"

deploy/unraid/web-stop.sh
if ! deploy/unraid/web-run.sh "$new_image"; then
  echo "New container failed to start; restoring $old_image" >&2
  docker rm -f spotcheckmd-web >/dev/null 2>&1 || true
  test -n "$old_image" && deploy/unraid/web-run.sh "$old_image"
  exit 1
fi

for _ in 1 2 3 4 5 6 7 8; do
  status="$(docker inspect spotcheckmd-web --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}starting{{end}}')"
  [ "$status" = healthy ] && { echo "Deployed $new_image"; exit 0; }
  [ "$status" = unhealthy ] && break
  sleep 5
done

echo "Health check failed; restoring $old_image" >&2
docker logs --tail 50 spotcheckmd-web >&2 || true
docker rm -f spotcheckmd-web >/dev/null 2>&1 || true
test -n "$old_image" && deploy/unraid/web-run.sh "$old_image"
exit 1
