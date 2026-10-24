# Aura Visual Scribe — hackathon research prototype

A Next.js demo for a fictional patient-linked capture → review → approval workflow. **Use fictional dialogue and non-patient images only.** This is not an authenticated EHR, clinical software, or a HIPAA-compliant deployment.

For teammates and their coding assistants, see the shareable [LLM handoff](docs/LLM_HANDOFF.md) for project context, implementation status, known failures, and continuation instructions. Read `AGENTS.md` before contributing.

## Run

Use Node.js 20.9 or newer:

```bash
npm ci
npm run dev
```

Open http://localhost:3000. MedGemma is the application image-analysis provider by default; copy `.env.example` to ignored `.env.local`, obtain the shared server key securely, and connect to the team Tailscale network. Image-only analysis does not require an OpenAI key and never falls back to GPT-4o. `OPENAI_API_KEY` remains optional for audio transcription and transcript-derived documentation only. Never commit, upload, or paste credentials. See [MedGemma setup and limitations](docs/medgemma.md). Audio recording requires localhost or HTTPS and browser permission. Mobile `capture="environment"` behavior varies by browser.

JPEG and PNG uploads default to a configurable 50 MB and 60-megapixel limit. SpotCheckMD applies EXIF orientation and stores a metadata-stripped, lossless PNG inference copy at the oriented source dimensions, plus a separate compressed preview. The full-resolution copy reaches the MedGemma service over authenticated multipart transport; MedGemma then normalizes every image to 896 × 896 and 256 vision tokens internally, so this is not native-resolution model processing. HEIC/HEIF is not accepted because decoder support is not consistent across the supported development machines.

Intel Macs can explicitly select the [experimental quantized CPU backend](docs/medgemma.md#experimental-intel-mac--native-cpu-backend). It converts authorized official weights locally and records conversion/runtime provenance. This is a separate runtime from the default Transformers service; quantization may change output quality and does not establish clinical validity.

## Demo journey

1. Choose one of two fictional patient profiles. Confirm the patient and all-party recording/processing consent.
2. Create a one-use, five-minute QR link and scan it on a phone on the **same reachable host**. For a phone, use an HTTPS tunnel or local network host; `localhost` on a laptop will refer to the phone itself. This prototype has **no clinician authentication**; anyone with the token can view its fictional encounter.
3. Capture staged images and/or short fictional audio. Photos are EXIF-oriented and stored as metadata-stripped, lossless full-dimension PNG inference copies; the UI uses separate previews. Brightness, detail, and resolution heuristics warn when to retake; they cannot certify image quality.
4. Save the selected specialty, image type, and any explicitly confirmed location/context, then run analysis. Review the transcript and each atomic suggestion with evidence links, uncertainty/quality flags, and an editable reviewer note. The system flags a basic left/right discrepancy, but humans must check for all other contradictions. Reject findings from photos marked `retake`; explain uncertain or edited findings.
5. Accept or reject every suggestion, resolve flagged conflicts, acknowledge any partial-analysis warnings, enter a demo clinician name, and approve. Any subsequent change revokes approval. The export button records a **simulation**, never sends anything to an EHR.

Drafts, transcripts, lossless inference images, preview images, and audio are stored in `.aura-data/` on the local server, ignored by git. Delete that directory to remove this demo's stored data. Do not treat this as a privacy/retention policy for real patient records. Server state is a local JSON file with a single-process write lock; it is not safe for multiple server replicas or production. Sessions are anonymous demo cookies; QR codes are temporary encounter capabilities, not identity verification.

## Visual algorithm

- **Preflight:** decode/rotate, strip metadata, resize, and flag low resolution, extreme lighting, and low edge detail. This heuristic can misclassify uniform images or miss blur/glare; retake advice is advisory.
- **Constrained multimodal suggestion:** send each photo with its source ID and quality warnings, plus a separate transcript source, to a vision model. Request strict structured, atomic observations. Image-derived suggestions are limited to visible descriptors; no lesion diagnosis, malignancy probability, unmeasured size, or treatment is inferred.
- **Evidence binding:** validate returned source IDs against stored media/transcript, require a quote/visible-region descriptor for each, and verify transcript quotes occur in the transcript. Keep suggestions pending; prevent approval with pending claims, missing evidence, unresolved conflicts, or unsupported image quality.
- **Review/export:** clinician controls the wording and approval; the SOAP draft carries source IDs. Export is an idempotent local simulation. There is no EHR connector yet.

The model's `observed/uncertain/not assessable` tags are **not calibrated confidence scores**, and source IDs do not prove that an image claim is true. The doctor must inspect the actual photo. Phone zoom cannot measure lesion size. The first AI version is a guarded documentation workflow, not a trained dermatology classifier.

## Validation and next work

`npm test`, `npm run typecheck`, `npm run build`, and `node scripts/smoke.cjs` with the app running exercise the one-use QR, consent, media authorization, image-quality warning, and approval/export gate. Live transcription, model output quality, browser/phone capture, and real EHR integration require separate testing. The [evaluation protocol](evals/README.md) defines stratified review across skin tones, lighting, accents, and terminology; no clinical performance has been established.

Before any real-patient pilot: implement real clinician authentication and role/encounter authorization, approved hosting/storage and retention, vendor agreements and privacy review, secure media handling and audit controls, validated conflict detection, and a genuine EHR sandbox adapter with FHIR identity matching and idempotent writes. Obtain clinical/regulatory review of intended image-analysis claims.
