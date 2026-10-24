# MedGemma 1.5 contextual image analysis

This is a synthetic/authorized-data hackathon feature, not clinically validated software. No model is trained. The official pretrained model is exactly `google/medgemma-1.5-4b-it`; there is no automatic model fallback.

## Architecture and scope

Audio → existing OpenAI `gpt-transcribe` → separately stored unverified transcript.

Each normalized image + specialty + declared image type + explicitly confirmed location + physician context + quality warnings + exact transcript windows → selected image provider → schema/evidence validation → pending visual findings and conflicts.

Separately, transcript windows → existing GPT-4o documentation function → pending spoken findings. The deterministic SOAP composer includes accepted findings only in an approved snapshot. Image observations enter O; image-generated history is displayed as contextual information rather than silently treated as a verified visual fact or duplicated in SOAP. A/P from the transcript requires uncertainty/attribution review. A transcript quote that matches text still does not prove the finding is true.

Provider implementations are in `lib/image-analysis/providers.ts`, orchestration in `pipeline.ts`, and runtime contracts in `contracts.ts`. The Python service shares the generated JSON Schema and prompt under `contracts/`. Run `npm run generate:contracts` after intentional schema/prompt changes; a test detects drift.

The initial input scope is existing normalized JPEG/PNG 2D images. The specialty selector includes general, primary care, urgent care, dermatology, radiology, and other; legacy skin/throat encounters still load. This is context selection, not a claim of validated specialty performance. There is no DICOM, 3D CT/MRI, whole-slide, video, or PDF ingestion. A radiograph selection means an authorized 2D rendering, not interpretation of a full study. Unsupported/insufficient views must return limitations or not-assessable observations.

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

Configure the Python service environment through your shell or secret manager (not source files):

| Variable | Purpose/default |
| --- | --- |
| `HF_TOKEN` | Hugging Face access token for the gated official model; Python only |
| `HF_HOME` | Optional persistent private model-cache directory |
| `MEDGEMMA_API_KEY` | Required shared service credential, at least 16 characters; use a random secret |
| `MEDGEMMA_MODEL_REVISION` | Official model repository revision; defaults to `main`; pin a verified commit for reproducibility |
| `MEDGEMMA_DEVICE` | `cuda` by default; explicit `cpu` uses FP32, with no automatic device fallback |

```sh
.venv/bin/uvicorn services.medgemma.service:app --host 127.0.0.1 --port 8000 --workers 1 --no-access-log
```

Model loading occurs at startup; missing access, unavailable CUDA, or invalid configuration prevents startup. `/health` requires the shared bearer credential and becomes available after loading. Do not print or paste tokens while diagnosing connectivity.

Configure the Next.js server in ignored `.env.local` or deployment secrets:

| Variable | Purpose/default |
| --- | --- |
| `IMAGE_ANALYSIS_PROVIDER` | Set `medgemma` to opt in. Default `openai` preserves GPT-4o availability for existing setups. Unknown values are errors. |
| `MEDGEMMA_URL` | Full service base URL, e.g. `http://127.0.0.1:8000`; HTTPS required off loopback |
| `MEDGEMMA_API_KEY` | Same shared service credential; never use a `NEXT_PUBLIC_` variable |
| `MEDGEMMA_TIMEOUT_MS` | Default 120000; allowed 1000–600000 milliseconds per image/context request |
| `OPENAI_API_KEY` | Existing audio transcription and transcript documentation; also required for the GPT-4o image baseline |
| `AURA_DATA_DIR` | Existing storage override; keep demo media and transcripts outside source control |

The Python service does not read Next.js `.env.local` automatically. Set the shared key in both processes. Keep `HF_TOKEN` on the inference host. MedGemma image-only operation does not require an OpenAI key. Audio and transcript documentation still do; those failures are reported independently.

```sh
npm run dev
```

In the app, choose a fictional encounter, confirm consent, save specialty/image type and any confirmed context, and capture authorized media. Analyze, inspect image thumbnails, transcript excerpts, attribution, limitations, and conflicts; accept/reject/edit each finding. Acknowledge partial-analysis warnings before approving. Export remains a local simulation. A model failure never switches to GPT-4o; choose the baseline explicitly through configuration and restart Next.js.

## Hosted service

The included Dockerfile packages this same API wrapper, not a generic Hugging Face/Vertex prediction endpoint. Build from the repository root:

```sh
docker build -f services/medgemma/Dockerfile -t spotcheckmd-medgemma .
docker run --rm --gpus all -p 127.0.0.1:8000:8000 \
  -e HF_TOKEN -e MEDGEMMA_API_KEY -e MEDGEMMA_MODEL_REVISION \
  spotcheckmd-medgemma
```

Use a GPU-capable Docker host with the NVIDIA container runtime. Supply secrets at runtime, and use a writable persistent private cache when appropriate; do not bake credentials or model weights into a public image. For a remote GPU VM/container, put the wrapper behind TLS and network access controls; preserve bearer authorization, disable request-body/access logging, set proxy body limits to at most 15 MB, and allow the configured inference timeout. Configure the Next.js server's `MEDGEMMA_URL` to that HTTPS base URL. The wrapper bounds request size, returns redacted validation errors, rejects concurrent inference with 429, and does not persist inputs. It does not establish a complete privacy or retention policy for hosting infrastructure.

A raw Vertex AI/Model Garden endpoint has a different request/authentication contract and is **not** a drop-in URL for this adapter. Deploy this wrapper or implement and test a separate endpoint adapter. Docker/GPU/hosted deployment has not been executed in the development checks below.

Use a long-running Node server for the app. One encounter can make several sequential calls; short serverless request limits may terminate it. The service caps generated tokens and requests a generation time limit; GPU work may finish after a client disconnect. There is no durable job queue or instant remote cancellation. Encounter run ownership, revision checks before each external call, and commit checks prevent stale output from replacing newer edits. Expired runs can be retried after 30 minutes; an old worker cannot complete a newer run.

## Compatibility and review semantics

Existing records remain readable: new context, provenance, warning and run fields are optional. No destructive migration is run. Old `skin`/`throat` labels remain accepted. Previously stored transcripts are reused. Retry replaces pending AI proposals while retaining clinician additions and previous accepted/rejected findings; review potential duplicate or contradictory observations across runs. Upload retains the prior application's behavior of clearing findings/conflicts and invalidating approval.

Changing context or another encounter field revokes approval and cancels an active run. Uncertainty, limited-quality evidence, edits, unresolved conflicts, and retake evidence retain their approval gates. Warning acknowledgement is an additional gate for partial failures. Review edits reopen linked conflicts. The note preview and clipboard include uncertainty/limitations/reviewer notes; copied pending lines are marked pending.

The existing anonymous/QR authorization model is unchanged. A typed clinician name is not authenticated physician identity, and paired sessions can still review/approve. Do not present this as production actor authorization. The local JSON store remains single-process.

## Verification

```sh
npm test
npm run build
npm run typecheck
python3 -m venv .venv-test
.venv-test/bin/python -m pip install -r services/medgemma/requirements-test.txt
.venv-test/bin/python -m pytest services/medgemma/test_service.py -q
```

The mock tests do not import/download Transformers weights or call external model services. See AGENTS.md for isolated smoke-test commands. See [evaluation instructions](../evals/README.md#three-way-image-analysis-comparison) for the explicit live comparison runner and independent annotation requirements.

Checks performed during development: 28 Node mock/unit/API/evaluation tests passed; 14 Python service tests using an injected fake generator passed; Next.js production build, TypeScript checking, and the existing synthetic smoke workflow passed. Browser verification confirmed that specialty, anatomical location and physician context persist after reload. Python tests emitted a Starlette TestClient/httpx deprecation warning; no test failed. Final counts/results are also recorded in the PR. Tests use synthetic inputs and temporary storage. Actual MedGemma generation, gated model access, CUDA memory/latency, Docker deployment, hosted inference, phone capture, and clinical comparisons require separate validation. No clinical performance or cost results have been invented.
