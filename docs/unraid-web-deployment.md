# SpotCheckMD web deployment on Unraid

This deployment runs the complete Next.js application beside the existing MedGemma service. It is a single-node hackathon setup for fictional or authorized demonstration inputs. It is not a claim of HIPAA compliance, clinical validation, or production readiness.

## Topology

```text
browser --HTTPS--> Cloudflare Tunnel --HTTP loopback--> 127.0.0.1:3340 SpotCheckMD web
                                                        |
                                                        +--HTTP loopback + bearer auth--> 127.0.0.1:8321 MedGemma
                                                        +--HTTPS--> AssemblyAI
```

Both application ports remain bound to server loopback. `CloudflaredTunnel` uses host networking and publishes only the selected SpotCheckMD hostname. The raw MedGemma API, Docker, SSH, and Unraid administration are not routes for the SpotCheckMD hostname.

The web container uses host networking because the established MedGemma container publishes only to host loopback. This preserves the existing MedGemma container and avoids adding a LAN or public inference listener. MedGemma bearer authentication remains required.

## Persistent server layout

```text
/mnt/user/appdata/spotcheckmd-web/
  config/web.env       # mode 0600; secrets; never committed
  data/                # encounters, normalized images, audio, transcripts, Demo EHR
  cache/               # writable Next.js runtime cache
  logs/                # retained build logs
  repository/          # deployment checkout of approved main
```

The container mounts `data` at `/data` and sets `AURA_DATA_DIR=/data`. Rebuilding or replacing the web container does not remove saved demo encounters. Back up this directory according to the server owner's normal appdata policy.

## First installation

Run these commands on Unraid. The checkout used for live deployment must be a clean, reviewed `main` commit.

```sh
mkdir -p /mnt/user/appdata/spotcheckmd-web
git clone https://github.com/Andrewdom/SpotCheckMD.git /mnt/user/appdata/spotcheckmd-web/repository
cd /mnt/user/appdata/spotcheckmd-web/repository
git checkout main
deploy/unraid/web-init-config.sh
```

`web-init-config.sh` securely copies the existing MedGemma bearer value from the running `spotcheckmd-medgemma` container into the private web env file without printing it. It does not rotate the key. Edit the private file locally on the server and add the permanent AssemblyAI key:

```sh
nano /mnt/user/appdata/spotcheckmd-web/config/web.env
chmod 600 /mnt/user/appdata/spotcheckmd-web/config/web.env
```

Do not paste the key into chat, a command argument, Docker labels, Git, or a `NEXT_PUBLIC_` variable. `ASSEMBLYAI_API_KEY` remains server-side. The browser requests a short-lived streaming token from the authenticated application route.

Build and start the initial reviewed revision:

```sh
cd /mnt/user/appdata/spotcheckmd-web/repository
git fetch origin main
git pull --ff-only origin main
image="$(deploy/unraid/web-build.sh | tail -n 1)"
deploy/unraid/web-run.sh "$image"
```

The build script runs TypeScript checks, the repository tests, and a production Next.js build using the committed lockfile. Full build output stays in `/mnt/user/appdata/spotcheckmd-web/logs`.

## Cloudflare Tunnel route

The existing connector is a remotely managed Cloudflare Tunnel. Add one public hostname in the Cloudflare dashboard for the existing tunnel:

- Hostname: the owner-selected SpotCheckMD hostname
- Service type: `HTTP`
- Origin URL: `http://127.0.0.1:3340`
- Path: empty

Leave all existing hostname routes unchanged. Do not create a route for port 8321. During development, protect the hostname with a Cloudflare Access application limited to approved teammate identities. Before a judge demo, deliberately choose either a time-bounded Access policy for judge identities or public demo access, then remove or restrict it after judging.

Cloudflare terminates HTTPS, which enables browser camera and microphone APIs. Live captions connect from the browser to AssemblyAI using a short-lived token. The finalized audio upload and transcription run through the server. Test the app's configured 50 MB image limit through the final hostname because the effective request limit also depends on the Cloudflare account plan.

## Asynchronous analysis

`Analyze & review` creates a persistent queued job and returns immediately. The browser polls the encounter while one in-process worker serializes jobs for MedGemma's single inference slot. The job owns the encounter revision and source snapshot, so later edits or consent changes cancel it and prevent stale results from being attached.

The worker retries MedGemma HTTP 429 responses with bounded backoff. A server restart changes a persisted `processing` job back to `queued`; it never marks an interrupted inference complete. On successful completion, the existing evidence validation, source IDs, model revision, prompt version, uncertainty, warnings, and physician review gates remain attached to the stored results.

This mechanism is deliberately single-node and single-container. Do not run multiple web replicas against the JSON store.

## Updates and rollback

After an approved pull request is merged to `main`:

```sh
cd /mnt/user/appdata/spotcheckmd-web/repository
deploy/unraid/web-deploy.sh
```

The script refuses a dirty checkout or a revision that differs from `origin/main`. It builds and checks the new image before stopping the old web container. If the new health check fails, it restores the previous image. It never stops or replaces `spotcheckmd-medgemma`.

To stop and start manually:

```sh
deploy/unraid/web-stop.sh
deploy/unraid/web-run.sh spotcheckmd-web:<approved-commit>
```

The web container uses Docker's `unless-stopped` restart policy. It starts again after Docker and the Unraid array are available. The existing Cloudflare connector remains independently managed.

## Verification and troubleshooting

Routine checks do not print credentials:

```sh
curl -fsS http://127.0.0.1:3340/api/health
docker inspect spotcheckmd-web --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}'
docker stats --no-stream spotcheckmd-web spotcheckmd-medgemma
docker logs --tail 100 spotcheckmd-web
```

From inside the web container, verify authenticated MedGemma health without echoing the key:

```sh
docker exec spotcheckmd-web node -e 'fetch(process.env.MEDGEMMA_URL+"/health",{headers:{Authorization:"Bearer "+process.env.MEDGEMMA_API_KEY}}).then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(()=>process.exit(1))'
```

Failure categories:

- Web health fails: inspect the web container logs and writable volume ownership.
- MedGemma health is 401: the private web env key does not match the existing service key.
- MedGemma health cannot connect: confirm `spotcheckmd-medgemma` is running and still publishes `127.0.0.1:8321`.
- Analysis stays queued: check the web logs and confirm the worker has one running web instance.
- Analysis reports busy: another client is using MedGemma; the worker retries a bounded number of times and then records a reviewable failure.
- Dictation fails: confirm `ASSEMBLYAI_API_KEY` is present in the private env file, outbound HTTPS works, the recording is doctor-only, and container logs contain no credential values.
- Public hostname fails while loopback health works: inspect only the new Cloudflare hostname mapping and connector status; do not change unrelated routes.

For validation, first confirm infrastructure and persistence. Then use one authorized SCIN or synthetic demonstration image for a single end-to-end MedGemma inference. Use one short doctor-only recording for AssemblyAI only after the owner authorizes the paid call. Do not infer clinical validation from these deployment checks.
