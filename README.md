# SpotCheckMD

SpotCheckMD is a hackathon research prototype for physician-reviewed, evidence-linked SOAP documentation. A clinician can capture or upload images and doctor-only dictation in a phone or desktop browser, review model suggestions with their source evidence, and approve a note into the fictional Demo EHR.

The application uses **MedGemma 1.5 4B as its only image-analysis provider**. It does not switch to another image model if MedGemma fails. Audio transcription is a separate, provider-selected feature; AssemblyAI Medical Mode is supported, and legacy OpenAI transcription/documentation options remain configurable. See [transcription setup](docs/transcription.md).

> **Research prototype only.** Use fictional encounters and staged, non-patient images and audio, or other media with explicit authorization for the intended processing. This is not a clinically validated product, authenticated EHR, or HIPAA-compliant deployment. Do not use it for diagnosis, treatment decisions, or real patient records.

## Current workflow

1. Open the app in the phone or desktop browser. Each browser gets its own anonymous workspace. There is no QR pairing and no encounter synchronization between devices.
2. Select one of the fictional Demo EHR patients, review its chart, start an encounter, and confirm the demo patient and consent.
3. Capture images using the browser camera or upload them. Optionally record/upload doctor-only dictation. The AssemblyAI workflow expects the doctor to speak alone; recordings with multiple detected voices are rejected. Live captions are provisional; the completed post-visit transcript is authoritative.
4. Set the specialty, image type, and any explicitly confirmed context. MedGemma analyzes each image separately and may use bounded transcript windows as context. Transcript statements are not visual evidence.
5. Review the finalized transcript and every pending suggestion. Inspect the original image, linked evidence, uncertainty and limitations. Edit, accept, or reject each suggestion, resolve conflicts, and add clinician-authored findings manually as needed.
6. Preview the note and approve it for the fictional Demo EHR. This is a local simulation; it does not send data to an external EHR or FHIR endpoint.

## Run locally

Requirements: Node.js 20.9 or newer. The web app can run without a local model, but image analysis requires access to the authenticated MedGemma service. To test a phone, use an address reachable from the phone over HTTPS; `localhost` on a phone refers to the phone itself.

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

Open `http://localhost:3000` on the development computer. Configure `MEDGEMMA_URL` and `MEDGEMMA_API_KEY` in the ignored `.env.local` file; obtain the existing service key through the team's secure channel. Never commit, paste, print, or expose credentials to browser code. See [MedGemma setup](docs/medgemma.md).

For AssemblyAI Medical Mode, set `TRANSCRIPTION_PROVIDER=assemblyai` and a server-only `ASSEMBLYAI_API_KEY`. The default transcript-documentation behavior without an OpenAI key is local extractive/manual: review the transcript and add clinician-authored SOAP findings yourself. It does not automatically summarize or classify speech into SOAP sections. Audio recording requires browser microphone permission and localhost or HTTPS.

## Image handling and analysis

The app accepts JPEG and PNG. Defaults are 50 MB and 60 megapixels for app uploads, with a separately configurable inference-service size limit. It applies EXIF orientation, removes image metadata, stores a lossless oriented PNG for inference, and creates a separate compressed preview. The inference image retains its oriented pixel dimensions in transport; the MedGemma service resizes it to 896 × 896 and uses 256 vision tokens internally. This is not native-resolution model perception. HEIC/HEIF is not accepted.

Preflight checks flag low resolution, extreme lighting, and low edge detail. These are heuristics, not image-quality certification. The model is asked for structured visible observations and limitations, not lesion diagnoses, malignancy estimates, measurements, or treatment recommendations. The schema and evidence checks can catch malformed output and invalid source references; they cannot guarantee clinical correctness. Certainty tags are not calibrated probabilities. A physician must inspect every original image and verify every proposed statement.

## Data and security boundaries

By default, encounter state, transcripts, inference images, previews, and audio are stored in `.aura-data/`, ignored by Git. `AURA_DATA_DIR` can override that location. This is local JSON/media storage with a process-local lock, not durable encrypted or multi-replica production storage. Anonymous browser sessions last up to eight hours. Each browser/device has a separate workspace.

The Demo EHR contains fictional charts only. There is no clinician authentication, production authorization, external EHR adapter, FHIR connection, validated audit system, or production retention policy. The consent screen and free-text clinician name do not establish a patient's or clinician's real identity. Before any real-patient use, the project requires appropriate clinical, privacy, security, legal, and regulatory review, approved hosting and storage, real identity and authorization controls, audit/retention controls, and a validated EHR integration.

## Development checks

```powershell
npm run typecheck
npm test
npm run build
```

For the synthetic API workflow check, start the app and run:

```powershell
node scripts/smoke.cjs
```

These checks validate software contracts and demo workflow behavior. They do not establish clinical accuracy, fairness, diagnostic performance, or readiness for care. See the [evaluation guide](evals/README.md). Read [AGENTS.md](AGENTS.md) before contributing.

## MedGemma 1.5 reference

The image-analysis integration uses MedGemma 1.5 4B. See [the technical report](https://arxiv.org/abs/2604.05081), [MedGemma setup](docs/medgemma.md), and the applicable [HAI-DEF terms](https://developers.google.com/health-ai-developer-foundations/terms).

```bibtex
@article{sellergren2026medgemma,
  title={MedGemma 1.5 Technical Report},
  author={Sellergren, Andrew and Gao, Chufan and Mahvar, Fereshteh and Kohlberger, Timo and Jamil, Fayaz and Traverse, Madeleine and Tono, Alberto and Sadjad, Bashir and Yang, Lin and Lau, Charles and others},
  journal={arXiv preprint arXiv:2604.05081},
  year={2026}
}
```
