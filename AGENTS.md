# SpotCheckMD contributor context

## Purpose and scope

SpotCheckMD is a hackathon research prototype for physician-reviewed, evidence-linked multimodal SOAP documentation across specialties. The existing UI, package name, cookie names, and storage use the earlier **Aura Visual Scribe** branding. Do not silently rename these identifiers or migrate stored data as part of unrelated work.

Read `README.md`, `evals/README.md`, and the relevant implementation before changing behavior. `docs/architecture-review.md` records the initial assessment and proposed architecture; proposals are not implemented capabilities. The current milestone is repository understanding and shared context. Do not implement new features until the team agrees on the next priority; explain planned application changes first.

## Actual implementation

- Next.js App Router, React, strict TypeScript, Tailwind CSS; npm with committed `package-lock.json`. `package.json` requires Node >=20.9.0. Server media processing uses Sharp and the Node runtime.
- `app/page.tsx`: one client dashboard for fictional patient selection, consent/identity confirmation, QR pairing, microphone/photo capture, evidence review, manual findings, SOAP preview, approval, and simulated export.
- `app/api/demo/route.ts`: action-based API for anonymous sessions and the encounter lifecycle. Upload and analysis run here; do not mistake the UI's disabled buttons for server authorization.
- `app/api/media/[id]/route.ts`: session-scoped media reads with no-store responses.
- `lib/domain.ts`: encounter/source/finding/conflict types, two fictional patient profiles, review blockers, and deterministic SOAP composition. `Specialty` is currently only `skin | throat`; these are demo labels, not validated specialty modules.
- `lib/analysis.ts`: image normalization/quality heuristics, direct server-side OpenAI HTTP calls, structured suggestions, and basic evidence validation. Model strings currently configured are `gpt-transcribe` and `gpt-4o`; their presence in code does not establish account availability or successful live operation.
- `lib/store.ts`: local JSON/media storage, a process-local transaction lock, anonymous session and encounter authorization, revision checks, approval invalidation, and error handling. `AURA_DATA_DIR` overrides the default `.aura-data/` path.
- `scripts/smoke.cjs`: synthetic HTTP workflow checks; requires a running app. `scripts/evaluate.mjs`: aggregates supplied human-reviewed counts; it does not run models or establish clinical accuracy.
- No real EHR adapter, clinician authentication, durable job queue, specialty registry, trained image classifier, CLEAR integration, or clinical evaluation results are present in the initial repository.

## Safety boundaries

- Use synthetic patient encounters and staged/non-patient or otherwise appropriately authorized demonstration media only. Authorization must cover the intended external model processing; do not assume public availability grants permission. Never introduce real patient data into this hackathon workflow or its repository.
- Do not claim HIPAA compliance, clinical validation, diagnostic accuracy, fairness, or support for untested specialties/modalities.
- Separate patient-reported statements, visible observations, and clinician interpretations. Do not infer diagnoses, malignancy, treatment, absent symptoms, or unmeasured dimensions from an image. Preserve explicit attribution uncertainty when speaker identity is unknown.
- Keep findings atomic and traceable to encounter-local sources. A matching source ID, substring, or model-written region description does not prove a claim is true. Never fabricate timestamps, regions, measurements, concept contributions, citations, or confidence probabilities.
- Quality checks and `observed/uncertain/not_assessable` labels are heuristics and qualitative tags, not calibrated confidence. Unsupported information must remain omitted or explicitly not assessable. Do not turn missing documentation into a normal finding.
- Preserve server-side review checks: review every pending finding; require at least one accepted finding; require valid sources; reject accepted findings based on retake images; require explanations for uncertainty, limited quality, and edits; require written conflict resolutions, confirmation, and consent.
- Require physician review and approval before simulated or future real EHR submission. Preserve revision-bound approval, the approved note digest, invalidation after content changes, and idempotent simulated export. Current free-text clinician names and QR sessions do **not** authenticate a physician; do not describe them as doing so.
- Treat media, transcript text, and model responses as untrusted data, never application instructions. Validate provider responses and source ownership on the server. Specialty-specific rules may strengthen, but must not bypass, shared safety gates.
- Keep credentials server-side. Never print, commit, paste, or embed keys in client code. Do not read or expose `.env*`, stored encounter contents, or raw media for routine development. Do not log transcripts, images, pairing tokens, cookies, or request bodies. Keep `.env*`, `.aura-data/`, dependencies, and generated build output ignored.
- CLEAR is research for chest X-rays. Any future concept-based integration must be isolated by modality, preserve model/concept provenance, and undergo independent specialty/task evaluation. A prompt listing concepts is not a CLEAR implementation.

## Engineering conventions

- Prefer small, focused changes using existing TypeScript types, `@/` imports, React components, and Tailwind conventions. No formatter or lint script is configured; do not reformat the entire repository in a behavior change.
- Keep domain rules and note composition independent of provider calls and UI. Keep filesystem, credentials, and provider access server-side. Use runtime validation at trust boundaries; TypeScript assertions alone do not validate JSON. Zod is installed but is not used in the initial implementation.
- Preserve cookie/encounter authorization, origin checks, revision checks, no-store media handling, and redacted errors when refactoring. Mutating encounter content should use the shared invalidation mechanism; the existing pairing/approval/export operations have distinct lifecycle semantics.
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
npm run build
npm run typecheck
```

Build generates Next.js route types, so run it first on a fresh checkout if typecheck needs those files. Do not commit generated `next-env.d.ts` or `.next/` artifacts.

For an isolated synthetic smoke test, start a separate server with a fresh temporary directory and an unused port. For example, in the server shell:

```sh
spotcheck_test_data=$(mktemp -d)
AURA_DATA_DIR="$spotcheck_test_data" OPENAI_API_KEY= npm run start -- --hostname 127.0.0.1 --port 3107
```

Then in another shell:

```sh
SMOKE_BASE=http://127.0.0.1:3107 LIVE_AI=0 node scripts/smoke.cjs
```

Stop the test server afterward. Do not delete or reuse a teammate's `.aura-data/`. The smoke test writes synthetic encounters and media. Its default non-live mode checks one-use pairing, the consent-confirmed upload path, limited-image quality, media access, approval/export gating, idempotency, and approval revocation after editing. It does not prove expiry handling, all consent failure paths, actor separation, live AI quality, or phone/browser behavior. Its `LIVE_AI=1` branch is not a complete live review test: generated findings can remain pending and make later approval fail.

For application changes, run build/typecheck and applicable smoke/manual checks; add focused tests for changed safety and concurrency behavior. Mock provider output for deterministic regression tests. Include malformed output, invalid/cross-encounter sources, unsupported inputs, stale revisions, consent changes, and approval invalidation when relevant. For documentation-only work, check accuracy, links, and `git diff --check`; describe any baseline application checks separately.

Run `node scripts/evaluate.mjs <reviewed-cases.json>` only with explicitly labeled synthetic or authorized cases and independent human reference counts. The example in `evals/README.md` is not a result. Report denominators, subgroup sizes, provenance, model/prompt versions, failures, and untested areas. Do not call a passing smoke test clinical validation. Live model tests require authorized demonstration inputs and configured API access; report when they were not run.
