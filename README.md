# Aura Visual Scribe — hackathon research prototype

A Next.js demo for a fictional patient-linked capture → review → approval workflow. **Use fictional dialogue and non-patient images only.** This is not an authenticated EHR, clinical software, or a HIPAA-compliant deployment.

## Run

Use Node.js 20.9 or newer:

```bash
npm ci
npm run dev
```

Open http://localhost:3000. An existing ignored `.env.local` can contain `OPENAI_API_KEY` for analysis; never commit, upload, or paste the key. Capture and review UI work without live AI. The default image provider remains GPT-4o. Set `IMAGE_ANALYSIS_PROVIDER=medgemma` to use the separate official MedGemma 1.5 4B service with encounter-transcript context; provider failures never trigger a model fallback. The server retains `gpt-transcribe` for audio and GPT-4o for transcript documentation. MedGemma image-only analysis works without an OpenAI key. See [MedGemma setup and limitations](docs/medgemma.md). Audio recording requires localhost or HTTPS and browser permission. Mobile `capture="environment"` behavior varies by browser.

## Demo journey

1. Choose one of two fictional patient profiles. Confirm the patient and all-party recording/processing consent.
2. Create a one-use, five-minute QR link and scan it on a phone on the **same reachable host**. For a phone, use an HTTPS tunnel or local network host; `localhost` on a laptop will refer to the phone itself. This prototype has **no clinician authentication**; anyone with the token can view its fictional encounter.
3. Capture staged images and/or short fictional audio. Photos are normalized with EXIF metadata stripped. Brightness, detail, and resolution heuristics warn when to retake; they cannot certify image quality.
4. Save the selected specialty, image type, and any explicitly confirmed location/context, then run analysis. Review the transcript and each atomic suggestion with evidence links, uncertainty/quality flags, and an editable reviewer note. The system flags a basic left/right discrepancy, but humans must check for all other contradictions. Reject findings from photos marked `retake`; explain uncertain or edited findings.
5. Accept or reject every suggestion, resolve flagged conflicts, acknowledge any partial-analysis warnings, enter a demo clinician name, and approve. Any subsequent change revokes approval. The export button records a **simulation**, never sends anything to an EHR.

Drafts, transcripts, normalized images, and audio are stored in `.aura-data/` on the local server, ignored by git. Delete that directory to remove this demo's stored data. Do not treat this as a privacy/retention policy for real patient records. Server state is a local JSON file with a single-process write lock; it is not safe for multiple server replicas or production. Sessions are anonymous demo cookies; QR codes are temporary encounter capabilities, not identity verification.

## Visual algorithm

- **Preflight:** decode/rotate, strip metadata, resize, and flag low resolution, extreme lighting, and low edge detail. This heuristic can misclassify uniform images or miss blur/glare; retake advice is advisory.
- **Constrained multimodal suggestion:** send each photo with its source ID and quality warnings, plus a separate transcript source, to a vision model. Request strict structured, atomic observations. Image-derived suggestions are limited to visible descriptors; no lesion diagnosis, malignancy probability, unmeasured size, or treatment is inferred.
- **Evidence binding:** validate returned source IDs against stored media/transcript, require a quote/visible-region descriptor for each, and verify transcript quotes occur in the transcript. Keep suggestions pending; prevent approval with pending claims, missing evidence, unresolved conflicts, or unsupported image quality.
- **Review/export:** clinician controls the wording and approval; the SOAP draft carries source IDs. Export is an idempotent local simulation. There is no EHR connector yet.

The model's `observed/uncertain/not assessable` tags are **not calibrated confidence scores**, and source IDs do not prove that an image claim is true. The doctor must inspect the actual photo. Phone zoom cannot measure lesion size. The first AI version is a guarded documentation workflow, not a trained dermatology classifier.

## Validation and next work

`npm test`, `npm run typecheck`, `npm run build`, and `node scripts/smoke.cjs` with the app running exercise the one-use QR, consent, media authorization, image-quality warning, and approval/export gate. Live transcription, model output quality, browser/phone capture, and real EHR integration require separate testing. The [evaluation protocol](evals/README.md) defines stratified review across skin tones, lighting, accents, and terminology; no clinical performance has been established.

Before any real-patient pilot: implement real clinician authentication and role/encounter authorization, approved hosting/storage and retention, vendor agreements and privacy review, secure media handling and audit controls, validated conflict detection, and a genuine EHR sandbox adapter with FHIR identity matching and idempotent writes. Obtain clinical/regulatory review of intended image-analysis claims.
