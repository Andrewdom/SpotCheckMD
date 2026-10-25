import test from "node:test";
import assert from "node:assert/strict";
import { composeNote, type Finding, type Source } from "../lib/domain";
import { activeWordIndex, buildEvidenceMap, computePeaks, findCharacteristic, reviewTone, sealState, wordsInSpan } from "../lib/evidence-map";
import { createTranscriptArtifact, locateTranscriptEvidence } from "../lib/transcription/types";
import { encounter, image } from "./fixtures";

const audio: Source = { id: "audio-1", kind: "audio", label: "Encounter audio", mediaId: "b".repeat(32), mime: "audio/webm", createdAt: image.createdAt };
const words = (speaker: string, items: [string, number, number, number | null][]) => items.map(([text, startMs, endMs, confidence]) => ({ text, startMs, endMs, confidence, speaker }));
const utterances = [
  { id: "utterance-1", speaker: "CLINICIAN", startMs: 1000, endMs: 2300, text: "I have intense pain.", words: words("CLINICIAN", [["I", 1000, 1100, 0.99], ["have", 1110, 1300, 0.98], ["intense", 1310, 1700, 0.4], ["pain.", 1710, 2200, null]]) },
  { id: "utterance-2", speaker: "CLINICIAN", startMs: 2500, endMs: 3900, text: "Please continue cetirizine.", words: words("CLINICIAN", [["Please", 2500, 2800, 0.99], ["continue", 2810, 3200, 0.98], ["cetirizine.", 3210, 3800, 0.97]]) },
];
const artifactFor = (items = utterances) => createTranscriptArtifact({ bytes: Buffer.from("synthetic"), transcriptSourceId: "transcript-1", audioSourceId: audio.id, provider: "assemblyai", model: "mock", finalizedAt: image.createdAt, settings: { medicalMode: true, speakerLabels: true, keyterms: [] }, utterances: items });

function finding(over: Partial<Finding> & Pick<Finding, "id">): Finding {
  return { section: "S", text: "Reported intense pain", originalText: "Reported intense pain", origin: "spoken", certainty: "observed", limitation: "", evidence: [], review: "accepted", reviewNote: "", ...over };
}

function fixture(items = utterances) {
  const artifact = artifactFor(items);
  const e = encounter([image, audio, { id: "transcript-1", kind: "transcript", label: "Unverified timestamped transcript", text: artifact.text, mediaId: audio.mediaId, transcriptArtifactId: artifact.id, createdAt: image.createdAt }]);
  e.transcripts = [artifact];
  return { e, artifact };
}

test("spoken evidence keeps the stored word timing and resolves the audio media", () => {
  const { e, artifact } = fixture();
  const quote = "intense pain.";
  e.findings = [finding({ id: "f1", evidence: [{ sourceId: "transcript-1", quote, role: "spoken", transcript: locateTranscriptEvidence(artifact, quote) }] })];
  const [sentence] = buildEvidenceMap(e, { approvedOnly: true }).sentences;
  const span = sentence.links[0].audio!;
  assert.deepEqual([span.startMs, span.endMs, span.wordStart, span.wordEnd], [1310, 2200, 2, 3]);
  assert.equal(span.audioMediaId, audio.mediaId);
  assert.equal(span.audioMime, "audio/webm");
  assert.equal(sentence.links[0].valid, true);
  assert.deepEqual(wordsInSpan(artifact, span).map(word => word.text), ["intense", "pain."]);
});

test("a transcript quote without a stored locator is located from the transcript, and failures stay untimed", () => {
  const { e } = fixture();
  e.findings = [finding({ id: "f1", evidence: [{ sourceId: "transcript-1", quote: "Please continue" }] }), finding({ id: "f2", evidence: [{ sourceId: "transcript-1", quote: "never said this", role: "context" }] })];
  const [located, unlocated] = buildEvidenceMap(e, { approvedOnly: true }).sentences;
  assert.equal(located.links[0].audio?.utteranceId, "utterance-2");
  assert.equal(unlocated.links[0].audio, null);
  assert.equal(unlocated.links[0].kind, "context");
});

test("untimed transcripts (zero-length OpenAI utterance) never produce a playable span", () => {
  const { e, artifact } = fixture([{ id: "utterance-1", speaker: "UNKNOWN", startMs: 0, endMs: 0, text: "I have intense pain.", words: [] }]);
  e.findings = [finding({ id: "f1", evidence: [{ sourceId: "transcript-1", quote: "intense pain.", role: "spoken", transcript: locateTranscriptEvidence(artifact, "intense pain.") }] })];
  const map = buildEvidenceMap(e, { approvedOnly: true });
  assert.equal(map.sentences[0].links[0].audio, null);
  assert.equal(map.audio?.timed, false);
});

test("evidence pointing at an unknown source is kept and flagged invalid", () => {
  const { e } = fixture();
  e.findings = [finding({ id: "f1", evidence: [{ sourceId: "missing-source", quote: "anything" }] })];
  const link = buildEvidenceMap(e, { approvedOnly: true }).sentences[0].links[0];
  assert.equal(link.valid, false);
  assert.equal(link.audio, null);
  assert.equal(link.image, null);
});

test("visual findings find their characteristic by run, image and original wording", () => {
  const { e } = fixture();
  const characteristic = { id: "c1", category: "Appearance", description: "Possible visible swelling", certainty: "uncertain" as const, limitations: "The view is limited", evidence: { imageSourceId: image.id, visibleRegion: "central area", transcriptSourceId: null, transcriptQuote: null } };
  e.imageAnalyses = [{ runId: "run-1", provider: "medgemma", analysis: { imageSourceId: image.id, specialty: "general", imageType: "clinical photograph", anatomicalRegion: { value: "", source: "unknown", visuallyConfirmed: false, transcriptQuote: null }, characteristics: [characteristic], reportedHistory: [], conflicts: [], limitations: [], requiresPhysicianReview: true }, model: "m", modelRevision: "r", latencyMs: 1, contextRange: null }];
  const visual = finding({ id: "f1", section: "O", origin: "visual", text: "Reviewer-edited wording", originalText: "Possible visible swelling", analysisRunId: "run-1", evidence: [{ sourceId: image.id, quote: "central area", role: "visual" }, { sourceId: "transcript-1", quote: "Please continue", role: "context" }] });
  e.findings = [visual];
  const [sentence] = buildEvidenceMap(e, { approvedOnly: true }).sentences;
  assert.equal(sentence.links[0].image?.characteristic?.visibleRegion, "central area");
  assert.equal(sentence.links[0].image?.mediaId, image.mediaId);
  assert.equal(sentence.links[1].kind, "context");
  assert.equal(sentence.links[1].image, null);
  assert.equal(findCharacteristic(e, { ...visual, analysisRunId: "other-run" }, image.id), undefined);
  assert.equal(findCharacteristic(e, { ...visual, originalText: "different" }, image.id), undefined);
});

test("visual replay disambiguates identical wording using category and stored region evidence", () => {
  const { e } = fixture();
  const first = { id: "c1", category: "Appearance", description: "Visible color change", certainty: "uncertain" as const, limitations: "", evidence: { imageSourceId: image.id, visibleRegion: "upper-left area", transcriptSourceId: null, transcriptQuote: null } };
  const second = { ...first, id: "c2", category: "Color", evidence: { ...first.evidence, visibleRegion: "lower-right area" } };
  e.imageAnalyses = [
    { runId: "run-1", provider: "medgemma", analysis: { imageSourceId: image.id, specialty: "general", imageType: "clinical photograph", anatomicalRegion: { value: "", source: "unknown", visuallyConfirmed: false, transcriptQuote: null }, characteristics: [first], reportedHistory: [], conflicts: [], limitations: [], requiresPhysicianReview: true }, model: "m", modelRevision: "r", latencyMs: 1, contextRange: { start: 0, end: 50 } },
    { runId: "run-1", provider: "medgemma", analysis: { imageSourceId: image.id, specialty: "general", imageType: "clinical photograph", anatomicalRegion: { value: "", source: "unknown", visuallyConfirmed: false, transcriptQuote: null }, characteristics: [second], reportedHistory: [], conflicts: [], limitations: [], requiresPhysicianReview: true }, model: "m", modelRevision: "r", latencyMs: 1, contextRange: { start: 50, end: 100 } },
  ];
  const visual = finding({ id: "f1", section: "O", category: "Color", origin: "visual", text: second.description, originalText: second.description, analysisRunId: "run-1", evidence: [{ sourceId: image.id, quote: second.evidence.visibleRegion, role: "visual" }] });

  assert.equal(findCharacteristic(e, visual, image.id)?.visibleRegion, "lower-right area");
  assert.equal(findCharacteristic(e, { ...visual, evidence: [{ sourceId: image.id, quote: "unstored region", role: "visual" }] }, image.id), undefined);
});

test("sentence membership and order match composeNote", () => {
  const { e } = fixture();
  const quote = (id: string) => [{ sourceId: "transcript-1", quote: `quote ${id}` }];
  e.findings = [
    finding({ id: "plan", section: "P", text: "Plan item", originalText: "Plan item", evidence: quote("p") }),
    finding({ id: "pending", section: "S", text: "Pending item", originalText: "Pending item", review: "pending", evidence: quote("q") }),
    finding({ id: "rejected", section: "S", text: "Rejected item", originalText: "Rejected item", review: "rejected", evidence: quote("r") }),
    finding({ id: "subjective", section: "S", text: "Accepted item", originalText: "Accepted item", evidence: quote("s") }),
  ];
  for (const approvedOnly of [true, false]) {
    const note = composeNote(e, approvedOnly);
    const expected = e.findings.filter(f => note.includes(f.text)).map(f => f.id).sort();
    const shown = buildEvidenceMap(e, { approvedOnly }).sentences;
    assert.deepEqual(shown.map(s => s.findingId).sort(), expected);
  }
  assert.deepEqual(buildEvidenceMap(e, { approvedOnly: true }).sentences.map(s => s.section), ["S", "P"]);
  assert.deepEqual(buildEvidenceMap(e, { approvedOnly: true, includeRejected: true }).sentences.map(s => s.findingId), ["rejected", "subjective", "plan"]);
});

test("review tone separates accepted, edited, pending and rejected", () => {
  assert.equal(reviewTone(finding({ id: "a" })), "accepted");
  assert.equal(reviewTone(finding({ id: "b", text: "Changed" })), "edited");
  assert.equal(reviewTone(finding({ id: "c", review: "pending" })), "pending");
  assert.equal(reviewTone(finding({ id: "d", review: "rejected" })), "rejected");
});

test("active word lookup treats start as inclusive and end as exclusive", () => {
  const list = utterances[0].words;
  assert.equal(activeWordIndex(list, 999), -1);
  assert.equal(activeWordIndex(list, 1000), 0);
  assert.equal(activeWordIndex(list, 1100), -1);
  assert.equal(activeWordIndex(list, 1110), 1);
  assert.equal(activeWordIndex(list, 2199), 3);
  assert.equal(activeWordIndex(list, 2200), -1);
  assert.equal(activeWordIndex([], 5), -1);
});

test("waveform peaks are bounded, sized to the request, and safe on edge inputs", () => {
  assert.deepEqual([...computePeaks(new Float32Array([0.1, -0.5, 0.25, 0.2]), 2)], [0.5, 0.25]);
  assert.deepEqual([...computePeaks(new Float32Array([0, 0, 0, 0]), 3)], [0, 0, 0]);
  assert.equal(computePeaks(new Float32Array([0.3]), 4).length, 4);
  assert.deepEqual([...computePeaks(new Float32Array([0.3]), 4)], [Math.fround(0.3), Math.fround(0.3), Math.fround(0.3), Math.fround(0.3)]);
  assert.equal(computePeaks(new Float32Array(), 5).length, 5);
  assert.equal(computePeaks(new Float32Array([0.5]), 0).length, 0);
  assert.equal(computePeaks(new Float32Array([-3, 2]), 1)[0], 1);
});

test("seal state distinguishes sealed, mismatched, revoked, unverifiable and never-approved", () => {
  const { e } = fixture();
  assert.equal(sealState(e, "abc").kind, "none");
  e.revision = 4;
  e.approval = { revision: 4, physician: "Typed Name", at: "2026-10-24T00:00:00Z", note: "n", digest: "abc" };
  assert.equal(sealState(e, "abc").kind, "sealed");
  assert.equal(sealState(e, "different").kind, "mismatch");
  assert.equal(sealState(e, null).kind, "unverifiable");
  e.approval.revision = 3;
  assert.equal(sealState(e, "abc").kind, "mismatch");
  e.approval = null;
  e.audit = [{ at: "t1", action: "created", revision: 0 }, { at: "t2", action: "approved", revision: 4 }, { at: "t3", action: "finding reviewed", revision: 5 }, { at: "t4", action: "media added", revision: 6 }];
  e.revision = 6;
  const revoked = sealState(e, "abc");
  assert.ok(revoked.kind === "revoked");
  assert.deepEqual([revoked.approvedRevision, revoked.currentRevision, revoked.changes.map(change => change.action)], [4, 6, ["finding reviewed", "media added"]]);
  e.audit = e.audit.slice(0, 1);
  assert.equal(sealState(e, "abc").kind, "none");
});
