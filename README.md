# Aura Visual Scribe — hackathon research prototype

A Next.js demo for a fictional patient-linked capture → review → approval workflow. **Use fictional dialogue and non-patient images only.** This is not an authenticated EHR, clinical software, or a HIPAA-compliant deployment.

## Run

Use Node.js 20.9 or newer:

```bash
npm ci
npm run dev
```

Open http://localhost:3000. An existing ignored `.env.local` can contain `OPENAI_API_KEY` for analysis; never commit, upload, or paste the key. Capture and review UI work without live AI, but **Describe selections & review** requires OpenAI API access and a reachable API endpoint. The server uses `gpt-4o-transcribe` for audio and `gpt-4o` for image/transcript observations. Audio recording requires localhost or HTTPS and browser permission. Mobile `capture="environment"` behavior varies by browser.

## Demo journey

1. Choose one of two fictional patient profiles. Confirm the patient and all-party recording/processing consent.
2. Create a one-use, five-minute QR link and scan it on a phone on the **same reachable host**. For a phone, use an HTTPS tunnel or local network host; `localhost` on a laptop will refer to the phone itself. This prototype has **no clinician authentication**; anyone with the token can view its fictional encounter.
3. Capture staged images and/or short fictional audio. Photos are normalized with EXIF metadata stripped. Clipped detail, sharpness, and resolution heuristics warn when to retake; they cannot certify image quality. Average image brightness is not used to reject darker tissue.
4. Draw a box around one finding in each photo, or explicitly select the whole photo. Choose automatic body-region detection or a clinician-selected skin/mouth route. Optionally use **Suggest body region** first. Enter diameter in millimeters only if independently measured; leave it blank otherwise. Confirm flat/raised skin only from examination. Click **Save photo settings** for each photo.
5. Click **Describe selections & review**. Photos marked for retake are skipped. Review the transcript and each atomic suggestion with evidence links, uncertainty/quality flags, and an editable reviewer note. The system flags a basic left/right discrepancy, but humans must check for all other contradictions. Reject findings from photos marked `retake`; explain uncertain or edited findings.
6. Accept or reject every suggestion, resolve flagged conflicts, enter a demo clinician name, and approve. Any subsequent change revokes approval. The export button records a **simulation**, never sends anything to an EHR.

Drafts, transcripts, normalized images, and audio are stored in `.aura-data/` on the local server, ignored by git. Delete that directory to remove this demo's stored data. Do not treat this as a privacy/retention policy for real patient records. Server state is a local JSON file with a single-process write lock; it is not safe for multiple server replicas or production. Sessions are anonymous demo cookies; QR codes are temporary encounter capabilities, not identity verification.

## Region-specific visual algorithm (v2)

1. **Region routing:** a separate structured call identifies skin, mouth, other, or unclear from the full photo. An uncertain or unsupported automatic result stops classification. A clinician may override the region, with provenance and disagreement shown in the draft.
2. **Evidence selection:** the clinician selects one rectangular region per photo. Coordinates are validated on the server, then `sharp` extracts those pixels for the descriptive call. The rectangle is a crop, not an AI segmentation mask. There is no SAM integration or automated lesion boundary tracing. For multiple findings, upload a separate copy and select another area.
3. **Region-specific fields:** skin uses color, shape, border, apparent elevation, and visible surface. Mouth uses oral site, tentative visible feature, color, shape, and border. Enumerated fields are checked again with Zod after the API response. Unsupported output, extra fields, or malformed data fail the run. No diagnosis or physical size field is requested from the model.
4. **Measured versus apparent:** diameter comes only from a clinician entry. A narrow deterministic rule proposes a macule (<10 mm) or patch (>10 mm) candidate only when the clinician confirms flatness and the image describes a smooth, flat-appearing area. At exactly 10 mm the wording stays neutral. Raised skin is not automatically classified as papule/plaque/nodule because depth, consistency, and other clinical distinctions are unavailable. Definitions are based on [Stanford Medicine’s morphology guide](https://med.stanford.edu/stanfordmedicine25/the25/dermatology.html); this is not a clinically validated classifier.
5. **Review:** show the evidence crop and editable descriptive fields beside a deterministically assembled draft. Visual suggestions require a clinician verification note before approval. Server-side rules prevent fields from one region being saved into another. Changing crop, routing, or measurement removes that photo’s prior visual draft and revokes approval. Running analysis again replaces AI drafts, while preserving manual clinician entries. Failed runs preserve prior drafts and revoke approval.

The OpenAI model remains `gpt-4o`; audio uses `gpt-4o-transcribe`. Existing demo data remains readable. Photo dimensions for new uploads reflect the normalized, orientation-corrected file. This workflow has no disease classifier, calibrated probability, automatic physical measurement, or validated skin-tone parity.

### Existing controls

- **Preflight:** decode/rotate, strip metadata, resize, and flag low resolution, near-black/white clipping, and low edge detail. This heuristic can misclassify uniform images or miss blur/glare; retake advice is advisory.
- **Separate sources:** visual descriptors use only the selected crop after region routing. Transcript suggestions use a separate model request with verbatim quote checks, so spoken history is not silently converted into a visual observation.
- **Evidence binding:** validate returned source IDs against stored media/transcript, require a quote/visible-region descriptor for each, and verify transcript quotes occur in the transcript. Keep suggestions pending; prevent approval with pending claims, missing evidence, unresolved conflicts, or unsupported image quality.
- **Review/export:** clinician controls the wording and approval; the SOAP draft carries source IDs. Export is an idempotent local simulation. There is no EHR connector yet.

The model's `observed/uncertain/not assessable` tags are **not calibrated confidence scores**, and source IDs do not prove that an image claim is true. The doctor must inspect the actual photo. Phone zoom cannot measure lesion size. The first AI version is a guarded documentation workflow, not a trained dermatology classifier.

## Validation and next work

`npm test` (isolated synthetic fixtures with mocked model responses), `npm run typecheck`, `npm run build`, and `node scripts/smoke.cjs` with the app running exercise the one-use QR, consent, media authorization, image-quality warning, and approval/export gate. The automated tests cover routing, crop pixels, invalid measurements/fields, uncertainty abstention, review edits, revision conflicts, approval revocation, and API failure behavior. Mocked responses test software behavior; they do not establish medical accuracy. For an optional live synthetic API check, run `SMOKE_BASE=http://localhost:3000 LIVE_AI=1 node scripts/smoke.cjs` against the running app. A 429 response means quota/rate limits must be resolved. Live transcription, model output quality, browser/phone capture, and real EHR integration require separate testing. The [evaluation protocol](evals/README.md) defines stratified review across skin tones, lighting, accents, and terminology; no clinical performance has been established.

Before any real-patient pilot: implement real clinician authentication and role/encounter authorization, approved hosting/storage and retention, vendor agreements and privacy review, secure media handling and audit controls, validated conflict detection, and a genuine EHR sandbox adapter with FHIR identity matching and idempotent writes. Obtain clinical/regulatory review of intended image-analysis claims.

### Verification for this update

Production build and seven automated tests pass. A browser run with synthetic imagery and controlled API responses exercised drag selection, measured-size entry, structured editing, approval, mobile layout at 390 px, and revocation after a measurement change. The existing HTTP workflow smoke check also passes. A live synthetic request was attempted on 2026-10-24 and returned OpenAI HTTP 429 (quota/rate limit); live descriptive accuracy and transcription remain unverified. No fabricated output is substituted when the real API fails.
