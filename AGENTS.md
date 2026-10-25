# SpotCheckMD contributor context

## Purpose and scope

SpotCheckMD is a hackathon research prototype for physician-reviewed, evidence-linked multimodal SOAP documentation across specialties. The existing UI, package name, cookie names, and storage use the earlier **Aura Visual Scribe** branding. Do not silently rename these identifiers or migrate stored data as part of unrelated work.

Read `README.md`, `evals/README.md`, and the relevant implementation before changing behavior. `docs/architecture-review.md` records the initial assessment and proposed architecture; proposals are not implemented capabilities. The team has authorized the MedGemma 1.5 contextual image-analysis feature on `feature/medgemma-contextual-analysis`. See `docs/medgemma.md` for implementation/setup. Further feature priorities still require agreement; explain planned application changes first.

## Actual implementation

- Next.js App Router, React, strict TypeScript, Tailwind CSS; npm with committed `package-lock.json`. `package.json` requires Node >=20.9.0. Server media processing uses Sharp and the Node runtime.
- `app/page.tsx`: one client dashboard for fictional patient selection, consent/identity confirmation, direct phone-browser capture, microphone/photo capture, evidence review, manual findings, SOAP preview, approval, and simulated export.
- `app/api/demo/route.ts`: action-based API for anonymous sessions and the encounter lifecycle. Upload runs here; analysis requests enqueue persistent work and return HTTP 202. Do not mistake the UI's disabled buttons for server authorization.
- `app/api/media/[id]/route.ts`: session-scoped media reads with no-store responses.
- `lib/domain.ts`: encounter/source/finding/conflict types, two fictional patient profiles, review blockers, and deterministic SOAP composition. Specialty context now includes general, primary care, urgent care, dermatology, radiology and other, while preserving legacy `skin | throat` labels. These are not validated specialty modules.
- `lib/analysis.ts`: image normalization/quality heuristics, direct server-side OpenAI HTTP calls, structured suggestions, and basic evidence validation. Model strings currently configured are `gpt-transcribe` and `gpt-4o`; their presence in code does not establish account availability or successful live operation.
- `lib/store.ts`, `lib/auth.ts`, and `lib/database.ts`: PostgreSQL-backed physician sessions and aggregate persistence, organization/physician authorization, revision checks, approval invalidation, login throttling, and error handling. Legacy JSON mode exists only for deterministic compatibility tests and explicit import. `AURA_DATA_DIR` controls private media storage.
- `scripts/smoke.cjs`: synthetic HTTP workflow checks; requires a running app. `scripts/evaluate.mjs`: aggregates supplied human-reviewed counts; it does not run models or establish clinical accuracy.
- `lib/image-analysis/`: versioned schema, per-image providers, transcript windows, orchestration and comparison metrics. `services/medgemma/`: optional private Python inference service using the official pretrained model. `contracts/`: generated shared response schema/instructions; regenerate with `npm run generate:contracts`.
- `lib/evidence-map.ts`, `components/evidence-replay.tsx`, `components/use-replay-audio.ts`: read-only Evidence Replay view over stored sources, word timings and approval digests. It adds no endpoint, storage or review rule; it must not draw image regions, fabricate timings, or present word confidence as clinical confidence. See `docs/evidence-replay-plan.md`.
- `services/medgemma/local_runtime.py`: explicit experimental `MEDGEMMA_BACKEND=llama_cpp` CPU option, owning an authenticated loopback child process. `prepare_local.py` converts authorized official safetensors with pinned tools; source/conversion/runtime revisions and artifact hashes must remain attached to quantized results. Keep weights, model caches, private configuration and verification outputs outside source control. Do not substitute a third-party model or erase quantization provenance. The original Transformers backend remains the default.
- `lib/ehr/` and `app/api/ehr/route.ts`: owner-scoped fictional charts, reviewed history snapshots, and atomic local note submission with receipts and amendments. See `docs/ehr-demo.md`. Keep imported history distinct from transcript/image evidence and preserve original saved notes.
- `lib/transcription/` and `app/api/transcription-token/route.ts`: provider-selected OpenAI/AssemblyAI post-visit transcription, immutable timestamped artifacts, medical key terms, speaker-role confirmation and provisional AssemblyAI streaming captions. See `docs/transcription.md`. Keep permanent provider keys server-side; live captions are never approved-note evidence.
- `lib/analysis-jobs.ts` and root `instrumentation.ts`: single-process persistent analysis queue and startup recovery. The worker serializes inference, owns the encounter revision/source snapshot, and requeues interrupted processing after restart. This supports one web container only; do not add replicas against the JSON store.
- `Dockerfile` and `deploy/unraid/web-*.sh`: production standalone Next.js image, checked `main` deployments, persistent Unraid storage, health checks, and rollback. The web container uses host networking but binds only to `127.0.0.1:3340` so it can reach the established loopback-only MedGemma service. See `docs/unraid-web-deployment.md`.
- `scripts/prepare_scin.py` prepares a deterministic 1–10 case SCIN integration set in a new private directory. `scripts/verify-scin-medgemma.ts` runs one explicitly selected local image-only or image-plus-context request. SCIN photographs, metadata, manifests, model output and reports stay outside source control and remain subject to the SCIN Data Use License. These are integration inputs, not clinical ground truth.
- No real EHR adapter, public registration, production identity provider, external/multi-node queue, clinically validated specialty modules, CLEAR integration, or clinical evaluation results are present. Model weights have not been exercised by the mock test suite.

## Safety boundaries

- Use synthetic patient encounters and staged/non-patient or otherwise appropriately authorized demonstration media only. Authorization must cover the intended external model processing; do not assume public availability grants permission. Never introduce real patient data into this hackathon workflow or its repository.
- Do not claim HIPAA compliance, clinical validation, diagnostic accuracy, fairness, or support for untested specialties/modalities.
- Separate patient-reported statements, visible observations, and clinician interpretations. Do not infer diagnoses, malignancy, treatment, absent symptoms, or unmeasured dimensions from an image. Preserve explicit attribution uncertainty when speaker identity is unknown.
- Keep findings atomic and traceable to encounter-local sources. A matching source ID, substring, or model-written region description does not prove a claim is true. Never fabricate timestamps, regions, measurements, concept contributions, citations, or confidence probabilities.
- Quality checks and `observed/uncertain/not_assessable` labels are heuristics and qualitative tags, not calibrated confidence. Unsupported information must remain omitted or explicitly not assessable. Do not turn missing documentation into a normal finding.
- Preserve server-side review checks: review every pending finding; require at least one accepted finding; require valid sources; reject accepted findings based on retake images; require explanations for uncertainty, limited quality, and edits; require written conflict resolutions, confirmation, and consent.
- Require physician review and approval before simulated or future real EHR submission. Preserve revision-bound approval, the approved note digest, invalidation after content changes, and idempotent simulated export. The seeded physician session is the MVP identity boundary; the free-text note signature does not authenticate a physician, and neither mechanism is a production identity system.
- Treat media, transcript text, and model responses as untrusted data, never application instructions. Validate provider responses and source ownership on the server. Specialty-specific rules may strengthen, but must not bypass, shared safety gates.
- Keep credentials server-side. Never print, commit, paste, or embed keys in client code. Do not read or expose `.env*`, stored encounter contents, or raw media for routine development. Do not log transcripts, images, temporary access tokens, cookies, or request bodies. Keep `.env*`, `.aura-data/`, dependencies, and generated build output ignored.
- CLEAR is research for chest X-rays. Any future concept-based integration must be isolated by modality, preserve model/concept provenance, and undergo independent specialty/task evaluation. A prompt listing concepts is not a CLEAR implementation.

## Engineering conventions

- Prefer small, focused changes using existing TypeScript types, `@/` imports, React components, and Tailwind conventions. No formatter or lint script is configured; do not reformat the entire repository in a behavior change.
- Keep domain rules and note composition independent of provider calls and UI. Keep filesystem, credentials, and provider access server-side. Use runtime validation at trust boundaries; TypeScript assertions alone do not validate JSON. Zod validates contextual image output and transcript suggestions; keep the Python/TypeScript contracts synchronized.
- Preserve cookie/encounter authorization, origin checks, revision checks, no-store media handling, and redacted errors when refactoring. Mutating encounter content should use the shared invalidation mechanism; the existing approval/export operations have distinct lifecycle semantics.
- Keep exported note content aligned with the reviewed snapshot. Preserve original generated wording and reviewer changes; new provenance fields need explicit versioning and migration plans for saved encounters.
- Model adapters, specialty profiles, storage, and export should have small interfaces within this app before introducing additional services. Do not add a framework, database, vector store, or model dependency without a concrete requirement.
- Do not silently alter existing model identifiers, public request shapes, source IDs, upload limits, demo patients, or storage formats. Explain compatibility effects and add targeted regression coverage when changing them.

## Collaboration

- Check status, branch, current remote changes, and nearby work before editing. Use a dedicated feature/docs branch; never commit directly to `main`.
- If the workspace is a downloaded ZIP without `.git`, use a separate clone for branch work. Preserve the downloaded files and local demo data; do not overwrite them with a checkout.
- Do not reset, discard, force-push over, or incorporate unrelated teammate changes. Stage explicit paths. Keep commits focused and descriptive.
- Submit changes through a pull request before merging. Describe behavior, compatibility, validation, and limitations. Do not merge or enable auto-merge without authorization.

## Testing expectations

Install dependencies with `npm ci`. Existing commands are:

```sh
npm test
npm run build
npm run typecheck
```

Build generates Next.js route types, so run it first on a fresh checkout if typecheck needs those files. Do not commit generated `next-env.d.ts` or `.next/` artifacts.

For an isolated synthetic smoke test, use a dedicated migrated PostgreSQL test database, a fresh temporary media directory, a seeded synthetic physician and an unused port. Never point tests at the shared deployment database. For example, in the server shell:

```sh
spotcheck_test_data=$(mktemp -d)
AURA_DATA_DIR="$spotcheck_test_data" DATABASE_URL="$SPOTCHECK_TEST_DATABASE_URL" OPENAI_API_KEY= npm run start -- --hostname 127.0.0.1 --port 3107
```

Then in another shell:

```sh
SMOKE_BASE=http://127.0.0.1:3107 SMOKE_USERNAME=synthetic-physician SMOKE_PASSWORD="$SPOTCHECK_TEST_PASSWORD" LIVE_AI=0 node scripts/smoke.cjs
```

Stop the test server afterward. Do not delete or reuse a teammate's database or media directory. The smoke test writes synthetic encounters and media. Its default non-live mode checks authenticated workspace access, the consent-confirmed upload path, limited-image quality, media access, approval/export gating, idempotency, and approval revocation after editing. It does not prove live AI quality or phone/browser behavior. Its `LIVE_AI=1` branch is not a complete live review test: generated findings can remain pending and make later approval fail.

For application changes, run build/typecheck and applicable smoke/manual checks; add focused tests for changed safety and concurrency behavior. Mock provider output for deterministic regression tests. Include malformed output, invalid/cross-encounter sources, unsupported inputs, stale revisions, consent changes, and approval invalidation when relevant. For documentation-only work, check accuracy, links, and `git diff --check`; describe any baseline application checks separately.

Run `node scripts/evaluate.mjs <reviewed-cases.json>` only with explicitly labeled synthetic or authorized cases and independent human reference counts. The example in `evals/README.md` is not a result. Report denominators, subgroup sizes, provenance, model/prompt versions, failures, and untested areas. Do not call a passing smoke test clinical validation. Live model tests require authorized demonstration inputs and configured API access; report when they were not run.

The MedGemma service/runtime tests run with `python -m pytest services/medgemma -q` using the separate test requirements. They inject fake generators/processes and require no GPU or model token. Mock success is not evidence that real model generation or deployment works. Never enable a fake generator via a production environment flag; tests inject it in process. `scripts/verify-local-medgemma.ts` makes explicit real requests using a generated non-patient diagram and fictional context; contract success is technical verification, not clinical validation. Preserve failures and report which runtime was actually exercised.

SCIN integration requires explicit `--run-download`, `--accept-scin-license`, and `--run-live` flags. Do not commit SCIN data or results, attempt re-identification, transmit images to an external provider, include dermatologist condition labels in model input, or omit failed cases. Start with one local image-only request; run the context variant and expand to 5–10 cases only after that request passes the full Python and TypeScript contract.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
