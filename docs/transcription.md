# AssemblyAI medical transcription

SpotCheckMD supports provider-selected post-visit transcription. The default remains the existing OpenAI path for compatibility. Set `TRANSCRIPTION_PROVIDER=assemblyai` to use AssemblyAI. This prototype accepts fictional or otherwise explicitly authorized demonstration audio only and is not a HIPAA-compliant deployment.

## Configuration

Keep credentials in server-only environment configuration. Never put the permanent key in client code, source control, request URLs, or screenshots.

```env
TRANSCRIPTION_PROVIDER=assemblyai
ASSEMBLYAI_API_KEY=...
ASSEMBLYAI_TIMEOUT_MS=180000
SOAP_DOCUMENTATION_PROVIDER=extractive
# Optional provider model overrides:
# ASSEMBLYAI_SPEECH_MODEL=universal-3-5-pro
# ASSEMBLYAI_STREAMING_MODEL=u3-rt-pro
```

`SOAP_DOCUMENTATION_PROVIDER=extractive` is the zero-cost default when `OPENAI_API_KEY` is absent. It does not classify transcript sentences into SOAP sections or create findings automatically. Review the finalized doctor-dictation transcript and add exact, clinician-authored statements manually to the appropriate section. It performs no diagnosis, clinical summarization, medication reconciliation, assessment, or plan generation. Set the provider to `openai` only when a server-side OpenAI key is configured and its external processing is authorized.

Before processing PHI, execute the appropriate AssemblyAI BAA and configure data retention, model-training opt-out, region, deletion, access control, audit, and incident-response requirements for the intended deployment. The MVP physician login, PostgreSQL deployment, fictional Demo EHR and free-text note signature are not production controls.

## Authoritative post-visit flow

1. The browser records the encounter into its existing WebM/MP4 file.
2. Analysis uploads the saved audio from the server to AssemblyAI. The permanent key never reaches the browser.
3. The request enables Medical Mode, speaker diarization constrained to one expected speaker, word timestamps/confidence and bounded key terms from the fictional patient's active medication, condition and allergy titles. The sole supported speaker is the doctor. If AssemblyAI identifies multiple voices, the transcript is rejected and the audio must be re-recorded with the doctor speaking alone.
4. The completed provider response is validated and converted into a versioned transcript artifact containing the audio SHA-256, provider/model/settings, utterances, every returned word timestamp/confidence, canonical text and a digest of the artifact. The source and artifact are append-only through the application API. A future retranscription must create a new artifact linked with `supersedesId`; it must not rewrite an earlier artifact.
5. Transcript documentation suggestions remain pending. Exact quotes must occur in the stored source. When a quote is contained within one utterance, its speaker, utterance, word range and audio timestamps are attached to the finding.
6. The doctor listens to and reviews the finalized dictation. The application labels the single detected speaker as the clinician; it does not infer that the patient is speaking. Any patient-reported history must be explicitly attributed by the doctor, and every resulting finding remains subject to clinician review.
7. The approved note includes source IDs, confirmed attribution and timestamp ranges. The Demo EHR note retains transcript artifact hashes and provider/model/settings provenance; full transcript artifacts remain with the encounter.

Qualitative statements stay qualitative: for example, “intense pain” cannot become “9/10” unless the recording contains that numeric score. Transcript statements are reported evidence, not independently verified facts.

## Live captions

During recording, the browser requests a single-use, short-lived AssemblyAI streaming token from `/api/transcription-token`. That route verifies the session, encounter revision, fictional patient confirmation and consent before minting the token. The browser streams 16 kHz PCM derived from the same microphone stream used by `MediaRecorder`; it never receives the permanent API key.

Live turns are displayed as provisional captions. They are not persisted, quoted in findings or sent to the EHR. When recording stops, the completed recording is uploaded normally and the post-visit artifact becomes the only authoritative transcript. If streaming is unavailable, recording continues and post-visit transcription can still succeed.

## Provider compatibility and failure behavior

`TRANSCRIPTION_PROVIDER` accepts `openai` or `assemblyai`. Unknown values fail closed. AssemblyAI failures produce the existing redacted partial-analysis warning; provider response content and credentials are not logged. Images may still be reviewed without a transcript, and there is no automatic provider fallback.

The existing MedGemma interface is unchanged: it receives bounded windows from the stored canonical transcript as optional context. Spoken content remains context rather than visual proof, and chart history is not added to model input by this feature.

## Verification

`npm test` covers the medical request, provider response validation, immutable hashes, exact quote-to-word/time binding, legacy speaker-role approval gates, temporary streaming token parameters and PCM bounds. Run `npm run typecheck` and `npm run build` as usual. Mock tests do not establish live transcription accuracy. Any live check must use fictional dialogue, report the actual provider/model and avoid placing raw transcripts or credentials in source control.
