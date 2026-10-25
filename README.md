# Aura Visual Scribe — hackathon research prototype

A Next.js demo for a fictional patient-linked capture → review → approval workflow. **Use fictional dialogue and non-patient images only.** This is not an authenticated EHR, clinical software, or a HIPAA-compliant deployment.

For teammates and their coding assistants, see the shareable [LLM handoff](docs/LLM_HANDOFF.md) for project context, implementation status, known failures, and continuation instructions. Read `AGENTS.md` before contributing.

## Run

Use Node.js 20.9 or newer:

```bash
npm ci
npm run dev
```

Open http://localhost:3000. MedGemma is the application image-analysis provider by default; copy `.env.example` to ignored `.env.local`, obtain the shared server key securely, and connect to the team Tailscale network. Image-only analysis does not require an OpenAI key and never falls back to GPT-4o. Set `TRANSCRIPTION_PROVIDER=assemblyai` with a server-only `ASSEMBLYAI_API_KEY` to use Medical Mode, one-speaker doctor diarization, timestamps, key terms and provisional live captions. Audio is treated as doctor dictation; do not record the patient's voice. In free local mode, review the transcript and add each clinician-authored finding to the appropriate SOAP section manually. Never commit, upload, or paste credentials. See [AssemblyAI transcription setup](docs/transcription.md) and [MedGemma setup and limitations](docs/medgemma.md). Audio recording requires localhost or HTTPS and browser permission. Mobile `capture="environment"` behavior varies by browser.

JPEG and PNG uploads default to a configurable 50 MB and 60-megapixel limit. SpotCheckMD applies EXIF orientation and stores a metadata-stripped, lossless PNG inference copy at the oriented source dimensions, plus a separate compressed preview. The full-resolution copy reaches the MedGemma service over authenticated multipart transport; MedGemma then normalizes every image to 896 × 896 and 256 vision tokens internally, so this is not native-resolution model processing. HEIC/HEIF is not accepted because decoder support is not consistent across the supported development machines.

Intel Macs can explicitly select the [experimental quantized CPU backend](docs/medgemma.md#experimental-intel-mac--native-cpu-backend). It converts authorized official weights locally and records conversion/runtime provenance. This is a separate runtime from the default Transformers service; quantization may change output quality and does not establish clinical validity.

## Demo journey

1. Open one of two fictional patient charts in **Demo EHR**. Review demographics, medications, allergies, history, dated results, and prior notes. Start a visit and confirm patient and all-party recording/processing consent. Select relevant history in the chart panel and save the reviewed selection.
2. Open the deployed app directly in the phone browser, using its HTTPS URL. The phone browser creates its own anonymous workspace; its camera and microphone capture directly into that workspace. On a laptop, localhost refers only to that laptop. This prototype has **no clinician authentication**.
3. Capture staged images and/or short fictional audio. Photos are EXIF-oriented and stored as metadata-stripped, lossless full-dimension PNG inference copies; the UI uses separate previews. Brightness, detail, and resolution heuristics warn when to retake; they cannot certify image quality.
4. Save the selected specialty, image type, and any explicitly confirmed location/context, then run analysis. With AssemblyAI selected, provisional streaming captions are replaced by an immutable post-visit transcript with speaker turns, word timestamps and confidence. The audio workflow expects the doctor to be the sole speaker. It detects and rejects recordings with multiple voices; review the transcript and add clinician-authored findings to the appropriate SOAP sections. Review every atomic suggestion with exact transcript/image evidence, uncertainty/quality flags, timestamps and an editable reviewer note. The system flags a basic left/right discrepancy, but humans must check for all other contradictions. Reject findings from photos marked `retake`; explain uncertain or edited findings.
5. Accept or reject every suggestion, resolve flagged conflicts, acknowledge partial-analysis warnings, and preview the exact note. Enter a demo clinician name and choose **Approve & send to Demo EHR**. The approved note is saved into this workspace’s fictional patient chart; its receipt opens the saved document. Later edits require approval and create a linked amendment. See [Demo EHR details](docs/ehr-demo.md).

Drafts, transcripts, lossless inference images, preview images, and audio are stored in `.aura-data/` on the local server, ignored by git. Delete that directory to remove this demo's stored data. Do not treat this as a privacy/retention policy for real patient records. Server state is a local JSON file with a single-process write lock; it is not safe for multiple server replicas or production. Sessions are anonymous browser cookies and remain in that browser for up to eight hours. Opening the app in a different browser or device starts a separate workspace; there is no cross-device encounter sharing.

## Visual algorithm

- **Preflight:** decode/rotate, strip metadata, resize, and flag low resolution, extreme lighting, and low edge detail. This heuristic can misclassify uniform images or miss blur/glare; retake advice is advisory.
- **Constrained multimodal suggestion:** send each photo with its source ID and quality warnings, plus a separate transcript source, to a vision model. Request strict structured, atomic observations. Image-derived suggestions are limited to visible descriptors; no lesion diagnosis, malignancy probability, unmeasured size, or treatment is inferred.
- **Evidence binding:** validate returned source IDs against stored media/transcript, require a quote/visible-region descriptor for each, and verify transcript quotes occur in the transcript. Keep suggestions pending; prevent approval with pending claims, missing evidence, unresolved conflicts, or unsupported image quality.
- **Review/export:** clinician controls the wording and approval; the SOAP draft carries source IDs. Approved notes are saved idempotently into the local Demo EHR chart with their history snapshot and model provenance. The adapter currently implements local simulation; no external EHR is connected.

The model's `observed/uncertain/not assessable` tags are **not calibrated confidence scores**, and source IDs do not prove that an image claim is true. The doctor must inspect the actual photo. Phone zoom cannot measure lesion size. The first AI version is a guarded documentation workflow, not a trained dermatology classifier.

## Validation and next work

`npm test`, `npm run typecheck`, `npm run build`, and `node scripts/smoke.cjs` with the app running exercise the direct browser workspace, consent, media authorization, image-quality warning, and approval/export gate. Live transcription, model output quality, browser/phone capture, and real EHR integration require separate testing. The [evaluation protocol](evals/README.md) defines stratified review across skin tones, lighting, accents, and terminology; no clinical performance has been established.

Before any real-patient pilot: implement real clinician authentication and role/encounter authorization, approved hosting/storage and retention, vendor agreements and privacy review, secure media handling and audit controls, validated conflict detection, and a genuine EHR sandbox adapter with FHIR identity matching and idempotent writes. Obtain clinical/regulatory review of intended image-analysis claims.
