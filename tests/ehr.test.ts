import test, { before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { composeNote, type Encounter } from "../lib/domain";
import type { PatientChart } from "../lib/ehr/types";
import { encounter as fixtureEncounter, image, analysis } from "./fixtures";

let api: typeof import("../app/api/demo/route");
let ehr: typeof import("../app/api/ehr/route");
let store: typeof import("../lib/store");
let directory: string;
const origin = "http://localhost:3107";
before(async () => {
  directory = await fs.mkdtemp(path.join(tmpdir(), "spotcheckmd-ehr-tests-"));
  process.env.AURA_DATA_DIR = directory;
  process.env.OPENAI_API_KEY = "";
  api = await import("../app/api/demo/route");
  ehr = await import("../app/api/ehr/route");
  store = await import("../lib/store");
});
after(async () => { await fs.rm(directory, { recursive: true, force: true }); });

async function session() {
  let cookie = "";
  async function action(name: string, data: Record<string, unknown> | FormData, customCookie = cookie) {
    const response = await api.POST(new Request(`${origin}/api/demo?action=${name}`, {
      method: "POST", headers: { Origin: origin, Cookie: customCookie, ...(data instanceof FormData ? {} : { "Content-Type": "application/json" }) },
      body: data instanceof FormData ? data : JSON.stringify(data),
    }));
    if (response.headers.has("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0];
    return { status: response.status, body: await response.json() };
  }
  await action("bootstrap", {});
  let encounter = (await action("create", { patientId: "demo-001" })).body.encounter as Encounter;
  return {
    action, get e() { return encounter; }, get cookie() { return cookie; },
    async change(name: string, payload: Record<string, unknown> = {}) {
      const result = await action(name, { encounterId: encounter.id, revision: encounter.revision, ...payload });
      if (result.body.encounter) encounter = result.body.encounter;
      return result;
    },
    async chart(patientId = encounter.patientId, auth = cookie) {
      const response = await ehr.GET(new Request(`${origin}/api/ehr?patientId=${patientId}`, { headers: { Cookie: auth } }));
      return { status: response.status, cache: response.headers.get("cache-control"), chart: (await response.json()).chart as PatientChart };
    },
    async reload() {
      const response = await api.GET(new Request(`${origin}/api/demo`, { headers: { Cookie: cookie } }));
      encounter = (await response.json()).encounters.find((e: Encounter) => e.id === encounter.id);
    },
    async prepare() {
      await this.change("confirm", { confirmed: true, consent: true });
      const image = await sharp({ create: { width: 800, height: 800, channels: 3, background: "#887766" } }).jpeg().toBuffer();
      const form = new FormData(); form.set("encounterId", encounter.id); form.set("revision", String(encounter.revision)); form.set("kind", "image"); form.set("file", new Blob([new Uint8Array(image)], { type: "image/jpeg" }), "synthetic.jpg");
      encounter = (await action("upload", form)).body.encounter;
      await this.change("manual", { section: "O", sourceId: encounter.sources[0].id, text: "Staged color field is visible.", evidenceQuote: "Central field of the synthetic image" });
      await this.change("review", { findingId: encounter.findings[0].id, text: encounter.findings[0].text, review: "accepted", reviewNote: "Reviewed synthetic image and its limitations." });
    },
  };
}

test("EHR: legacy storage loads, chart reads require a session, and missing history stays unknown", async () => {
  const s = await session();
  assert.equal((await s.chart("demo-001", "")).status, 401);
  const result = await s.chart();
  assert.equal(result.status, 200); assert.equal(result.cache, "no-store");
  assert.equal(result.chart.patient.mrn, "DEMO-001");
  const jordan = (await s.chart("demo-002")).chart;
  assert.equal(jordan.patient.allergyStatus, "unknown");
  assert.equal(jordan.records.filter(r => r.category === "allergy").length, 0);
  assert.equal((await s.chart("not-a-patient")).status, 404);
});

test("EHR: approved snapshot persists, reload reads it, and concurrent retry does not duplicate it", async () => {
  const s = await session(); await s.prepare();
  const chart = (await s.chart()).chart;
  assert.equal((await s.change("chart-context", { selection: { chartVersion: chart.version, items: [{ id: "alex-medication-1", confirmedToday: false }] } })).status, 200);
  const expected = composeNote(s.e);
  const results = await Promise.all([s.change("approve-send", { physician: "Dr Demo" }), s.change("approve-send", { physician: "Dr Demo" })]);
  assert.ok(results.every(r => r.status === 200));
  assert.equal(results[0].body.encounter.export.id, results[1].body.encounter.export.id);
  await s.reload();
  assert.equal(s.e.ehrReceipts?.length, 1);
  const refreshed = (await s.chart()).chart;
  assert.equal(refreshed.notes.length, 1); assert.equal(refreshed.notes[0].text, expected);
  assert.equal(refreshed.notes[0].digest, s.e.approval?.digest);
  assert.match(expected, /Historical chart entry; not confirmed/);
  assert.match(expected, /recorded 2026-04-14/);
  const later = await s.action("create", { patientId: "demo-001" });
  assert.notEqual(later.body.encounter.id, s.e.id);
  assert.equal((await s.chart()).chart.notes[0].id, s.e.export?.id);
});

test("EHR: workspace isolation and paired-session patient boundaries", async () => {
  const first = await session(); await first.prepare(); await first.change("approve-send", { physician: "Dr Demo" });
  const other = await session();
  assert.equal((await other.chart()).chart.notes.length, 0);
  assert.equal((await other.action("export", { encounterId: first.e.id, revision: first.e.revision })).status, 404);
  const pairing = await first.change("pair");
  const response = await api.GET(new Request(`${origin}/api/demo?pair=${pairing.body.token}`));
  const pairedCookie = response.headers.get("set-cookie")!.split(";")[0];
  assert.equal((await first.chart("demo-001", pairedCookie)).status, 200);
  assert.equal((await first.chart("demo-002", pairedCookie)).status, 404);
  assert.equal((await first.chart("demo-002")).chart.notes.length, 0);
});

test("EHR: history selection validates consent, patient ownership, chart version and exact server content", async () => {
  const s = await session(); const chart = (await s.chart()).chart;
  const selection = { chartVersion: chart.version, items: [{ id: "alex-vital-1", confirmedToday: false }] };
  assert.equal((await s.change("chart-context", { selection })).status, 400);
  await s.prepare();
  assert.equal((await s.change("chart-context", { selection: { ...selection, items: [{ id: "jordan-medication-1", confirmedToday: true }] } })).status, 400);
  assert.equal((await s.change("chart-context", { selection: { ...selection, chartVersion: 999 } })).status, 409);
  assert.equal((await s.change("chart-context", { selection: { ...selection, items: [{ ...selection.items[0], text: "Invented" }] } })).status, 400);
  assert.equal((await s.change("chart-context", { selection })).status, 200);
  assert.equal(s.e.chartContext!.items[0].text, chart.records.find(r => r.id === "alex-vital-1")!.text);
  assert.match(composeNote(s.e), /Historical measurement/);
  assert.equal(s.e.sources.filter(source => source.kind === "transcript").length, 0);
  await s.change("approve-send", { physician: "Dr Demo" });
  assert.equal((await s.change("chart-context", { selection })).status, 409);
  const fresh = (await s.chart()).chart;
  assert.equal((await s.change("chart-context", { selection: { chartVersion: fresh.version, items: [{ id: s.e.export!.id, confirmedToday: false }] } })).status, 400);
});

test("EHR: edits revoke approval, preserve the saved original, and create a linked amendment", async () => {
  const s = await session(); await s.prepare(); await s.change("approve-send", { physician: "Dr Demo" });
  const original = (await s.chart()).chart.notes[0];
  await s.change("review", { findingId: s.e.findings[0].id, text: "Clinician revised staged image description.", review: "accepted", reviewNote: "Corrected the fictional description." });
  assert.equal(s.e.approval, null); assert.equal(s.e.export, null); assert.equal(s.e.ehrReceipts?.length, 1);
  assert.equal((await s.change("export")).status, 400);
  assert.deepEqual((await s.chart()).chart.notes[0], original);
  await s.change("approve-send", { physician: "Dr Demo" });
  const notes = (await s.chart()).chart.notes;
  assert.equal(notes.length, 2); assert.equal(notes[1].amendsId, original.id);
  assert.equal(notes[1].text, composeNote(s.e)); assert.deepEqual(notes[0], original);
  const chart = (await s.chart()).chart;
  await s.change("chart-context", { selection: { chartVersion: chart.version, items: [{ id: "alex-history-1", confirmedToday: true }] } });
  assert.equal(s.e.approval, null); assert.equal(s.e.export, null);
  assert.equal(s.e.ehrReceipts?.length, 2);
});

test("EHR: pending findings, revoked consent and tampered approval cannot write a note", async () => {
  const s = await session();
  assert.equal((await s.change("approve-send", { physician: "Dr Demo" })).status, 400);
  await s.prepare();
  await s.change("review", { findingId: s.e.findings[0].id, text: s.e.findings[0].text, review: "pending", reviewNote: "" });
  assert.equal((await s.change("approve-send", { physician: "Dr Demo" })).status, 400);
  await s.change("review", { findingId: s.e.findings[0].id, text: s.e.findings[0].text, review: "accepted", reviewNote: "Reviewed limitations." });
  await s.change("approve", { physician: "Dr Demo" });
  await store.transaction(db => { db.encounters.find(e => e.id === s.e.id)!.approval!.note = "Tampered snapshot"; });
  assert.equal((await s.change("export")).status, 400);
  await s.change("confirm", { confirmed: true, consent: false });
  assert.equal((await s.change("approve-send", { physician: "Dr Demo" })).status, 400);
  assert.equal((await s.chart()).chart.notes.length, 0);
});

test("EHR: storage failure commits neither approval nor note; retry saves once", async () => {
  const s = await session(); await s.prepare(); await s.chart();
  const failing = mock.method(fs, "rename", async () => { throw new Error("Synthetic storage failure"); });
  syncBuiltinESMExports();
  try { assert.equal((await s.change("approve-send", { physician: "Dr Demo" })).status, 500); }
  finally { failing.mock.restore(); syncBuiltinESMExports(); }
  await s.reload(); assert.equal(s.e.approval, null); assert.equal(s.e.export, null);
  assert.equal((await s.chart()).chart.notes.length, 0);
  assert.equal((await s.change("approve-send", { physician: "Dr Demo" })).status, 200);
  await s.change("export");
  assert.equal((await s.chart()).chart.notes.length, 1);
});

test("EHR: selected history stays outside MedGemma inputs and runtime provenance survives submission", async () => {
  const { analyzeEncounter } = await import("../lib/image-analysis/pipeline");
  const s = await session(); await s.prepare();
  const snapshot = fixtureEncounter([image]);
  snapshot.chartContext = { version: 1, patientId: snapshot.patientId, chartVersion: 1, importedAt: new Date().toISOString(), items: [{ id: "prior-medication", category: "medication", title: "Private historical context", text: "CHART_CONTEXT_SENTINEL", recordedAt: "2026-04-14", source: "Demo EHR", status: "Historical", confirmedToday: false }] };
  const runtime = { engine: "llama.cpp" as const, engineRevision: "a".repeat(40), converterRevision: "b".repeat(40), quantization: "Q4_K_M" as const, modelSha256: "c".repeat(64), projectorSha256: "d".repeat(64) };
  const result = await analyzeEncounter(snapshot, "mock-run", {
    provider: () => ({ id: "medgemma", async analyze(input) {
      assert.equal(input.transcript, null); assert.ok(!JSON.stringify(input).includes("CHART_CONTEXT_SENTINEL"));
      return { analysis: analysis(input), model: "google/medgemma-1.5-4b-it", modelRevision: "mock-revision", latencyMs: 1, contextRange: null, runtime };
    } }),
    transcribe: async () => { throw new Error("Unexpected transcription"); },
    document: async () => { throw new Error("Unexpected documentation"); }, readMedia: async () => Buffer.from("synthetic"),
  });
  await store.transaction(db => {
    const e = db.encounters.find(e => e.id === s.e.id)!;
    e.model = "google/medgemma-1.5-4b-it"; e.promptVersion = "contextual-image-v1"; e.imageAnalyses = result.analyses;
  });
  await s.reload(); await s.change("approve-send", { physician: "Dr Demo" });
  const note = (await s.chart()).chart.notes[0];
  assert.equal(note.provenance?.model, "google/medgemma-1.5-4b-it");
  assert.deepEqual(note.provenance?.imageRuns[0].runtime, runtime);
});
