import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { assessImage, suggest, transcribe } from "@/lib/analysis";
import { PATIENTS, composeNote, reviewBlockers, type Encounter, type Finding, type Source } from "@/lib/domain";
import { AppError, auth, changed, checkOrigin, checkRevision, cookieHeader, createSession, dataRoot, digest, mediaPath, respondError, transaction, uid } from "@/lib/store";

export const runtime = "nodejs";
const safe = (e: Encounter) => ({ ...e, owner: undefined, sources: e.sources.map(({ mediaId, ...source }) => ({ ...source, mediaId: mediaId || undefined })) });
const required = (v: unknown, max = 300) => typeof v === "string" && v.length <= max ? v : "";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const pair = url.searchParams.get("pair");
    if (pair) {
      const result = await transaction(db => {
        const p = db.pairings.find(v => v.hash === digest(pair) && !v.used && v.expires > Date.now());
        if (!p) throw new AppError(410, "The QR link expired or was already used. Generate a new one.");
        const e = db.encounters.find(v => v.id === p.encounterId);
        if (!e) throw new AppError(404, "Encounter not found.");
        p.used = true;
        return { encounter: safe(e), session: createSession(db, e.owner, e.id) };
      });
      const res = Response.json({ encounter: result.encounter });
      res.headers.set("Set-Cookie", cookieHeader(result.session, request));
      res.headers.set("Cache-Control", "no-store");
      return res;
    }
    const data = await transaction(db => {
      const session = auth(db, request);
      return db.encounters.filter(e => session.encounterId ? e.id === session.encounterId : e.owner === session.owner).map(safe);
    });
    return Response.json({ encounters: data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return respondError(error); }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const action = new URL(request.url).searchParams.get("action");
    if (action === "bootstrap") {
      const owner = uid();
      const session = await transaction(db => createSession(db, owner));
      const res = Response.json({ encounters: [] });
      res.headers.set("Set-Cookie", cookieHeader(session, request));
      return res;
    }
    if (action === "upload") return await upload(request);
    if (action === "analyze") return await analyze(request);
    const body = await request.json();
    const encounterId = required(body.encounterId, 32);
    if (action === "create") {
      const patient = PATIENTS.find(p => p.id === body.patientId);
      if (!patient) throw new AppError(400, "Choose a fictional demo patient.");
      const encounter = await transaction(db => {
        const session = auth(db, request);
        if (session.encounterId) throw new AppError(403, "QR sessions cannot create encounters.");
        const now = new Date().toISOString();
        const e: Encounter = { id: uid(), owner: session.owner, patientId: patient.id, specialty: patient.specialty, createdAt: now, revision: 0, consent: false, patientConfirmed: false, sources: [], findings: [], conflicts: [], analysis: "none", analysisError: "", model: "", promptVersion: "visual-v1", approval: null, export: null, audit: [{ at: now, action: "created", revision: 0 }] };
        db.encounters.push(e); return safe(e);
      });
      return Response.json({ encounter });
    }
    const encounter = await transaction(db => {
      auth(db, request, encounterId);
      const e = db.encounters.find(v => v.id === encounterId)!;
      checkRevision(e, body.revision);
      if (action === "confirm") {
        if (typeof body.confirmed !== "boolean" || typeof body.consent !== "boolean") throw new AppError(400, "Confirm identity and consent.");
        e.patientConfirmed = body.confirmed; e.consent = body.consent; changed(e, "confirmation updated");
      } else if (action === "pair") {
        const token = randomBytes(24).toString("base64url");
        db.pairings.push({ hash: digest(token), encounterId: e.id, expires: Date.now() + 5 * 60 * 1000, used: false });
        return { encounter: safe(e), token };
      } else if (action === "review") {
        const f = e.findings.find(v => v.id === body.findingId);
        if (!f || !["accepted", "rejected", "pending"].includes(body.review)) throw new AppError(400, "Invalid review decision.");
        f.review = body.review; f.text = required(body.text, 500); f.reviewNote = required(body.reviewNote, 500);
        if (!f.text && f.review === "accepted") throw new AppError(400, "An accepted finding needs text.");
        changed(e, "finding reviewed");
      } else if (action === "manual") {
        const source = e.sources.find(v => v.id === body.sourceId);
        const wording = required(body.text, 500).trim();
        const evidenceQuote = required(body.evidenceQuote, 250).trim();
        if (!source || !wording || !evidenceQuote || !["S", "O", "A", "P"].includes(body.section)) throw new AppError(400, "Provide a section, wording, and an observation linked to an existing source.");
        e.findings.push({ id: uid(), section: body.section, text: wording, originalText: wording, origin: "clinician", certainty: "observed", limitation: "", evidence: [{ sourceId: source.id, quote: evidenceQuote }], review: "pending", reviewNote: "" });
        changed(e, "clinician observation added");
      } else if (action === "resolve") {
        const conflict = e.conflicts.find(c => c.id === body.conflictId);
        if (!conflict) throw new AppError(400, "Conflict not found.");
        conflict.resolution = required(body.resolution, 500); changed(e, "conflict reviewed");
      } else if (action === "approve") {
        const blockers = reviewBlockers(e);
        if (blockers.length) throw new AppError(400, blockers.join(" "));
        const physician = required(body.physician, 100).trim();
        if (physician.length < 3) throw new AppError(400, "Enter the reviewing clinician’s name.");
        const note = composeNote(e);
        e.approval = { revision: e.revision, physician, at: new Date().toISOString(), note, digest: digest(note) };
        e.audit.push({ at: new Date().toISOString(), action: "approved", revision: e.revision });
      } else if (action === "export") {
        if (!e.approval || e.approval.revision !== e.revision || digest(composeNote(e)) !== e.approval.digest) throw new AppError(400, "Review and approve the current draft first.");
        if (!e.export) { e.export = { id: uid(), at: new Date().toISOString(), revision: e.revision, mode: "simulation" }; e.audit.push({ at: new Date().toISOString(), action: "simulated EHR export", revision: e.revision }); }
      } else throw new AppError(400, "Unknown action.");
      return { encounter: safe(e) };
    });
    return Response.json(encounter);
  } catch (error) { return respondError(error); }
}

async function upload(request: Request) {
  const form = await request.formData();
  const id = required(form.get("encounterId"), 32);
  const revision = Number(form.get("revision"));
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError(400, "Select a file.");
  const kind = form.get("kind");
  const image = kind === "image";
  if (!image && kind !== "audio") throw new AppError(400, "Choose audio or image.");
  if (file.size === 0 || file.size > (image ? 10 : 20) * 1024 * 1024) throw new AppError(413, "File is empty or exceeds the demo size limit.");
  if (image ? !["image/jpeg", "image/png"].includes(file.type) : !["audio/webm", "audio/mp4", "audio/wav", "audio/mpeg", "audio/ogg"].includes(file.type)) throw new AppError(415, "Unsupported media format.");
  const original = Buffer.from(await file.arrayBuffer());
  const assessment = image ? await assessImage(original) : null;
  const mediaId = uid(), sourceId = uid();
  const bytes = assessment?.normalized || original;
  const encounter = await transaction(async db => {
    auth(db, request, id);
    const e = db.encounters.find(v => v.id === id)!;
    checkRevision(e, revision);
    if (!e.consent || !e.patientConfirmed) throw new AppError(400, "Confirm the patient and capture consent first.");
    if (!image && e.sources.some(s => s.kind === "audio")) throw new AppError(400, "This demo supports one recording per encounter. Create another encounter to record again.");
    if (e.sources.length >= 8) throw new AppError(400, "This demo supports up to eight sources per encounter.");
    const source: Source = { id: sourceId, kind: image ? "image" : "audio", label: image ? `Photo ${e.sources.filter(s => s.kind === "image").length + 1}` : "Encounter audio", mediaId, mime: image ? "image/jpeg" : file.type, quality: assessment?.quality, width: assessment?.width, height: assessment?.height, createdAt: new Date().toISOString() };
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    await writeFile(mediaPath(mediaId), bytes, { flag: "wx", mode: 0o600 });
    e.sources.push(source); e.findings = []; e.conflicts = []; e.analysis = "none"; e.analysisError = ""; changed(e, "media added");
    return safe(e);
  });
  return Response.json({ encounter });
}
async function analyze(request: Request) {
  const body = await request.json();
  const id = required(body.encounterId, 32);
  const snapshot = await transaction(db => {
    auth(db, request, id);
    const e = db.encounters.find(v => v.id === id)!;
    checkRevision(e, body.revision);
    if (!e.consent || !e.patientConfirmed || !e.sources.some(s => s.kind === "image" || s.kind === "audio")) throw new AppError(400, "Confirm patient and consent, then capture media.");
    if (e.analysis === "running") throw new AppError(409, "Analysis is already running.");
    e.analysis = "running"; e.analysisError = ""; changed(e, "analysis started"); return structuredClone(e);
  });
  try {
    const audio = snapshot.sources.find(s => s.kind === "audio");
    const images = snapshot.sources.filter(s => s.kind === "image");
    const transcript = audio ? { id: uid(), text: await transcribe(await readFile(mediaPath(audio.mediaId!)), audio.mime || "audio/webm") } : null;
    const suggestions = await suggest(await Promise.all(images.map(async s => ({ id: s.id, quality: s.quality!, bytes: await readFile(mediaPath(s.mediaId!)) }))), transcript, snapshot.specialty);
    const encounter = await transaction(db => {
      auth(db, request, id);
      const e = db.encounters.find(v => v.id === id)!;
      checkRevision(e, snapshot.revision);
      if (transcript) e.sources.push({ id: transcript.id, kind: "transcript", label: "Unverified transcript", text: transcript.text, createdAt: new Date().toISOString(), mediaId: audio?.mediaId });
      const sources = new Map(e.sources.map(s => [s.id, s]));
      e.findings = suggestions.map((s): Finding => ({ id: uid(), section: s.section, text: s.text, originalText: s.text, origin: s.sourceIds.some(v => sources.get(v)?.kind === "image") ? "visual" : "spoken", certainty: s.certainty, limitation: s.limitation, evidence: s.sourceIds.map((sourceId, i) => ({ sourceId, quote: s.evidenceQuotes[i] })), review: "pending", reviewNote: "" }));
      e.conflicts = [];
      for (const visual of e.findings.filter(f => f.origin === "visual")) for (const spoken of e.findings.filter(f => f.origin === "spoken")) {
        if (visual.text.toLowerCase().includes("left") && spoken.text.toLowerCase().includes("right") || visual.text.toLowerCase().includes("right") && spoken.text.toLowerCase().includes("left")) e.conflicts.push({ id: uid(), findingIds: [visual.id, spoken.id], description: "Possible left/right discrepancy between image and spoken statement. Verify orientation and patient details.", resolution: "" });
      }
      e.analysis = "ready"; e.model = "gpt-transcribe + gpt-4o"; changed(e, "analysis completed"); return safe(e);
    });
    return Response.json({ encounter });
  } catch (error) {
    await transaction(db => { const e = db.encounters.find(v => v.id === id); if (e && e.analysis === "running" && e.revision === snapshot.revision) { e.analysis = "failed"; e.analysisError = error instanceof AppError ? error.message : "Analysis failed. Retry with fictional data."; changed(e, "analysis failed"); } });
    return respondError(error);
  }
}
