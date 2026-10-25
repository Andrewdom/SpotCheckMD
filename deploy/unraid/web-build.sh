#!/bin/sh
set -eu

repo="${SPOTCHECK_REPOSITORY:-/mnt/user/appdata/spotcheckmd-web/repository}"
log_dir=/mnt/user/appdata/spotcheckmd-web/logs
mkdir -p "$log_dir"
cd "$repo"

commit="$(git rev-parse --short=12 HEAD)"
test "$(git branch --show-current)" = main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git status --porcelain)"

log="$log_dir/build-$commit.log"
echo "Running checks and building spotcheckmd-web:$commit (full log: $log)"
docker build --target checks --tag "spotcheckmd-web-checks:$commit" . >"$log" 2>&1
docker build --tag "spotcheckmd-web:$commit" . >>"$log" 2>&1
docker image rm "spotcheckmd-web-checks:$commit" >/dev/null 2>&1 || true
echo "spotcheckmd-web:$commit"
