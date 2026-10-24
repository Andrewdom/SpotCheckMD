# SpotCheckMD — teammate / LLM handoff

Snapshot: October 23, 2026 (America/New_York). Implementation reference: commit `b80c974dbfa306450ab8c6a4ca2f9c2878575a3a`. This file is a portable context document: attach it to a teammate's LLM conversation, ideally with repository access. It contains no credentials or patient data.

## Instructions to the receiving LLM

You are helping a hackathon team develop SpotCheckMD. Read this handoff, then inspect the actual checkout and its `AGENTS.md` before editing. Treat the implementation and latest explicit teammate instructions as authoritative; this document is a dated snapshot. Distinguish implemented code, mock-tested behavior, successful live execution, and proposed work. Do not represent one as another.

Start by identifying the current branch, working-tree changes, and assigned task. Preserve others' work. Explain intended application changes before making them. Use a dedicated branch and a pull request; never write directly to `main`, force-push over teammates, or merge without authorization. This handoff alone does not authorize additional features, paid deployments, model runs, or a merge.

The owner most recently requested that testing stop so the team could see the changes. The implementation was published with known unresolved live-inference failures. Do not automatically restart expensive downloads, conversions, or live model tests merely because this document contains commands. Confirm the teammate's current task and follow their explicit instructions.

## Product goal and boundaries

SpotCheckMD is a multimodal documentation assistant that combines physician–patient conversations and supported clinical images into structured, evidence-linked SOAP notes for physician review. It should accommodate primary care, urgent care, dermatology, and future specialty workflows without hard-coding the architecture around one specialty.

This is a hackathon research prototype. Existing UI/package/storage names still use **Aura Visual Scribe**; do not silently rename identifiers or migrate data. Specialty choices are context controls, not validated specialty algorithms. No HIPAA compliance, clinical validation, diagnostic accuracy, or fairness has been established.

Non-negotiable boundaries:

- Use synthetic encounters and staged/non-patient or appropriately authorized demonstration images only. Authorization must cover intended model processing. No real patient data in this prototype or repository.
- Keep visible observations, patient reports, and clinician interpretations distinct. Do not invent diagnoses, malignancy probabilities, treatment, absent symptoms, measurements, timestamps, or image regions.
- Require source attribution, explicit uncertainty when needed, physician review, and revision-bound approval before simulated or future real EHR submission.
- Preserve consent, encounter access, evidence validation, review blockers, approval invalidation, and idempotent simulated export.
- Never print or commit credentials, `.env.local`, tokens, encounter data, model weights, private outputs, or raw request bodies.
- Source-ID and quote matching validate structure, not medical truth. Qualitative certainty tags are not calibrated probabilities.

## Repository and collaboration state

| Item | Snapshot |
| --- | --- |
| Repository | https://github.com/Andrewdom/SpotCheckMD |
| Feature branch | `feature/medgemma-contextual-analysis` |
| Feature review | Draft PR #3: https://github.com/Andrewdom/SpotCheckMD/pull/3 |
| PR base | `docs/project-context-architecture` — stacked on documentation PR #1 |
| Documentation review | https://github.com/Andrewdom/SpotCheckMD/pull/1 |
| Latest implementation commit | `b80c974` — experimental local MedGemma CPU runtime |
| Main status at publication | No changes from this work were merged into `main` |
| Known overlapping work | `feat/region-observations`; coordinate changes to `lib/analysis.ts`, `lib/domain.ts`, `app/api/demo/route.ts`, and `app/page.tsx` |

Inspect current remote state before acting; branches and PR status can change. Retargeting the stacked PR after the docs base merges is a coordination task, not an instruction to merge now.

The original owner's `Downloads/SpotCheckMD-main` folder was a ZIP without Git metadata. Work occurred in a separate `Downloads/SpotCheckMD-medgemma` clone, preserving the ZIP and its local data. Teammates should use their own clone/worktree; these directory names are historical context, not required paths.

## What we worked on

1. Inspected the original tracked repository, README, evaluation protocol, and architecture. Added `AGENTS.md` and `docs/architecture-review.md` with engineering conventions, safety boundaries, limitations, and a modular expansion proposal.
2. After the owner authorized implementation, added contextual MedGemma image analysis, shared runtime-validated output contracts, specialty/image/context controls, provenance, transcript-context attribution, partial-failure handling, review safeguards, and evaluation tooling.
3. Attempted local execution on the owner's Intel Mac. Hugging Face login initially worked while model access returned 403. The owner accepted the official model conditions; authorized download subsequently succeeded.
4. Added an explicitly selected experimental native CPU backend because the default service's modern PyTorch requirements could not be installed on that Intel macOS machine. Converted official weights locally with pinned tools and recorded provenance.
5. Verified conversion/startup and attempted two real synthetic requests. Both failed. Stopped further investigation at the owner's request and published the current work to draft PR #3.

`docs/architecture-review.md` describes the **original baseline and proposals**. Its statements such as “no unit-test suite” are historical; several identified issues have since been addressed on the feature branch. Do not use that review as an inventory of today's implementation.

## Current architecture and behavior

Stack: Next.js App Router, React, TypeScript, Tailwind CSS, Sharp, Zod, npm; Node >=20.9.0. The optional MedGemma server is a separate Python service.

```text
Fictional encounter + confirmation/consent
  -> normalized images / recorded audio / saved encounter context
  -> audio transcription (existing OpenAI path, when configured)
  -> each image + quality warnings + source IDs + transcript windows
       -> explicitly selected image provider (GPT-4o or MedGemma)
       -> shared schema / source / evidence checks
       -> pending visual observations, contextual history, limitations/conflicts
  -> separate transcript documentation path -> pending spoken findings
  -> physician accept/edit/reject + conflict/warning review
  -> deterministic SOAP composition -> revision-bound approval
  -> idempotent simulated export
```

- GPT-4o remains the default image provider; `IMAGE_ANALYSIS_PROVIDER=medgemma` opts into MedGemma. Provider errors do not trigger an automatic model fallback.
- The official model identifier is `google/medgemma-1.5-4b-it`. No model training or fine-tuning was performed. Transformers remains its default backend; native CPU quantization is explicit.
- Existing audio transcription uses the code's `gpt-transcribe` identifier; GPT-4o handles separate transcript documentation. These identifiers do not prove live account/model availability. MedGemma image-only analysis does not require an OpenAI key; audio/transcript paths do.
- Each image is processed separately. Image findings cite the exact image; transcript citations are context, not visual proof. Visual observations enter Objective; generated contextual history is not silently duplicated into SOAP as a verified image finding.
- Long transcripts use overlapping, complete-utterance windows (up to 6,000 characters each; total retained limit 100,000). Oversized indivisible utterances produce a warning rather than silent truncation. Windowing increases calls/latency and can lose distant relationships.
- Context includes general, primary care, urgent care, dermatology, radiology, and other; legacy `skin`/`throat` values remain compatible. JPEG/PNG 2D input remains the supported scope. A 2D radiograph selection does not provide full-study or DICOM support.
- Run ownership and encounter revision checks prevent stale results from replacing edits or revoked consent. Reanalysis retains reviewed/clinician findings and replaces pending AI proposals; duplicates still require review. Upload retains the existing behavior of clearing findings/conflicts.
- Changed encounter content revokes approval. Partial-analysis warnings require acknowledgement; pending findings, unresolved conflicts, inadequate evidence, and retake-image findings retain review gates.
- UI/clipboard include uncertainty, limitations, reviewer notes, and pending markers. Export remains local simulation only.

## Code map

| Path | Responsibility |
| --- | --- |
| `AGENTS.md` | Contributor conventions, actual implementation, safety and checks |
| `app/page.tsx`, `components/clinical-context.tsx` | Encounter/review UI and specialty/context/provenance controls |
| `app/api/demo/route.ts` | Encounter actions, upload/analysis orchestration, lifecycle gates |
| `app/api/media/[id]/route.ts` | Session-scoped media access |
| `lib/domain.ts` | Domain types, blockers, deterministic SOAP composition |
| `lib/store.ts` | Local storage, access checks, transactions/revisions |
| `lib/analysis.ts` | Image preparation and existing OpenAI/transcript operations |
| `lib/image-analysis/contracts.ts` | Runtime contracts and evidence/provenance types |
| `lib/image-analysis/providers.ts` | GPT-4o and MedGemma transport adapters |
| `lib/image-analysis/pipeline.ts`, `prompt.ts` | Context windows, per-image orchestration, common instructions |
| `contracts/` | Generated schema/instructions shared with Python |
| `services/medgemma/service.py` | Authenticated Python API and default Transformers generation |
| `services/medgemma/local_runtime.py` | Owned authenticated native CPU process, integrity/provenance checks |
| `services/medgemma/prepare_local.py` | Pinned official-weight download/checksum/conversion preparation |
| `scripts/verify-local-medgemma.ts` | Two-case real synthetic adapter verification; opt-in execution |
| `scripts/compare-image-analysis.ts`, `summarize-comparison.ts` | Three-arm comparison collection and independently reviewed metrics |
| `tests/`, `services/medgemma/test_*.py` | Mock/unit/API/evaluation/runtime regression coverage |
| `docs/medgemma.md`, `evals/README.md` | Setup, limitations, and evaluation procedures |

## Experimental local CPU path

The owner's machine was an Intel i9 Mac with 16 GiB RAM and a 4 GiB AMD Radeon Pro 5500M, without CUDA. Compatible macOS x86_64 wheels were unavailable for the default service's `torch>=2.6` requirement; selecting CPU alone did not resolve installation. The alternative uses llama.cpp with Q4_K_M text weights and an F16 vision projector. It is experimental and can change output quality.

Pinned preparation references:

- Official model revision: `91850547d9f0b2fdd21aa7c5f4f3d1a8a52c243b`.
- Converter revision: `4762ad7316dcdec20016ab5985fb46a27902204d` (llama.cpp b6000).
- Native runtime revision: `edc353842c1be9b4ebc27460a1da4526a026d3a9`.

Preparation verifies official source hashes, converts locally, and writes a manifest and private provenance artifacts. Runtime verifies manifest/artifact hashes and binary revision, starts its own authenticated loopback process with one slot/four CPU threads, and forwards image+text under the shared JSON contract. Returned results can retain source/converter/runtime revisions, quantization, and artifact hashes. The UI labels this runtime experimental. No third-party quantized model was substituted.

Environment names, never values containing secrets:

| Setting | Role |
| --- | --- |
| `IMAGE_ANALYSIS_PROVIDER` | `medgemma` to opt in; default `openai` |
| `MEDGEMMA_URL` | Wrapper base URL; loopback locally, HTTPS off loopback |
| `MEDGEMMA_API_KEY` | Shared secret in Next.js and wrapper environments |
| `MEDGEMMA_BACKEND` | `llama_cpp` for experimental path; default `transformers` |
| `MEDGEMMA_GGUF_MANIFEST` | Local manifest absolute path |
| `MEDGEMMA_LLAMA_BINARY` | Pinned local executable absolute path |
| `MEDGEMMA_TIMEOUT_MS` | Next.js per-request timeout; local experiment used `600000` |
| `HF_TOKEN` / local HF login | Authorized model access on inference/preparation host |
| `OPENAI_API_KEY` | Existing OpenAI features |
| `AURA_DATA_DIR` | Isolated demo storage location |

Follow `docs/medgemma.md` for full setup rather than copying the owner's environment. Each teammate needs their own model access and local configuration. Do not distribute credentials or assume the owner's model access authorizes someone else's account. The serving and converter Python environments are separate; do not downgrade the default Transformers environment to match the old converter dependencies.

## What actually passed and what failed

These are historical results before the owner paused testing, not a fresh certification of every final line:

| Check | Result / limit |
| --- | --- |
| Node mock/unit/API/evaluation tests | 28 passed |
| Python service/runtime tests | 24 passed using fake generators/processes; Starlette/httpx deprecation warning |
| Next.js production build, TypeScript check | Passed |
| Existing synthetic HTTP smoke | Passed; no live AI |
| Browser check | Specialty/location/context persisted after reload |
| Official gated access/download/source checksums | Succeeded after owner accepted conditions |
| Pinned conversion/native startup | Succeeded |
| Wrapper auth health checks | Authorized 200, unauthorized 401 |
| Real image-only request via TS adapter | Failed after approximately 207 seconds |
| Real image + fictional transcript request | Failed after approximately 182 seconds |

**No successful structured live MedGemma analysis has been demonstrated.** Both requests used a generated non-patient geometric diagram; they were technical checks, not clinical cases. The root cause is unresolved. Do not assert that a specific layer, model quality, JSON grammar, timeout, or evidence validator caused the failures without reproducing and isolating it. Subsequent small error-reporting changes have not received a complete test rerun.

The model service/native child was stopped when testing paused. Do not assume any historical local server is still running. Credentials, model caches, converted weights, logs, and verification outputs were not pushed.

Still unverified: real CUDA/Transformers inference, GPU memory/latency, Docker/hosted deployment, live OpenAI paths, phone capture, clinical-quality comparisons, and cost metrics. Mock success, conversion success, and HTTP health do not establish inference success or clinical suitability.

## Known limits and architectural direction

Anonymous cookies and QR capabilities are not physician authentication. A typed clinician name does not prove identity; paired sessions can review/approve. Storage is local JSON/media with a process-local lock, unsuitable for multiple replicas. There is no real EHR connector, durable job queue, instant remote cancellation, validated conflict detector, full immutable evidence history, or validated specialty framework.

No DICOM, 3D CT/MRI, whole-slide, PDF, video, lab, or vital-sign ingestion was added. CLEAR was discussed as a possible research direction; it has **not** been implemented. Its chest-X-ray approach cannot simply be claimed to generalize to other specialties, and a prompt listing concepts is not CLEAR.

Preserve a modular pipeline: ingestion → transcription/observation adapters → specialty/modality policies → shared evidence validation → review → deterministic approved note → export adapter. Expand specialty policies and source types behind explicit contracts and independent evaluation. Do not rebuild the app around dermatology or introduce infrastructure without an agreed requirement.

If assigned to resume MedGemma debugging, first isolate generation versus output-validation failure using only authorized synthetic inputs and private, redacted diagnostics. Preserve failing cases and runtime provenance. Never make a failing path appear successful by loosening evidence/review rules, silently changing models, or injecting fake production output. A GPU/hosted alternative is a proposed option, not an already working deployment.

## Checks when the teammate authorizes resuming work

Do not run these solely on receipt of this handoff; testing is currently paused. For a later assigned code change, use the applicable checks in `AGENTS.md`:

```sh
npm ci
npm test
npm run build
npm run typecheck
# In the configured test environment, with requirements-test.txt installed:
python -m pytest services/medgemma -q
```

Regenerate shared contracts with `npm run generate:contracts` after intentional schema/prompt changes. Smoke tests need a running app, fresh isolated `AURA_DATA_DIR`, and `LIVE_AI=0`; see `AGENTS.md`. Live scripts explicitly opt in to model calls and may incur costs. Do not overwrite existing result directories. Clinical evaluation requires independent human annotations and failure/denominator reporting; no evaluation results have been established.

## Suggested message to accompany this file

> Read the attached SpotCheckMD handoff as project context, then inspect the feature branch and AGENTS.md. Our current assigned task is: [insert teammate task]. Before changing code, summarize the relevant current behavior and proposed change. Preserve safety/review gates, other teammates' work, and the distinction between implemented, mock-tested, and live-verified features. Do not assume the experimental MedGemma CPU path works: both real synthetic requests failed. Use a dedicated branch and PR, and follow our current instructions about whether testing should resume.
