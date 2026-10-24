#!/bin/sh
set -eu

base=/mnt/user/appdata/spotcheckmd-medgemma
name=spotcheckmd-medgemma

test -r "$base/models/manifest.json"
test -r "$base/config/service.env"

if docker container inspect "$name" >/dev/null 2>&1; then
  if [ "$(docker inspect --format '{{.State.Running}}' "$name")" = "true" ]; then
    echo "$name is already running"
  else
    docker start "$name"
  fi
  exit 0
fi

docker run --detach \
  --name "$name" \
  --restart unless-stopped \
  --gpus all \
  --env-file "$base/config/service.env" \
  --env MEDGEMMA_BACKEND=llama_cpp \
  --env MEDGEMMA_GGUF_MANIFEST=/models/manifest.json \
  --env MEDGEMMA_LLAMA_BINARY=/usr/local/bin/llama-server \
  --env MEDGEMMA_GPU_LAYERS=20 \
  --env MEDGEMMA_THREADS=10 \
  --env MEDGEMMA_MM_PROJ_OFFLOAD=true \
  --env MEDGEMMA_KV_OFFLOAD=false \
  --publish 127.0.0.1:8321:8000 \
  --volume "$base/models:/models:ro" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=320m,uid=10001,gid=10001,mode=0700 \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --memory 24g \
  --cpus 10 \
  spotcheckmd-medgemma:q8-cuda
