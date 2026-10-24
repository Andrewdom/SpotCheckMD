import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { imageAnalysisSchema, transcriptWindows, validateImageAnalysis, UNCONFIRMED_ANATOMY_NOTE, type ImageRequest } from "../lib/image-analysis/contracts";
import { imageInstructions, imagePrompt } from "../lib/image-analysis/prompt";
import { analyzeEncounter, type PipelineDeps } from "../lib/image-analysis/pipeline";
import { medgemmaProvider, configuredImageProvider } from "../lib/image-analysis/providers";
import { composeNote, reviewBlockers } from "../lib/domain";
import { changed } from "../lib/store";
import { analysis, encounter, image, request, transcript } from "./fixtures";

function dependencies(calls: ImageRequest[] = []): PipelineDeps {
  return { provider: () => ({ id: "medgemma", analyze: async input => { calls.push(input); return { analysis: analysis(input), model: "google/medgemma-1.5-4b-it", modelRevision: "mock", latencyMs: 1, contextRange: input.transcript ? { start: input.transcript.start, end: input.transcript.end } : null }; } }), transcribe: async () => transcript.text!, readMedia: async () => Buffer.from("synthetic"), document: async t => [{ section: "S", text: "Patient reports no pain", certainty: "observed", limitation: "", sourceIds: [t.id], evidenceQuotes: ["Patient reports no pain"] }] };
}

test("Python contract and prompt match TypeScript source", () => {
  assert.deepEqual(JSON.parse(readFileSync("contracts/image-analysis.schema.json", "utf8")), z.toJSONSchema(imageAnalysisSchema));
  assert.equal(readFileSync("contracts/image-instructions.txt", "utf8"), imageInstructions + "\n");
});
test("image plus transcript retain distinct visual/context evidence and pending review", async () => {
  const calls: ImageRequest[] = [];
  const result = await analyzeEncounter(encounter(), "run", dependencies(calls));
  assert.equal(calls.length, 1); assert.equal(calls[0].transcript?.id, transcript.id);
  assert.equal(calls[0].transcript?.text, transcript.text);
  assert.equal(result.findings[0].origin, "spoken");
  const visual = result.findings.find(f => f.origin === "visual")!;
  assert.equal(visual.section, "O"); assert.equal(visual.review, "pending");
  assert.deepEqual(visual.evidence.map(e => e.role), ["visual", "context"]);
  assert.match(imagePrompt(calls[0]), /NEVER proof of visibility/);
});
test("image only avoids transcription/documentation and marks missing context", async () => {
  const calls: ImageRequest[] = [], deps = dependencies(calls);
  deps.document = deps.transcribe = async () => { throw Error("must not run"); };
  const result = await analyzeEncounter(encounter([image]), "run", deps);
  assert.equal(calls[0].transcript, null); assert.equal(result.warnings.length, 0);
  assert.match(result.findings[0].limitation, /No encounter transcript/);
});
test("transcript-only never constructs or invokes an image provider", async () => {
  const deps = dependencies(); deps.provider = () => { throw Error("must not run"); };
  const result = await analyzeEncounter(encounter([transcript]), "run", deps);
  assert.equal(result.analyses.length, 0); assert.equal(result.findings.length, 1); assert.equal(result.warnings.length, 0);
});
test("audio-only transcription becomes its own stored source", async () => {
  const audio = { ...image, kind: "audio" as const, id: "audio-1", mime: "audio/webm" };
  const result = await analyzeEncounter(encounter([audio]), "run", dependencies());
  assert.equal(result.newSources[0].kind, "transcript");
  assert.equal(result.findings[0].evidence[0].sourceId, result.newSources[0].id);
});
test("multiple images are sent separately and cannot cross-attribute features", async () => {
  const calls: ImageRequest[] = [];
  const result = await analyzeEncounter(encounter([image, { ...image, id: "image-2" }, transcript]), "run", dependencies(calls));
  assert.deepEqual(calls.map(c => c.image.id), ["image-1", "image-2"]);
  assert.deepEqual(result.findings.filter(f => f.origin === "visual").map(f => f.evidence[0].sourceId), ["image-1", "image-2"]);
  const invalid = analysis(); invalid.characteristics[0].evidence.imageSourceId = "image-2";
  assert.throws(() => validateImageAnalysis(invalid, request()));
});
test("transcription failure still analyzes images with explicit partial-result warning", async () => {
  const calls: ImageRequest[] = [], deps = dependencies(calls); deps.transcribe = async () => { throw Error("private provider details"); };
  const result = await analyzeEncounter(encounter([image, { ...image, id: "audio", kind: "audio" }]), "run", deps);
  assert.equal(calls[0].transcript, null); assert.equal(result.newSources.length, 0);
  assert.match(result.warnings[0], /transcription failed/); assert.doesNotMatch(result.warnings.join(), /private provider/);
});
test("visual conflicts link actual finding IDs and gate physician approval", async () => {
  const deps = dependencies(); const base = deps.provider();
  deps.provider = () => ({ ...base, analyze: async input => { const result = await base.analyze(input); result.analysis.conflicts.push({ description: "Visible swelling may disagree with spoken description", characteristicIds: ["c1"], transcriptSourceId: transcript.id, transcriptQuote: "Clinician says no swelling." }); return result; } });
  const result = await analyzeEncounter(encounter(), "run", deps);
  const e = encounter(); e.findings = result.findings; e.conflicts = result.conflicts;
  assert.ok(e.findings.some(f => f.id === result.conflicts[0].findingIds[0]));
  assert.ok(reviewBlockers(e).some(x => /Resolve each conflict/.test(x)));
});
test("not_assessable requires a limitation and reviewer explanation", () => {
  const value = analysis(); value.characteristics[0].certainty = "not_assessable";
  validateImageAnalysis(value, request()); value.characteristics[0].limitations = "";
  assert.throws(() => validateImageAnalysis(value, request()));
});
for (const [name, mutate] of Object.entries({
  "unknown source": (a: ReturnType<typeof analysis>) => { a.characteristics[0].evidence.transcriptSourceId = "foreign"; },
  "invented quote": (a: ReturnType<typeof analysis>) => { a.characteristics[0].evidence.transcriptQuote = "there IS swelling"; },
  "whitespace quote": (a: ReturnType<typeof analysis>) => { a.characteristics[0].evidence.transcriptQuote = "   "; },
  "history visually verified": (a: ReturnType<typeof analysis>) => { a.reportedHistory.push({ description: "History", attribution: "patient_report", transcriptSourceId: transcript.id, transcriptQuote: "Patient reports no pain", verifiedByCurrentImage: true as false }); },
  "transcript visually confirmed": (a: ReturnType<typeof analysis>) => { a.anatomicalRegion = { value: "left forearm", source: "transcript", transcriptQuote: "left forearm", visuallyConfirmed: true }; },
  "invalid conflict": (a: ReturnType<typeof analysis>) => { a.conflicts.push({ description: "Conflict", characteristicIds: ["missing"], transcriptSourceId: transcript.id, transcriptQuote: "no swelling" }); },
})) test(`rejects ${name}`, () => { const a = analysis(); mutate(a); assert.throws(() => validateImageAnalysis(a, request())); });
test("unconfirmed image-sourced anatomy is discarded with a limitation, confirmed anatomy is kept", () => {
  for (const [value, confirmed] of [["circle", false], ["", true]] as const) {
    const a = analysis(); a.anatomicalRegion = { value, source: "image", visuallyConfirmed: confirmed, transcriptQuote: null };
    const result = validateImageAnalysis(a, request());
    assert.deepEqual(result.anatomicalRegion, { value: "", source: "unknown", visuallyConfirmed: false, transcriptQuote: null });
    assert.ok(result.limitations.includes(UNCONFIRMED_ANATOMY_NOTE));
    assert.equal(result.characteristics.length, a.characteristics.length);
  }
  const kept = analysis(); kept.anatomicalRegion = { value: "forearm", source: "image", visuallyConfirmed: true, transcriptQuote: null };
  assert.equal(validateImageAnalysis(kept, request()).anatomicalRegion.value, "forearm");
  const full = analysis(); full.anatomicalRegion = { value: "circle", source: "image", visuallyConfirmed: false, transcriptQuote: null }; full.limitations = Array.from({ length: 10 }, (_, i) => `limit ${i}`);
  assert.equal(validateImageAnalysis(full, request()).limitations.length, 10);
});
test("schema rejects malformed responses and unexpected diagnosis fields", () => {
  for (const value of [null, "text", {}, { ...analysis(), diagnosis: "unsupported" }, { ...analysis(), requiresPhysicianReview: false }]) assert.throws(() => validateImageAnalysis(value, request()));
});
test("long context covers every character without dropping negation, laterality or history", () => {
  const text = "Patient denies fever. No swelling of the LEFT arm. Change six months ago. Dr. Demo reports 1.5 units; do not infer size. ".repeat(200);
  const windows = transcriptWindows({ id: "t", text }, 1000);
  const covered = new Set<number>();
  windows.forEach(w => { assert.equal(w.text, text.slice(w.start, w.end)); for (let i = w.start; i < w.end; i++) covered.add(i); });
  assert.equal(covered.size, text.length); assert.ok(windows.length > 1);
  assert.ok(windows.some(w => w.text.includes("No swelling of the LEFT arm.")));
  assert.throws(() => transcriptWindows({ id: "t", text: "x".repeat(6001) }));
});
test("image provider failure leaves spoken findings and redacted warnings, never falls back", async () => {
  const deps = dependencies(); deps.provider = () => ({ id: "medgemma", analyze: async () => { throw Error("private details"); } });
  const result = await analyzeEncounter(encounter(), "run", deps);
  assert.equal(result.findings.length, 1); assert.equal(result.findings[0].origin, "spoken");
  assert.match(result.warnings[0], /No fallback/); assert.doesNotMatch(result.warnings[0], /private/);
});
test("missing MedGemma configuration produces a model-specific image-only warning", async () => {
  const previousUrl = process.env.MEDGEMMA_URL, previousKey = process.env.MEDGEMMA_API_KEY;
  delete process.env.MEDGEMMA_URL; delete process.env.MEDGEMMA_API_KEY;
  try {
    const deps = dependencies(); deps.provider = configuredImageProvider; deps.document = deps.transcribe = async () => { throw Error("must not run"); };
    const result = await analyzeEncounter(encounter([image]), "run", deps);
    assert.equal(result.findings.length, 0);
    assert.match(result.warnings[0], /MedGemma is not configured/);
    assert.match(result.warnings[0], /no fallback/i);
    assert.doesNotMatch(result.warnings[0], /OpenAI/i);
  } finally {
    if (previousUrl === undefined) delete process.env.MEDGEMMA_URL; else process.env.MEDGEMMA_URL = previousUrl;
    if (previousKey === undefined) delete process.env.MEDGEMMA_API_KEY; else process.env.MEDGEMMA_API_KEY = previousKey;
  }
});
test("approval and deterministic SOAP only finalize accepted evidence", async () => {
  const result = await analyzeEncounter(encounter(), "run", dependencies()); const e = encounter(); e.findings = result.findings;
  assert.match(composeNote(e), /Not documented/); assert.doesNotMatch(composeNote(e), /Possible visible/);
  assert.match(composeNote(e, false), /PENDING REVIEW/);
  e.findings.forEach(f => { f.review = "accepted"; f.reviewNote = "Physician reviewed source and uncertainty."; });
  assert.deepEqual(reviewBlockers(e), []); assert.match(composeNote(e), /Possible visible swelling/);
  e.analysisWarnings = ["Partial image failure"]; assert.ok(reviewBlockers(e).some(v => /Acknowledge/.test(v)));
  e.warningsAcknowledged = true; assert.deepEqual(reviewBlockers(e), []);
  e.sources[0].quality!.status = "retake"; assert.ok(reviewBlockers(e).some(v => /retake/.test(v)));
});
test("encounter edits cancel an owned run and revoke approval", () => {
  const e = encounter(); e.analysis = "running"; e.activeAnalysis = { id: "run", expiresAt: Date.now() + 1000 };
  changed(e, "clinical context updated"); assert.equal(e.analysis, "none"); assert.equal(e.activeAnalysis, undefined); assert.equal(e.approval, null);
});
test("MedGemma transport validates model identity, structured data and timeout failures", async () => {
  process.env.MEDGEMMA_URL = "http://127.0.0.1:8000"; process.env.MEDGEMMA_API_KEY = "test-only-not-a-secret";
  delete process.env.OPENAI_API_KEY;
  let sent: Record<string, unknown> = {};
  const fetcher = (async (_url, init) => { sent = JSON.parse(String(init?.body)); return Response.json({ analysis: analysis(), model: "google/medgemma-1.5-4b-it", modelRevision: "test-revision", latencyMs: 5 }); }) as typeof fetch;
  const result = await medgemmaProvider(fetcher).analyze(request());
  assert.equal(result.model, "google/medgemma-1.5-4b-it"); assert.ok(sent.imageBase64); assert.deepEqual(sent.transcript, request().transcript);
  await assert.rejects(medgemmaProvider(async () => { throw new DOMException("timeout", "TimeoutError"); }).analyze(request()), /no fallback/i);
  await assert.rejects(medgemmaProvider(async () => new Response(JSON.stringify({ detail: "redacted" }), { status: 502, headers: { "X-SpotCheckMD-Failure-Stage": "schema validation" } })).analyze(request()), /during schema validation/);
  await assert.rejects(medgemmaProvider(async () => new Response(JSON.stringify({ detail: "redacted" }), { status: 502, headers: { "X-SpotCheckMD-Failure-Stage": "private invalid stage" } })).analyze(request()), /failed with status 502/);
  await assert.rejects(medgemmaProvider(async () => Response.json({ analysis: analysis(), model: "different-model", modelRevision: "test", latencyMs: 1 })).analyze(request()), /no fallback/i);
  const runtime = { engine: "llama.cpp", engineRevision: "a".repeat(40), converterRevision: "b".repeat(40), quantization: "Q4_K_M", modelSha256: "c".repeat(64), projectorSha256: "d".repeat(64) };
  const local = await medgemmaProvider(async () => Response.json({ analysis: analysis(), model: "google/medgemma-1.5-4b-it", modelRevision: "e".repeat(40), runtime, latencyMs: 1 })).analyze(request());
  assert.deepEqual(local.runtime, runtime);
  const q8 = { ...runtime, quantization: "Q8_0" };
  const q8Result = await medgemmaProvider(async () => Response.json({ analysis: analysis(), model: "google/medgemma-1.5-4b-it", modelRevision: "e".repeat(40), runtime: q8, latencyMs: 1 })).analyze(request());
  assert.deepEqual(q8Result.runtime, q8);
  await assert.rejects(medgemmaProvider(async () => Response.json({ analysis: analysis(), model: "google/medgemma-1.5-4b-it", modelRevision: "e".repeat(40), runtime: { ...runtime, quantization: "unknown" }, latencyMs: 1 })).analyze(request()), /no fallback/i);
  delete process.env.IMAGE_ANALYSIS_PROVIDER; assert.equal(configuredImageProvider().id, "medgemma");
  process.env.IMAGE_ANALYSIS_PROVIDER = "openai"; assert.throws(configuredImageProvider, /only application image provider/); delete process.env.IMAGE_ANALYSIS_PROVIDER;
});
