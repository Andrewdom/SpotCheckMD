import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { Encounter } from "../lib/domain";
import { analysis } from "./fixtures";

let directory: string;
let api: typeof import("../app/api/demo/route");
before(async () => {
directory = await mkdtemp(path.join(tmpdir(), "spotcheckmd-route-tests-"));
process.env.AURA_DATA_DIR = directory;
process.env.IMAGE_ANALYSIS_PROVIDER = "medgemma";
process.env.MEDGEMMA_URL = "http://127.0.0.1:8000";
process.env.MEDGEMMA_API_KEY = "mock-inference-key-only";
process.env.OPENAI_API_KEY = "mock-openai-key-only";
api = await import("../app/api/demo/route");
});
const realFetch = globalThis.fetch;
let providerRequests = 0;
let failTranscription = false;
let release: (() => void) | undefined;
let entered: (() => void) | undefined;
globalThis.fetch = async (url, init) => {
  const address = String(url);
  if (address.includes("/audio/transcriptions")) return failTranscription ? Response.json({}, { status: 503 }) : Response.json({ text: "Patient reports no pain. Clinician says no swelling." });
  if (address === "https://api.openai.com/v1/responses") {
    const body = JSON.parse(String(init?.body));
    assert.ok(body.input[0].content.every((v: { type: string }) => v.type !== "input_image"), "MedGemma must not silently fall back to GPT images");
    const text = body.input[0].content[0].text as string;
    const id = /Transcript source ([^:]+):/.exec(text)![1];
    const findings = [{ section: "S", text: "Patient reports no pain", certainty: "observed", limitation: "", sourceIds: [id], evidenceQuotes: ["Patient reports no pain"] }];
    return Response.json({ output: [{ content: [{ type: "output_text", text: JSON.stringify({ findings }) }] }] });
  }
  if (address === "http://127.0.0.1:8000/analyze") {
    providerRequests++;
    const form = init?.body as FormData;
    const body = JSON.parse(String(form.get("metadata")));
    const imageFile = form.get("image") as unknown;
    assert.ok(imageFile && typeof imageFile === "object");
    assert.equal((imageFile as Blob).type, "image/png");
    if (entered) { entered(); entered = undefined; await new Promise<void>(resolve => { release = resolve; }); }
    const result = analysis({ image: { id: body.imageSourceId, bytes: Buffer.from("mock"), mime: "image/png", quality: body.quality }, transcript: body.transcript, context: body.context });
    return Response.json({ analysis: result, model: "google/medgemma-1.5-4b-it", modelRevision: "mock", latencyMs: 1 });
  }
  throw new Error("Unexpected network access blocked by test");
};
after(async () => { globalThis.fetch = realFetch; await rm(directory, { recursive: true, force: true }); });

async function session() {
  const origin = "http://localhost:3107";
  let cookie = "";
  async function action(name: string, data: Record<string, unknown> | FormData) {
    const response = await api.POST(new Request(`${origin}/api/demo?action=${name}`, { method: "POST", headers: { Origin: origin, Cookie: cookie, ...(data instanceof FormData ? {} : { "Content-Type": "application/json" }) }, body: data instanceof FormData ? data : JSON.stringify(data) }));
    if (response.headers.has("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0];
    return { status: response.status, body: await response.json() };
  }
  await action("bootstrap", {});
  let e = (await action("create", { patientId: "demo-001" })).body.encounter as Encounter;
  e = (await action("confirm", { encounterId: e.id, revision: e.revision, confirmed: true, consent: true })).body.encounter;
  async function upload(kind: "image" | "audio") {
    const bytes = kind === "image" ? await sharp({ create: { width: 800, height: 800, channels: 3, background: { r: 135, g: 115, b: 100 } } }).jpeg().toBuffer() : Buffer.from("mock-audio");
    const form = new FormData(); form.set("encounterId", e.id); form.set("revision", String(e.revision)); form.set("kind", kind); form.set("file", new Blob([new Uint8Array(bytes)], { type: kind === "image" ? "image/jpeg" : "audio/webm" }), kind === "image" ? "synthetic.jpg" : "synthetic.webm");
    const result = await action("upload", form); assert.equal(result.status, 200); e = result.body.encounter;
  }
  return { action, upload, get e() { return e; }, set e(value) { e = value; }, async reload() { const response = await api.GET(new Request(`${origin}/api/demo`, { headers: { Cookie: cookie } })); return (await response.json()).encounters.find((v: Encounter) => v.id === e.id) as Encounter; } };
}

test("API: contextual MedGemma findings, source validation, review, export and revocation", async () => {
  const s = await session(); await s.upload("image"); await s.upload("audio");
  let result = await s.action("context", { encounterId: s.e.id, revision: s.e.revision, context: { specialty: "urgent_care", imageType: "clinical_photo", anatomicalLocation: "left arm", physicianContext: "Fictional encounter" } }); s.e = result.body.encounter;
  result = await s.action("analyze", { encounterId: s.e.id, revision: s.e.revision }); assert.equal(result.status, 200); s.e = result.body.encounter;
  assert.equal(s.e.specialty, "urgent_care"); assert.equal(s.e.analysis, "ready"); assert.equal(s.e.findings.length, 2);
  assert.ok(s.e.sources.some(v => v.kind === "transcript"));
  assert.equal((await s.action("approve", { encounterId: s.e.id, revision: s.e.revision, physician: "Dr Demo" })).status, 400);
  const transcript = s.e.sources.find(v => v.kind === "transcript")!;
  assert.equal((await s.action("manual", { encounterId: s.e.id, revision: s.e.revision, sourceId: transcript.id, section: "S", text: "Invented history", evidenceQuote: "no such quote" })).status, 400);
  for (const f of [...s.e.findings]) s.e = (await s.action("review", { encounterId: s.e.id, revision: s.e.revision, findingId: f.id, review: "accepted", text: f.text, reviewNote: "Physician reviewed synthetic source and limitations." })).body.encounter;
  s.e = (await s.action("approve", { encounterId: s.e.id, revision: s.e.revision, physician: "Dr Demo" })).body.encounter;
  assert.match(s.e.approval!.note, /Possible visible swelling/);
  s.e = (await s.action("export", { encounterId: s.e.id, revision: s.e.revision })).body.encounter;
  const again = await s.action("export", { encounterId: s.e.id, revision: s.e.revision }); assert.equal(again.body.encounter.export.id, s.e.export!.id);
  s.e = (await s.action("context", { encounterId: s.e.id, revision: s.e.revision, context: { ...s.e.clinicalContext!, anatomicalLocation: "right arm" } })).body.encounter;
  assert.equal(s.e.approval, null); assert.equal(s.e.export, null);
});

test("API: image analysis remains usable after transcription failure, with acknowledgement gate", async () => {
  const s = await session(); await s.upload("image"); await s.upload("audio"); failTranscription = true;
  s.e = (await s.action("analyze", { encounterId: s.e.id, revision: s.e.revision })).body.encounter; failTranscription = false;
  assert.equal(s.e.findings.length, 1); assert.equal(s.e.findings[0].origin, "visual"); assert.ok(s.e.analysisWarnings!.length);
  s.e = (await s.action("review", { encounterId: s.e.id, revision: s.e.revision, findingId: s.e.findings[0].id, review: "accepted", text: s.e.findings[0].text, reviewNote: "Reviewed synthetic image and limitations" })).body.encounter;
  assert.equal((await s.action("approve", { encounterId: s.e.id, revision: s.e.revision, physician: "Dr Demo" })).status, 400);
  s.e = (await s.action("acknowledge-warnings", { encounterId: s.e.id, revision: s.e.revision })).body.encounter;
  assert.equal((await s.action("approve", { encounterId: s.e.id, revision: s.e.revision, physician: "Dr Demo" })).status, 200);
});

test("API: consent revocation cancels an in-flight run without stranding analysis or overwriting edits", async () => {
  const s = await session(); await s.upload("image");
  const hasEntered = new Promise<void>(resolve => { entered = resolve; });
  const running = s.action("analyze", { encounterId: s.e.id, revision: s.e.revision }); await hasEntered;
  s.e = await s.reload(); assert.equal(s.e.analysis, "running");
  s.e = (await s.action("confirm", { encounterId: s.e.id, revision: s.e.revision, confirmed: true, consent: false })).body.encounter;
  release!(); assert.equal((await running).status, 409);
  s.e = await s.reload(); assert.equal(s.e.consent, false); assert.equal(s.e.analysis, "none"); assert.equal(s.e.findings.length, 0);
  assert.equal((await s.action("analyze", { encounterId: s.e.id, revision: s.e.revision })).status, 400);
  s.e = (await s.action("confirm", { encounterId: s.e.id, revision: s.e.revision, confirmed: true, consent: true })).body.encounter;
  assert.equal((await s.action("analyze", { encounterId: s.e.id, revision: s.e.revision })).status, 200);
});

test("API: image-only defaults to MedGemma without an OpenAI key", async () => {
  const previousOpenAI = process.env.OPENAI_API_KEY, previousProvider = process.env.IMAGE_ANALYSIS_PROVIDER;
  delete process.env.OPENAI_API_KEY; delete process.env.IMAGE_ANALYSIS_PROVIDER;
  try {
    const s = await session(); await s.upload("image"); const before = providerRequests;
    const result = await s.action("analyze", { encounterId: s.e.id, revision: s.e.revision });
    assert.equal(result.status, 200); s.e = result.body.encounter;
    assert.equal(providerRequests, before + 1);
    assert.equal(s.e.analysis, "ready");
    assert.deepEqual(s.e.findings.map(f => f.origin), ["visual"]);
    assert.equal(s.e.model, "google/medgemma-1.5-4b-it");
  } finally {
    if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousOpenAI;
    if (previousProvider === undefined) delete process.env.IMAGE_ANALYSIS_PROVIDER; else process.env.IMAGE_ANALYSIS_PROVIDER = previousProvider;
  }
});

test("API: accepts a valid image larger than the former 10 MB limit", async () => {
  const s = await session();
  const jpeg = await sharp({ create: { width: 1800, height: 1700, channels: 3, background: { r: 100, g: 130, b: 160 } } }).jpeg().toBuffer();
  const padded = Buffer.concat([jpeg, Buffer.alloc(11 * 1024 * 1024)]);
  const form = new FormData();
  form.set("encounterId", s.e.id); form.set("revision", String(s.e.revision)); form.set("kind", "image");
  form.set("file", new Blob([new Uint8Array(padded)], { type: "image/jpeg" }), "large-synthetic.jpg");
  const result = await s.action("upload", form);
  assert.equal(result.status, 200); s.e = result.body.encounter;
  const source = s.e.sources.find(value => value.kind === "image")!;
  assert.equal(source.mime, "image/png");
  assert.equal(source.originalMime, "image/jpeg");
  assert.equal(source.imagePreparation, "oriented_lossless_png_metadata_stripped");
  assert.ok(source.previewMediaId);
  assert.deepEqual([source.width, source.height], [1800, 1700]);
});

test("API: missing MedGemma key reports MedGemma and never falls back", async () => {
  const previousKey = process.env.MEDGEMMA_API_KEY;
  delete process.env.MEDGEMMA_API_KEY;
  try {
    const s = await session(); await s.upload("image"); const before = providerRequests;
    const result = await s.action("analyze", { encounterId: s.e.id, revision: s.e.revision });
    assert.equal(result.status, 200); s.e = result.body.encounter;
    assert.equal(providerRequests, before);
    assert.equal(s.e.analysis, "failed");
    assert.match(s.e.analysisError, /MedGemma is not configured/);
    assert.doesNotMatch(s.e.analysisError, /OpenAI/);
    assert.match(s.e.analysisWarnings!.join(" "), /no fallback/i);
  } finally {
    if (previousKey === undefined) delete process.env.MEDGEMMA_API_KEY; else process.env.MEDGEMMA_API_KEY = previousKey;
  }
});

test("API: audio-only never invokes MedGemma", async () => {
  const s = await session(); await s.upload("audio"); const before = providerRequests;
  s.e = (await s.action("analyze", { encounterId: s.e.id, revision: s.e.revision })).body.encounter;
  assert.equal(providerRequests, before); assert.equal(s.e.findings[0].origin, "spoken");
});

test("API: audio-only explains a transcription failure instead of reporting generic empty findings", async () => {
  const s = await session(); await s.upload("audio"); failTranscription = true;
  s.e = (await s.action("analyze", { encounterId: s.e.id, revision: s.e.revision })).body.encounter; failTranscription = false;
  assert.equal(s.e.analysis, "failed");
  assert.match(s.e.analysisError, /audio was saved, but transcription failed/i);
  assert.ok(s.e.analysisWarnings!.some(warning => /Audio transcription failed/.test(warning)));
});
