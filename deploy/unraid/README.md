# Unraid MedGemma deployment

This deployment runs the existing authenticated SpotCheckMD wrapper and a pinned CUDA-enabled llama.cpp child in one isolated container. It uses the official MedGemma 1.5 4B source revision recorded in the private manifest, Q8_0 text weights, the F16 vision projector, one inference slot, and hybrid CPU/GPU execution for a 5 GB Quadro P2000.

Private server paths:

- `/mnt/user/appdata/spotcheckmd-medgemma/models`: GGUF files and integrity manifest, mounted read-only
- `/mnt/user/appdata/spotcheckmd-medgemma/config/service.env`: API key, mode `0600`
- `/mnt/user/appdata/spotcheckmd-medgemma/repository`: deployment checkout

The target Unraid 7.1.4 host has Docker without the Compose plugin. Build and start it with the checked-in scripts:

```sh
deploy/unraid/build.sh
deploy/unraid/run.sh
deploy/unraid/stop.sh
deploy/unraid/run.sh  # starts the existing stopped container
deploy/unraid/serve.sh
deploy/unraid/stop-serve.sh
docker logs --tail=100 spotcheckmd-medgemma
```

`compose.yaml` documents the equivalent configuration for hosts with Docker Compose. Do not run both forms on the same host. To recreate the container after an image/configuration change, stop it, explicitly remove only `spotcheckmd-medgemma`, and rerun `run.sh`.

`restart: unless-stopped` starts the service again when Docker starts after an Unraid reboot. The wrapper binds only to host loopback on port 8321. Tailscale Serve terminates private HTTPS and proxies to that port; do not publish port 8321 on LAN/WAN or add it to Cloudflare.

Teammate Next.js configuration:

```dotenv
IMAGE_ANALYSIS_PROVIDER=medgemma
MEDGEMMA_URL=https://f-15.tail1297e1.ts.net
MEDGEMMA_API_KEY=the-shared-server-secret
MEDGEMMA_TIMEOUT_MS=600000
```

The key belongs only in server-side local configuration. Never use a `NEXT_PUBLIC_` variable. Teammates must be connected to the authorized Tailscale network.

The current private endpoint is `https://f-15.tail1297e1.ts.net/`. On this
Unraid Tailscale package, the checked-in `serve.sh` keeps foreground Serve
mode alive after the SSH shell exits. This does not change the existing
Cloudflare tunnel. Check the process and endpoint with:

```sh
tailscale serve status
test -s /mnt/user/appdata/spotcheckmd-medgemma/tailscale-serve.pid
curl -I https://f-15.tail1297e1.ts.net/
```

Operational checks:

```sh
curl -fsS -H "Authorization: Bearer $MEDGEMMA_API_KEY" http://127.0.0.1:8321/health
docker stats --no-stream spotcheckmd-medgemma
nvidia-smi
tailscale serve status
```

If startup fails, check the container's last 100 log lines, verify both GGUF hashes against `manifest.json`, confirm the NVIDIA runtime with `nvidia-smi`, and confirm that port 8321 is unused. An out-of-memory exit should be handled by reducing `MEDGEMMA_GPU_LAYERS`; do not change the Q8 model, disable validation, or add an automatic fallback. HTTP 429 means the single inference slot is busy. Other 502 responses include a sanitized failure-stage header and should be investigated from content-free service diagnostics.

After an Unraid reboot, Docker restarts the inference container through its
`unless-stopped` policy. Once Tailscale is online, run `deploy/unraid/serve.sh`
from the deployment checkout to restore private HTTPS. The script is
idempotent. Add that exact command to an array-start User Scripts job only if
automatic HTTPS restoration is desired.
