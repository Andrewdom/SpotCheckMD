# Unraid MedGemma service deployment

This deployment runs the SpotCheckMD authenticated image-analysis wrapper and a pinned CUDA-enabled `llama.cpp` child process in one container on Unraid. It is configured for the official **MedGemma 1.5 4B** model, Q8_0 text weights, an F16 vision projector, one inference slot, and hybrid CPU/GPU execution for a 5 GB Quadro P2000. The private model manifest records the exact source revision and model-file hashes.

The service is for research and authorized demonstration inputs only. The application uses MedGemma as its only image-analysis provider and has no automatic alternate-model fallback. It is not clinically validated and must not be used with real patient data in this prototype.

## Private server files

- `/mnt/user/appdata/spotcheckmd-medgemma/models`: GGUF model files and integrity manifest; mounted read-only in the container.
- `/mnt/user/appdata/spotcheckmd-medgemma/config/service.env`: server settings and bearer key; restrict permissions to mode `0600`.
- `/mnt/user/appdata/spotcheckmd-medgemma/repository`: deployment checkout.

Keep credentials out of source control, browser code, `NEXT_PUBLIC_` variables, logs, and screenshots. Never print or paste the shared API key.

## Build and run

The target Unraid 7.1.4 host uses Docker without the Compose plugin. From the repository checkout:

```sh
deploy/unraid/build.sh
deploy/unraid/run.sh
deploy/unraid/serve.sh
```

Stop the HTTPS proxy and container with:

```sh
deploy/unraid/stop-serve.sh
deploy/unraid/stop.sh
```

`compose.yaml` documents an equivalent setup for hosts with Docker Compose. Do not run both deployment methods on the same host. The container uses Docker's `unless-stopped` policy. Tailscale Serve must be restored after Tailscale comes online following a reboot; `serve.sh` is idempotent.

The service wrapper binds to host loopback on port 8321. Tailscale Serve provides private HTTPS access. Do not publish port 8321 to LAN/WAN or expose the model through a public tunnel. The phone browser should open the SpotCheckMD app itself at a reachable HTTPS URL; there is no QR pairing or cross-device encounter sync. The phone browser and desktop browser have separate anonymous workspaces.

## Configure the Next.js app

Set these server-side variables in ignored `.env.local` or a secret manager. Use the existing shared server key through a secure entry method:

```dotenv
IMAGE_ANALYSIS_PROVIDER=medgemma
MEDGEMMA_URL=https://<private-tailscale-host>
MEDGEMMA_API_KEY=<existing-shared-server-secret>
MEDGEMMA_TIMEOUT_MS=600000
```

The placeholders are examples, not working credentials. The web app must be connected to the authorized Tailscale network. HTTPS is required except for loopback development addresses. The web app's inference-image upload limit must not exceed the service limit.

## Service limits and checks

By default, the wrapper accepts authenticated multipart JPEG/PNG requests up to 256 MB and 60 megapixels. Multipart parsing may spool to `/tmp`; the container reserves a private 320 MB tmpfs. Change `MEDGEMMA_MAX_IMAGE_MB` or `MEDGEMMA_MAX_IMAGE_PIXELS` only after checking container memory and tmpfs capacity.

Use content-free operational checks:

```sh
curl -fsS -H "Authorization: Bearer $MEDGEMMA_API_KEY" http://127.0.0.1:8321/health
docker stats --no-stream spotcheckmd-medgemma
nvidia-smi
tailscale serve status
docker logs --tail=100 spotcheckmd-medgemma
```

Avoid shell tracing or commands that echo environment values. HTTP 429 means the single inference slot is occupied. Sanitized 502 failure-stage information can guide troubleshooting without logging image or transcript contents. On startup failures, check container logs, available resources, model hashes in the private manifest, NVIDIA runtime visibility, and whether port 8321 is already in use. If memory is insufficient, adjust the documented GPU-layer setting conservatively; do not disable validation or silently change the model/runtime.

After an Unraid reboot, Docker restarts the container. Once Tailscale is online, run `deploy/unraid/serve.sh` from the deployment checkout to restore private HTTPS. To make that automatic, add that exact command to an Unraid array-start User Scripts job.

## MedGemma 1.5 reference

```bibtex
@article{sellergren2026medgemma,
  title={MedGemma 1.5 Technical Report},
  author={Sellergren, Andrew and Gao, Chufan and Mahvar, Fereshteh and Kohlberger, Timo and Jamil, Fayaz and Traverse, Madeleine and Tono, Alberto and Sadjad, Bashir and Yang, Lin and Lau, Charles and others},
  journal={arXiv preprint arXiv:2604.05081},
  year={2026}
}
```

[arXiv:2604.05081](https://arxiv.org/abs/2604.05081). Model usage is subject to the [HAI-DEF terms](https://developers.google.com/health-ai-developer-foundations/terms); the example repository's code license does not replace the model terms.
