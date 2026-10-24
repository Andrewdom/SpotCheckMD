# Unraid MedGemma deployment

This deployment runs the existing authenticated SpotCheckMD wrapper and a pinned CUDA-enabled llama.cpp child in one isolated container. It uses the official MedGemma 1.5 4B source revision recorded in the private manifest, Q8_0 text weights, the F16 vision projector, one inference slot, and hybrid CPU/GPU execution for a 5 GB Quadro P2000.

Private server paths:

- `/mnt/user/appdata/spotcheckmd-medgemma/models`: GGUF files and integrity manifest, mounted read-only
- `/mnt/user/appdata/spotcheckmd-medgemma/config/service.env`: API key, mode `0600`
- `/mnt/user/appdata/spotcheckmd-medgemma/repository`: deployment checkout

Build and lifecycle commands, run from the checkout:

```sh
docker compose -f deploy/unraid/compose.yaml build
docker compose -f deploy/unraid/compose.yaml up -d
docker compose -f deploy/unraid/compose.yaml stop
docker compose -f deploy/unraid/compose.yaml start
docker compose -f deploy/unraid/compose.yaml down
docker compose -f deploy/unraid/compose.yaml logs --tail=100 medgemma
```

`restart: unless-stopped` starts the service again when Docker starts after an Unraid reboot. The wrapper binds only to host loopback on port 8321. Tailscale Serve terminates private HTTPS and proxies to that port; do not publish port 8321 on LAN/WAN or add it to Cloudflare.

Teammate Next.js configuration:

```dotenv
IMAGE_ANALYSIS_PROVIDER=medgemma
MEDGEMMA_URL=https://THE-SERVER-NAME.THE-TAILNET.ts.net
MEDGEMMA_API_KEY=the-shared-server-secret
MEDGEMMA_TIMEOUT_MS=600000
```

The key belongs only in server-side local configuration. Never use a `NEXT_PUBLIC_` variable. Teammates must be connected to the authorized Tailscale network.

Operational checks:

```sh
curl -fsS -H "Authorization: Bearer $MEDGEMMA_API_KEY" http://127.0.0.1:8321/health
docker stats --no-stream spotcheckmd-medgemma
nvidia-smi
tailscale serve status
```

If startup fails, check the container's last 100 log lines, verify both GGUF hashes against `manifest.json`, confirm the NVIDIA runtime with `nvidia-smi`, and confirm that port 8321 is unused. An out-of-memory exit should be handled by reducing `MEDGEMMA_GPU_LAYERS`; do not change the Q8 model, disable validation, or add an automatic fallback. HTTP 429 means the single inference slot is busy. Other 502 responses include a sanitized failure-stage header and should be investigated from content-free service diagnostics.
