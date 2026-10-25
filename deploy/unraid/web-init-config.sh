#!/bin/sh
set -eu

base=/mnt/user/appdata/spotcheckmd-web
config="$base/config/web.env"

mkdir -p "$base/config" "$base/data" "$base/cache"
chmod 700 "$base/config" "$base/data" "$base/cache"
chown -R 1001:1001 "$base/data" "$base/cache"

if [ -e "$config" ]; then
  echo "$config already exists; leaving it unchanged"
  exit 0
fi

medgemma_key="$(docker inspect spotcheckmd-medgemma --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^MEDGEMMA_API_KEY=//p' | head -n 1)"
if [ "${#medgemma_key}" -lt 16 ]; then
  echo "Could not securely reuse the existing MedGemma key" >&2
  exit 1
fi

umask 077
cat > "$config" <<EOF
IMAGE_ANALYSIS_PROVIDER=medgemma
MEDGEMMA_API_KEY=$medgemma_key
MEDGEMMA_TIMEOUT_MS=600000
TRANSCRIPTION_PROVIDER=assemblyai
ASSEMBLYAI_API_KEY=
ASSEMBLYAI_TIMEOUT_MS=180000
SPOTCHECK_IMAGE_UPLOAD_MAX_MB=50
SPOTCHECK_IMAGE_MAX_PIXELS=60000000
SPOTCHECK_INFERENCE_IMAGE_MAX_MB=256
EOF
unset medgemma_key
chmod 600 "$config"
echo "Created $config with the existing MedGemma key. Add ASSEMBLYAI_API_KEY securely before enabling transcription."
