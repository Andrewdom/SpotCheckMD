# SpotCheckMD

SpotCheckMD is a hackathon research prototype for physician-reviewed, evidence-linked SOAP documentation. A clinician can capture or upload images and doctor-only dictation in a phone or desktop browser, review model suggestions with their source evidence, and approve a note into the fictional Demo EHR.

The application uses **MedGemma 1.5 4B as its only image-analysis provider**. It does not switch to another image model if MedGemma fails. Audio transcription is a separate, provider-selected feature; AssemblyAI Medical Mode is supported, and legacy OpenAI transcription/documentation options remain configurable. See [transcription setup](docs/transcription.md).

Demo Website: https://spotcheckmd.goob3r.org/  
Username: demo-physician  
Password: SpotCheckDemo2026!

> **Research prototype only.** Use fictional encounters and staged, non-patient images and audio, or other media with explicit authorization for the intended processing. This is not a clinically validated product, authenticated EHR, or HIPAA-compliant deployment. Do not use it for diagnosis, treatment decisions, or real patient records.

## Current workflow

1. Sign in with a manually seeded physician account. The same account can access its organization-scoped fictional encounter workspace from phone and desktop. There is no public registration or QR pairing.
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
npm run db:migrate
npm run db:seed
npm run dev
```

Start PostgreSQL with `compose.dev.yaml` or another private local instance, then set `DATABASE_URL` and `AUTH_RATE_LIMIT_SECRET` in `.env.local` before migrating and seeding. Open `http://localhost:3000` on the development computer and sign in with the seeded account. Configure `MEDGEMMA_URL` and `MEDGEMMA_API_KEY` in the ignored `.env.local` file; obtain the existing service key through the team's secure channel. Never commit, paste, print, or expose credentials to browser code. See [PostgreSQL/authentication setup](docs/postgres-auth.md) and [MedGemma setup](docs/medgemma.md).

For AssemblyAI Medical Mode, set `TRANSCRIPTION_PROVIDER=assemblyai` and a server-only `ASSEMBLYAI_API_KEY`. The default transcript-documentation behavior without an OpenAI key is local extractive/manual: review the transcript and add clinician-authored SOAP findings yourself. It does not automatically summarize or classify speech into SOAP sections. Audio recording requires browser microphone permission and localhost or HTTPS.

The shared Unraid deployment uses a production Docker image, PostgreSQL-backed physician sessions and encounter state, private filesystem media, private loopback MedGemma connectivity, durable queued analysis, and the existing Cloudflare Tunnel. See [physician authentication and PostgreSQL](docs/postgres-auth.md) and [Unraid web deployment and operations](docs/unraid-web-deployment.md).

## Image handling and analysis

The app accepts JPEG and PNG. Defaults are 50 MB and 60 megapixels for app uploads, with a separately configurable inference-service size limit. It applies EXIF orientation, removes image metadata, stores a lossless oriented PNG for inference, and creates a separate compressed preview. The inference image retains its oriented pixel dimensions in transport; the MedGemma service resizes it to 896 × 896 and uses 256 vision tokens internally. This is not native-resolution model perception. HEIC/HEIF is not accepted.

Preflight checks flag low resolution, extreme lighting, and low edge detail. These are heuristics, not image-quality certification. The model is asked for structured visible observations and limitations, not lesion diagnoses, malignancy estimates, measurements, or treatment recommendations. The schema and evidence checks can catch malformed output and invalid source references; they cannot guarantee clinical correctness. Certainty tags are not calibrated probabilities. A physician must inspect every original image and verify every proposed statement.

## Evidence Replay

On the review screen, **Replay evidence** opens a read-only view of where each note sentence came from. Selecting a sentence plays the cited span of the recording (from the stored word timings), highlights those words in the transcript, and opens the cited photo beside the model-written description it was based on. Colored routes link each source to its sentences by review outcome, and a seal shows whether the approved note's SHA-256 digest, recomputed in the browser, still matches the server record or was revoked by a later edit.

It only re-arranges data the encounter already stores and fetches media through the existing session-checked media route. It draws no regions on photos, invents no timings, and treats provider word confidence as speech-recognition confidence, not clinical confidence. Transcripts without word-level timing (for example from the OpenAI fallback) show quotes without playback. The seal is display-only and the typed signature is not an authenticated identity. See `docs/evidence-replay.md` for how to use it and `docs/evidence-replay-plan.md` for the design record.

## Data and security boundaries

PostgreSQL stores physician sessions, encounter state, transcripts, analysis jobs, review decisions, approved snapshots, audit events, and simulated EHR records. Private image and audio bytes remain under `.aura-data/media/` by default; `AURA_DATA_DIR` can override that location. Sessions last up to twelve hours and can coexist on multiple devices. The aggregate transaction layer and inference worker still support one web container.

The Demo EHR contains fictional charts only. The physician login is an MVP identity boundary, not a production identity provider. There is no external EHR adapter, FHIR connection, validated audit system, or production retention policy. Before any real-patient use, the project requires appropriate clinical, privacy, security, legal, and regulatory review, approved hosting and storage, stronger identity lifecycle and authorization controls, audit/retention controls, and a validated EHR integration.

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
