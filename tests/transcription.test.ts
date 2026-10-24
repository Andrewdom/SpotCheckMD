import test from "node:test";
import assert from "node:assert/strict";
import { assemblyAITranscriptionProvider, configuredTranscriptionProvider } from "../lib/transcription/providers";
import { assemblyAIStreamingSession } from "../lib/transcription/streaming";
import { createTranscriptArtifact, locateTranscriptEvidence } from "../lib/transcription/types";
import { downsampleToPCM16 } from "../lib/transcription/pcm";
import { extractiveSubjectiveFindings, soapDocumentationMode } from "../lib/transcription/soap";
import { composeNote, reviewBlockers } from "../lib/domain";
import { encounter } from "./fixtures";

const completed = {
  id: "assembly-transcript-1", status: "completed", speech_model_used: "universal-3-5-pro", text: "I have intense pain. Please continue cetirizine.",
  utterances: [
    { speaker: "A", start: 1000, end: 2300, text: "I have intense pain.", words: [
      { text: "I", start: 1000, end: 1100, confidence: 0.99, speaker: "A" },
      { text: "have", start: 1110, end: 1300, confidence: 0.98, speaker: "A" },
      { text: "intense", start: 1310, end: 1700, confidence: 0.97, speaker: "A" },
      { text: "pain.", start: 1710, end: 2200, confidence: 0.96, speaker: "A" },
    ] },
    { speaker: "B", start: 2500, end: 3900, text: "Please continue cetirizine.", words: [
      { text: "Please", start: 2500, end: 2800, confidence: 0.99, speaker: "B" },
      { text: "continue", start: 2810, end: 3200, confidence: 0.98, speaker: "B" },
      { text: "cetirizine.", start: 3210, end: 3800, confidence: 0.97, speaker: "B" },
    ] },
  ],
};

test("AssemblyAI provider requests medical diarization and preserves immutable word evidence", async () => {
  process.env.ASSEMBLYAI_API_KEY = "synthetic-test-key";
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/v2/upload")) return Response.json({ upload_url: "https://example.test/private-audio" });
    return Response.json(completed);
  }) as typeof fetch;
  const artifact = await assemblyAITranscriptionProvider(fetcher).transcribe({ bytes: Buffer.from("synthetic audio"), mime: "audio/webm", audioSourceId: "audio-1", transcriptSourceId: "transcript-1", keyterms: ["cetirizine"] });
  const submitted = JSON.parse(String(requests[1].init?.body));
  assert.equal(submitted.domain, "medical-v1"); assert.equal(submitted.speaker_labels, true); assert.equal(submitted.speakers_expected, 2);
  assert.deepEqual(submitted.keyterms_prompt, ["cetirizine"]);
  assert.equal(artifact.provider, "assemblyai"); assert.equal(artifact.model, "universal-3-5-pro"); assert.equal(artifact.settings.medicalMode, true); assert.equal(artifact.utterances.length, 2);
  assert.match(artifact.text, /A \[0:01\]: I have intense pain/);
  const evidence = locateTranscriptEvidence(artifact, "intense pain.")!;
  assert.equal(evidence.speaker, "A"); assert.deepEqual([evidence.wordStart, evidence.wordEnd], [2, 3]); assert.deepEqual([evidence.startMs, evidence.endMs], [1310, 2200]);
  assert.match(artifact.audioSha256, /^[a-f0-9]{64}$/); assert.match(artifact.digest, /^[a-f0-9]{64}$/);
  delete process.env.ASSEMBLYAI_API_KEY;
});

test("speaker-role confirmation gates approved spoken evidence and appears in composed SOAP provenance", () => {
  const artifact = createTranscriptArtifact({ bytes: Buffer.from("synthetic"), transcriptSourceId: "transcript-1", audioSourceId: "audio-1", provider: "assemblyai", model: "mock", finalizedAt: new Date().toISOString(), settings: { medicalMode: true, speakerLabels: true, keyterms: [] }, utterances: completed.utterances.map((utterance, index) => ({ id: `utterance-${index + 1}`, speaker: utterance.speaker, startMs: utterance.start, endMs: utterance.end, text: utterance.text, words: utterance.words.map(word => ({ text: word.text, startMs: word.start, endMs: word.end, confidence: word.confidence, speaker: word.speaker })) })) });
  const e = encounter([{ id: "transcript-1", kind: "transcript", label: "Transcript", text: artifact.text, transcriptArtifactId: artifact.id, createdAt: artifact.finalizedAt }]);
  e.transcripts = [artifact];
  e.findings = [{ id: "finding", section: "S", text: "Reports intense pain", originalText: "Reports intense pain", origin: "spoken", certainty: "observed", limitation: "", evidence: [{ sourceId: "transcript-1", quote: "intense pain.", role: "spoken", transcript: locateTranscriptEvidence(artifact, "intense pain.") }], review: "accepted", reviewNote: "" }];
  assert.ok(reviewBlockers(e).some(blocker => /Confirm which transcript speaker/.test(blocker)));
  e.transcriptRoles = { artifactId: artifact.id, patientSpeaker: "A", clinicianSpeaker: "B", confirmedAt: new Date().toISOString() };
  assert.deepEqual(reviewBlockers(e), []);
  assert.match(composeNote(e), /patient; 0:01–0:02/);
  assert.doesNotMatch(composeNote(e), /9\/10/);
});

test("free local SOAP mode extracts only exact confirmed patient statements", () => {
  const artifact = createTranscriptArtifact({ bytes: Buffer.from("synthetic"), transcriptSourceId: "transcript-1", audioSourceId: "audio-1", provider: "assemblyai", model: "mock", finalizedAt: new Date().toISOString(), settings: { medicalMode: true, speakerLabels: true, keyterms: [] }, utterances: completed.utterances.map((utterance, index) => ({ id: `utterance-${index + 1}`, speaker: utterance.speaker, startMs: utterance.start, endMs: utterance.end, text: utterance.text, words: utterance.words.map(word => ({ text: word.text, startMs: word.start, endMs: word.end, confidence: word.confidence, speaker: word.speaker })) })) });
  const roles = { artifactId: artifact.id, patientSpeaker: "A", clinicianSpeaker: "B", confirmedAt: new Date().toISOString() };
  const findings = extractiveSubjectiveFindings(artifact, "A", roles);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].section, "S");
  assert.match(findings[0].text, /I have intense pain/);
  assert.equal(findings[0].evidence[0].quote, "I have intense pain.");
  assert.equal(findings[0].evidence[0].transcript?.speaker, "A");
  assert.doesNotMatch(findings[0].text, /cetirizine/);
  delete process.env.OPENAI_API_KEY; delete process.env.SOAP_DOCUMENTATION_PROVIDER;
  assert.equal(soapDocumentationMode(), "extractive");
});

test("streaming session returns only a short-lived browser token URL and PCM conversion is bounded", async () => {
  process.env.TRANSCRIPTION_PROVIDER = "assemblyai"; process.env.ASSEMBLYAI_API_KEY = "synthetic-test-key";
  let authorization = "";
  const session = await assemblyAIStreamingSession(["cetirizine"], (async (_url, init) => { authorization = String((init?.headers as Record<string, string>).Authorization); return Response.json({ token: "temporary-token-value" }); }) as typeof fetch);
  assert.equal(authorization, "synthetic-test-key");
  const url = new URL(session.url); assert.equal(url.protocol, "wss:"); assert.equal(url.searchParams.get("domain"), "medical-v1"); assert.equal(url.searchParams.get("speaker_labels"), "true"); assert.equal(url.searchParams.get("token"), "temporary-token-value");
  const pcm = new Int16Array(downsampleToPCM16(new Float32Array([2, 1, 0, -1, -2, 0]), 48000));
  assert.equal(pcm.length, 2); assert.ok([...pcm].every(value => value >= -32768 && value <= 32767));
  process.env.TRANSCRIPTION_PROVIDER = "unknown";
  assert.throws(() => configuredTranscriptionProvider(), /Unknown TRANSCRIPTION_PROVIDER/);
  delete process.env.TRANSCRIPTION_PROVIDER; delete process.env.ASSEMBLYAI_API_KEY;
});
