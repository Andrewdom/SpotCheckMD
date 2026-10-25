# MedGemma 1.5 contextual image analysis

This is a synthetic/authorized-data hackathon feature, not clinically validated software. No model is trained. The official pretrained model is exactly `google/medgemma-1.5-4b-it`; there is no automatic model fallback.

## Architecture and scope

Audio → existing OpenAI `gpt-transcribe` → separately stored unverified transcript.

Each oriented, metadata-stripped lossless image + specialty + declared image type + explicitly confirmed location + physician context + quality warnings + exact transcript windows → selected image provider → schema/evidence validation → pending visual findings and conflicts.

Separately, transcript windows → existing GPT-4o documentation function → pending spoken findings. The deterministic SOAP composer includes accepted findings only in an approved snapshot. Image observations enter O; image-generated history is displayed as contextual information rather than silently treated as a verified visual fact or duplicated in SOAP. A/P from the transcript requires uncertainty/attribution review. A transcript quote that matches text still does not prove the finding is true.

Provider implementations are in `lib/image-analysis/providers.ts`, orchestration in `pipeline.ts`, and runtime contracts in `contracts.ts`. The Python service shares the generated JSON Schema and prompt under `contracts/`. Run `npm run generate:contracts` after intentional schema/prompt changes; a test detects drift.

The input scope is authorized JPEG/PNG 2D images converted into lossless PNG inference copies. The specialty selector includes general, primary care, urgent care, dermatology, radiology, and other; legacy skin/throat encounters still load. This is context selection, not a claim of validated specialty performance. There is no HEIC, DICOM, 3D CT/MRI, whole-slide, video, or PDF ingestion. A radiograph selection means an authorized 2D rendering, not interpretation of a full study. Unsupported/insufficient views must return limitations or not-assessable observations.

Multiple images are processed separately; each visual finding must cite the exact image in its request. Transcript citations are explicitly labeled context rather than visual proof. Source IDs, quote substrings, characteristic/conflict IDs, and anatomy attribution are validated in both services. The schema prohibits additional fields but cannot guarantee semantic clinical correctness. Physician inspection remains essential.

Long transcripts are retained up to 100,000 characters, then processed in overlapping windows of complete punctuation/newline-delimited utterances of at most 6,000 characters. Every character is covered; no keyword selection, summary, or silent truncation is used. An indivisible oversized utterance is rejected with a visible warning rather than cut in half. Windowing can still lose relationships across distant statements: reviewers must inspect the full transcript. Multiple windows repeat the image request and increase latency/cost. Exact duplicate findings are deduplicated within a run; nonidentical overlapping findings require review.

## Model access and license

Before downloading weights, the operator must log into Hugging Face and accept the model's HAI-DEF access terms on the [official model page](https://huggingface.co/google/medgemma-1.5-4b-it). Supply a token with access to that repository as `HF_TOKEN` on the Python host only. This implementation does not accept terms on anyone's behalf.

The model is governed by the [Health AI Developer Foundations Terms of Use](https://developers.google.com/health-ai-developer-foundations/terms). The [Google example repository](https://github.com/Google-Health/medgemma) uses Apache-2.0 for its code; that does not replace the separate model terms. Review the model's intended-use restrictions and any hosting/distribution obligations for your use. Do not use this prototype for diagnosis, treatment, or real patient records.

The [model card](https://developers.google.com/health-ai-developer-foundations/medgemma/model-card) documents the image/text Transformers interface used here. The [hardware FAQ](https://developers.google.com/health-ai-developer-foundations/faqs) discusses memory and hosted deployment options. Plan for a CUDA GPU with approximately 24 GB VRAM for a practical BF16 development setup; actual requirements vary with context, token budget and concurrency. This implementation serializes inference and does not quantize or switch devices automatically. CPU FP32 is explicitly selectable for experimentation, but needs substantially more RAM and may exceed request timeouts. GPU throughput and memory have not been measured for this application.

## Local setup

Use the feature checkout and Node >=20.9.0. Python 3.11+ is recommended. The Python inference environment is separate from Next.js.

```sh
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r services/medgemma/requirements.txt
```

Install the appropriate CUDA-compatible PyTorch build for your host if needed. Dependency ranges are bounded, not a GPU-tested lockfile; freeze exact versions for a reproducible deployment after verification on that host. Model downloads need network access and cache disk space.

**Intel macOS limitation:** The current `torch>=2.6` service requirements do not resolve on macOS x86_64: compatible PyTorch wheels are unavailable. This was checked on an Intel i9 Mac with 16 GiB RAM and a 4 GiB AMD Radeon Pro 5500M. Selecting `MEDGEMMA_DEVICE=cpu` does not fix package compatibility; FP32 model weights also leave insufficient practical memory headroom on that machine. For that hardware, see the explicit experimental quantized CPU backend below. It does not change the default Transformers backend.

For local model access, install the Hugging Face CLI (`uv tool install 'huggingface-hub>=1,<2'`), accept the official model's terms in your own account, then run `hf auth login` interactively. Login and model access are separate: a valid login can still receive HTTP 403 until the model's conditions have been accepted by the same account. Never supply a token in chat, a committed file, or a command-line argument. The library can use the resulting local token cache; `HF_TOKEN` remains an alternative for service environments.

Configure the Python service environment through your shell or secret manager (not source files):

| Variable | Purpose/default |
| --- | --- |
| `HF_TOKEN` | Hugging Face access token for the gated official model; Python only |
| `HF_HOME` | Optional persistent private model-cache directory |
| `MEDGEMMA_API_KEY` | Required shared service credential, at least 16 characters; use a random secret |
| `MEDGEMMA_MODEL_REVISION` | Official model repository revision; defaults to `main`; pin a verified commit for reproducibility |
| `MEDGEMMA_DEVICE` | `cuda` by default; explicit `cpu` uses FP32, with no automatic device fallback |
| `MEDGEMMA_BACKEND` | `transformers` by default; explicit `llama_cpp` selects the experimental native CPU backend below |

```sh
.venv/bin/uvicorn services.medgemma.service:app --host 127.0.0.1 --port 8000 --workers 1 --no-access-log
```

Model loading occurs at startup; missing access, unavailable CUDA, or invalid configuration prevents startup. `/health` requires the shared bearer credential and becomes available after loading. Do not print or paste tokens while diagnosing connectivity.

Configure the Next.js server in ignored `.env.local` or deployment secrets:

| Variable | Purpose/default |
| --- | --- |
| `IMAGE_ANALYSIS_PROVIDER` | Optional explicit value `medgemma`; unset also selects MedGemma. Other values are rejected in the application workflow. |
| `MEDGEMMA_URL` | Full service base URL, e.g. `http://127.0.0.1:8000`; HTTPS required off loopback |
| `MEDGEMMA_API_KEY` | Same shared service credential; never use a `NEXT_PUBLIC_` variable |
| `MEDGEMMA_TIMEOUT_MS` | Default 120000; allowed 1000–600000 milliseconds per image/context request |
| `OPENAI_API_KEY` | Optional audio transcription and transcript documentation only; the separate research comparison utility supplies its GPT-4o image adapter directly |
| `AURA_DATA_DIR` | Existing storage override; keep demo media and transcripts outside source control |

The Python service does not read Next.js `.env.local` automatically. Set the shared key in both processes. Keep `HF_TOKEN` on the inference host. MedGemma image-only operation does not require an OpenAI key. Audio and transcript documentation still do; those failures are reported independently.

```sh
npm run dev
```

In the app, choose a fictional encounter, confirm consent, save specialty/image type and any confirmed context, and capture authorized media. Analyze, inspect image thumbnails, transcript excerpts, attribution, limitations, and conflicts; accept/reject/edit each finding. Acknowledge partial-analysis warnings before approving. Export remains a local simulation. A model failure never switches to GPT-4o. The GPT-4o image adapter remains available only to the explicit research comparison utility.

## Experimental Intel Mac / native CPU backend

This opt-in path converts the **official** authorized safetensors locally; it does not download an unverified third-party quantization. The text model uses Q4_K_M and the vision projector uses F16. Quantization and a different inference implementation can change results. The UI labels this runtime as experimental, and results retain source/converter/runtime revisions and both artifact SHA-256 hashes. Do not pool these outputs with full-precision Transformers results without identifying the runtime.

The runtime owns an authenticated `127.0.0.1` llama.cpp child process, uses four CPU threads and one inference slot, and disables native request logging, Web UI and context shifting. It verifies artifact hashes and the binary's reported Git revision at startup. Its temporary internal key is removed on orderly shutdown. The existing Python wrapper still validates JSON/evidence and enforces its external shared key. The client times out after 570 seconds; configure Next.js for 600000 ms. CPU inference can remain impractical for larger encounters; a timeout is a failure, never a model fallback.

The tested build/conversion recipe pins llama.cpp revisions because converter and runtime dependencies differ on Intel macOS. The older PyTorch package below is used only for isolated safetensors conversion; the serving process does not import it. Do not downgrade the Transformers inference service environment.

From the repository root, after model access is granted:

```sh
spotcheck_cache="$HOME/.cache/spotcheckmd"
mkdir -p "$spotcheck_cache"
uv venv .venv-local --python 3.12
uv pip install --python .venv-local/bin/python cmake -r services/medgemma/requirements-local.txt
git clone https://github.com/ggml-org/llama.cpp.git "$spotcheck_cache/llama.cpp"
git -C "$spotcheck_cache/llama.cpp" checkout --detach edc353842c1be9b4ebc27460a1da4526a026d3a9
git -C "$spotcheck_cache/llama.cpp" worktree add --detach "$spotcheck_cache/llama-converter-b6000" 4762ad7316dcdec20016ab5985fb46a27902204d
.venv-local/bin/cmake -S "$spotcheck_cache/llama.cpp" -B "$spotcheck_cache/llama.cpp/build-spotcheck" \
  -DGGML_METAL=OFF -DGGML_BLAS=ON -DGGML_BLAS_VENDOR=Apple -DLLAMA_OPENSSL=OFF \
  -DLLAMA_BUILD_TESTS=OFF -DCMAKE_BUILD_TYPE=Release
.venv-local/bin/cmake --build "$spotcheck_cache/llama.cpp/build-spotcheck" --target llama-server llama-quantize -j 4
uv venv "$spotcheck_cache/converter-venv" --python 3.12
uv pip install --python "$spotcheck_cache/converter-venv/bin/python" \
  torch==2.2.2 numpy==1.26.4 transformers==4.51.3 sentencepiece==0.2.2 safetensors==0.8.0 protobuf==4.25.9
"$spotcheck_cache/converter-venv/bin/python" services/medgemma/prepare_local.py \
  --converter "$spotcheck_cache/llama-converter-b6000" \
  --llama-server "$spotcheck_cache/llama.cpp/build-spotcheck/bin/llama-server" \
  --output "$spotcheck_cache/medgemma-1.5-q4"
```

Use a new output directory; preparation refuses an existing one. The script pins official model revision `91850547d9f0b2fdd21aa7c5f4f3d1a8a52c243b`, checks source weight hashes against Hugging Face metadata, and writes the manifest, conversion log, source hashes and converter package versions. Downloads total approximately 8.6 GB; allow at least 25 GB free for the source cache and conversion artifacts. Preparation is not proof of successful or clinically correct inference. On an interrupted conversion, inspect the private log and choose a new output directory for an explicit retry. Keep these files outside source control.

Set these variables in the service environment, alongside `MEDGEMMA_API_KEY`:

| Variable | Local setting |
| --- | --- |
| `MEDGEMMA_BACKEND` | `llama_cpp` |
| `MEDGEMMA_GGUF_MANIFEST` | Absolute path to the generated `manifest.json` |
| `MEDGEMMA_LLAMA_BINARY` | Absolute path to the pinned `llama-server` binary |

Start the wrapper with the existing Uvicorn command using `.venv-local/bin/uvicorn`. If you store local configuration in an ignored, permission-restricted `.env.local`, add `--env-file .env.local`; the local requirements include dotenv support. Never commit or display that file. The Next.js process needs `IMAGE_ANALYSIS_PROVIDER=medgemma`, `MEDGEMMA_URL=http://127.0.0.1:8000`, the same shared key, and `MEDGEMMA_TIMEOUT_MS=600000`. Use a fresh `AURA_DATA_DIR` for testing. Image-only tests do not need an OpenAI key.

The native runtime accepts verified `Q4_K_M` or `Q8_0` manifests. GPU use remains explicit through `MEDGEMMA_GPU_LAYERS` (0–34), `MEDGEMMA_MM_PROJ_OFFLOAD`, and `MEDGEMMA_KV_OFFLOAD`; `MEDGEMMA_THREADS` is bounded to 1–64. Defaults preserve the CPU configuration. Small GPUs should use hybrid inference and keep the KV cache in system memory rather than silently changing quantization.

With the service running, this command sends two real requests through the TypeScript adapter: a generated non-patient geometric diagram alone and the same diagram with explicitly fictional transcript context. It checks response/evidence contracts, writes private outputs, and reports failures without grading clinical quality:

```sh
node --env-file=.env.local --import tsx scripts/verify-local-medgemma.ts /private/new-verification-dir --run-live
```

## Private SCIN integration verification

[SCIN](https://github.com/google-research-datasets/scin) contains real-person dermatology photographs and self-reported metadata. It is governed by the [SCIN Data Use License](https://github.com/google-research-datasets/scin/blob/main/LICENSE), which includes attribution requirements and prohibits re-identification. Images may be sensitive or graphic. Keep all downloaded images, metadata, generated manifests and model reports outside the repository. This workflow permits only loopback HTTP or private Tailscale HTTPS to the authenticated MedGemma service; do not send SCIN material to OpenAI or another external provider.

The preparation utility pins the official metadata object generations used for selection, excludes the publicly reported missing image, rejects paths outside the official image directory, validates JPEG/PNG decoding, and removes duplicate hashes within the prepared subset. Selection rotates deterministic skin-tone buckets when labels are available and requires a reported nonsensitive body location. Skin-tone metadata is used only for test-set selection. Dermatologist condition labels never enter the generated model manifest or transcript.

Prepare one case in a new private directory after reviewing the license:

```sh
.venv-local/bin/python scripts/prepare_scin.py \
  /private/scin-integration-001 --count 1 \
  --run-download --accept-scin-license
```

This downloads the two pinned metadata CSVs (about 2.2 MB total) and only enough candidate images to obtain the requested number of valid, unique files. It writes `comparison-manifest.json` for the existing input contract and a separate `scin-provenance.json` containing source object paths, hashes, release, selection metadata and attribution. Both files are private dataset material. A failed candidate download/decoding check remains excluded from the manifest; the utility continues deterministically to the next candidate.

Start with the image-only variant. The service must already be running with the local backend and the Node process must have the matching loopback URL/key:

```sh
node --env-file=.env.local --import tsx scripts/verify-scin-medgemma.ts \
  /private/scin-integration-001/comparison-manifest.json \
  /private/scin-image-only-001 \
  --variant image-only --run-live
```

Only after that report has `status: "success"`, run the identical case with its clearly labeled SCIN self-report context:

```sh
node --env-file=.env.local --import tsx scripts/verify-scin-medgemma.ts \
  /private/scin-integration-001/comparison-manifest.json \
  /private/scin-context-001 \
  --variant image-and-context --run-live
```

The report separates image decoding, generation, JSON parsing, Python schema/evidence validation, TypeScript schema/evidence validation and source attribution. It preserves sanitized failure stages and contains no clinical score. Keep failed reports. For a later 5–10 case set, rerun preparation with `--count`; do not silently reuse results from another metadata generation or runtime.

### Local SCIN verification recorded October 24, 2026

Two unique SCIN cases completed both local variants on the pinned CPU runtime. All four requests passed image decoding, generation, JSON parsing, Python schema/evidence validation, TypeScript schema/evidence validation and source-attribution checks. The measured end-to-end times were approximately 110 and 96 seconds for the first case, then 276 and 234 seconds for the second case (image-only and image-with-context respectively). A five-case private manifest was prepared, but the remaining three cases were left unrun when the project owner asked to stop testing after the second case passed. One next-case request had begun before the queue was interrupted; it was cancelled and has no successful report.

These results establish that the corrected local transport and validation pipeline can return contract-valid output for those two inputs. They are not a measurement of clinical accuracy, fairness, diagnostic performance or readiness for clinical use. Images, metadata, manifests and reports remain in private ignored directories and were not committed.

### Unraid Q8 verification recorded October 24, 2026

The dedicated Unraid service completed one authorized SCIN image-only request
through private Tailscale HTTPS. The request passed image decoding, Q8_0 model
generation, JSON parsing, Python schema/evidence validation, TypeScript
schema/evidence validation, and source attribution in approximately 52.0
seconds end to end (51.5 seconds reported by the service). Peak sampled usage
was 3.057 GiB container RAM, 3,690 MiB GPU memory, and 955% container CPU on
the 10-CPU limit. The project owner asked to stop after this image passed, so
the SCIN context variant was not run on the server.

This is an integration result for one input, not clinical validation or a
performance guarantee. The SCIN photograph, derived context, API key, and
generated report remain in private permission-restricted directories outside
the repository.

## Hosted service

The included Dockerfile packages this same API wrapper, not a generic Hugging Face/Vertex prediction endpoint. Build from the repository root:

```sh
docker build -f services/medgemma/Dockerfile -t spotcheckmd-medgemma .
docker run --rm --gpus all -p 127.0.0.1:8000:8000 \
  -e HF_TOKEN -e MEDGEMMA_API_KEY -e MEDGEMMA_MODEL_REVISION \
  spotcheckmd-medgemma
```

Use a GPU-capable Docker host with the NVIDIA container runtime. Supply secrets at runtime, and use a writable persistent private cache when appropriate; do not bake credentials or model weights into a public image. For a remote GPU VM/container, put the wrapper behind TLS and network access controls; preserve bearer authorization, disable request-body/access logging, and set the proxy body limit to the configured service image limit plus multipart overhead (257 MB for the default 256 MB image limit). Configure the Next.js server's `MEDGEMMA_URL` to that HTTPS base URL and allow the configured inference timeout. The wrapper bounds request size, returns redacted validation errors, rejects concurrent inference with 429, and does not persist inputs. It does not establish a complete privacy or retention policy for hosting infrastructure.

A raw Vertex AI/Model Garden endpoint has a different request/authentication contract and is **not** a drop-in URL for this adapter. Deploy this wrapper or implement and test a separate endpoint adapter. Docker/GPU/hosted deployment has not been executed in the development checks below.

The dedicated Unraid Q8/CUDA deployment is documented in [`deploy/unraid/README.md`](../deploy/unraid/README.md). Its host port is loopback-only and intended to sit behind private Tailscale Serve HTTPS. Teammate SpotCheckMD instances set `MEDGEMMA_URL` to the server's `https://...ts.net` URL and retain the shared bearer key in server-side configuration.

Use a long-running Node server for the app. One encounter can make several sequential calls; short serverless request limits may terminate it. The service caps generated tokens and requests a generation time limit; GPU work may finish after a client disconnect. There is no durable job queue or instant remote cancellation. Encounter run ownership, revision checks before each external call, and commit checks prevent stale output from replacing newer edits. Expired runs can be retried after 30 minutes; an old worker cannot complete a newer run.

## High-resolution image path and model limitation

The browser accepts JPEG and PNG. `SPOTCHECK_IMAGE_UPLOAD_MAX_MB` defaults to 50 MB (allowed configuration range 1–200 MB), and `SPOTCHECK_IMAGE_MAX_PIXELS` defaults to 60 million pixels (range 1–100 million). Sharp decodes the image with the pixel bound, applies EXIF orientation, strips metadata, and writes a lossless PNG at the oriented source dimensions. It does not impose the former 1600 × 1600 resize or JPEG quality-85 recompression. `SPOTCHECK_INFERENCE_IMAGE_MAX_MB` defaults to 256 MB (range 10–512 MB) because a lossless PNG can be larger than its uploaded JPEG. A separate maximum-1200-pixel JPEG is used only for browser previews. The local demo retains the lossless inference copy rather than the original metadata-bearing upload.

The Next.js provider sends the lossless inference copy as an authenticated multipart file, with bounded JSON metadata in a separate form field. This removes base64's size overhead and the former 14-million-character field/15 MB request caps. The Python service defaults to `MEDGEMMA_MAX_IMAGE_MB=256` and `MEDGEMMA_MAX_IMAGE_PIXELS=60000000`, validates the declared and decoded formats, and does not persist the request. The Unraid container's private `/tmp` tmpfs is 320 MB so Starlette can spool a maximum-size multipart file.

Full-dimension transport does not mean native-resolution model vision. The [official MedGemma 1.5 4B model card](https://huggingface.co/google/medgemma-1.5-4b-it) states that images are normalized to 896 × 896 and encoded as 256 tokens each. The pinned llama.cpp backend uses the converted MedGemma vision projector and this integration does not enable a separate crop, pan-and-scan, or tiling pass. Response diagnostics record the dimensions and bytes received by the service alongside the 896 × 896/256-token model contract, and the review UI displays both. Large uploads therefore preserve detail through transport and storage, but detail discarded by the model's internal normalization cannot be recovered or claimed as analyzed. With a fixed 256 vision tokens, larger source files primarily increase upload, decode, temporary-storage, and preprocessing costs rather than the language-model context length.

HEIC/HEIF remains unsupported. Sharp codec availability differs across packaged development environments, so accepting it would make successful decoding machine-dependent. Convert authorized inputs to JPEG or PNG before upload without adding patient-identifying metadata.

## Compatibility and review semantics

Existing records remain readable: new context, provenance, warning and run fields are optional. No destructive migration is run. Old `skin`/`throat` labels remain accepted. Previously stored transcripts are reused. Retry replaces pending AI proposals while retaining clinician additions and previous accepted/rejected findings; review potential duplicate or contradictory observations across runs. Upload retains the prior application's behavior of clearing findings/conflicts and invalidating approval.

Changing context or another encounter field revokes approval and cancels an active run. Uncertainty, limited-quality evidence, edits, unresolved conflicts, and retake evidence retain their approval gates. Warning acknowledgement is an additional gate for partial failures. Review edits reopen linked conflicts. The note preview and clipboard include uncertainty/limitations/reviewer notes; copied pending lines are marked pending.

The app uses manually seeded physician accounts with PostgreSQL-backed cross-device sessions. This MVP identity boundary and typed note signature are not production actor authorization. The aggregate persistence and single MedGemma inference slot still support one web container.

## Verification

```sh
npm test
npm run build
npm run typecheck
python3 -m venv .venv-test
.venv-test/bin/python -m pip install -r services/medgemma/requirements-test.txt
.venv-test/bin/python -m pytest services/medgemma -q
```

The mock tests do not import/download Transformers weights or call external model services. See AGENTS.md for isolated smoke-test commands. See [evaluation instructions](../evals/README.md#three-way-image-analysis-comparison) for the explicit live comparison runner and independent annotation requirements.

Checks completed before testing was paused: 28 Node mock/unit/API/evaluation tests and 24 Python service/runtime tests passed; Next.js production build, TypeScript checking, and the existing synthetic smoke workflow passed. Browser verification confirmed that specialty, anatomical location and physician context persist after reload. Python tests emitted a Starlette TestClient/httpx deprecation warning. The Python tests use fake generators/processes; their success does not demonstrate real inference. Subsequent small error-reporting changes have not received a complete rerun.

Official gated model access, download and source checksum verification succeeded. The pinned local conversion and native CPU service startup succeeded, including authenticated health and unauthenticated-request rejection. Both original synthetic TypeScript requests failed (image-only after approximately 207 seconds; image plus fictional transcript after approximately 182 seconds). Their old reports did not retain a stage. A preserved controlled native response from the same setup completed generation (`finish_reason=stop`) but returned the JSON Schema itself, which was rejected at schema validation. Inspection found that the llama.cpp request placed the schema outside the endpoint's required `response_format.json_schema.schema` wrapper. After correcting that wrapper, four real SCIN requests across two images and both context variants passed the complete integration contract as recorded above. This verifies the integration path for those requests and does not establish clinical correctness.

The Unraid Docker/CUDA path and private Tailscale transport have been exercised
for the single SCIN request recorded above. Broader CUDA performance, reboot
recovery, other hosted environments, live OpenAI calls, phone capture, and
clinical comparisons remain unverified. No clinical performance or cost
results have been invented. Private model files, credentials and live
verification artifacts are excluded from source control.
