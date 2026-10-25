import { unlink, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { assessImage, imageUploadLimitBytes } from "@/lib/analysis";
import { kickAnalysisWorker } from "@/lib/analysis-jobs";
import { PATIENTS, composeNote, reviewBlockers, type Encounter, type Source } from "@/lib/domain";
import { AppError, auth, changed, checkOrigin, checkRevision, cookieHeader, createSession, dataRoot, digest, mediaPath, respondError, transaction, uid } from "@/lib/store";

import { contextSchema } from "@/lib/image-analysis/contracts";
import { demoEhr, selectedChartContext } from "@/lib/ehr/adapter";

export const runtime = "nodejs";
const safe = (e: Encounter) => ({ ...e, owner: undefined, sources: e.sources.map(({ mediaId, ...source }) => ({ ...source, mediaId: mediaId || undefined })) });
const required = (v: unknown, max = 300) => typeof v === "string" && v.length <= max ? v : "";

export async function GET(request: Request) {
  try {
    void kickAnalysisWorker();
    const data = await transaction(db => {
      const session = auth(db, request);
      return db.encounters.filter(e => e.owner === session.owner).map(safe);
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
    if (action === "delete-encounter") {
      const mediaIds = await transaction(db => {
        auth(db, request, encounterId);

        const encounterIndex = db.encounters.findIndex(item => item.id === encounterId);
        if (encounterIndex < 0) throw new AppError(404, "Encounter not found.");
        const encounter = db.encounters[encounterIndex];
        checkRevision(encounter, body.revision);

        db.encounters.splice(encounterIndex, 1);
        const removedMediaIds = [...new Set(
          encounter.sources.flatMap(source => [source.mediaId, source.previewMediaId]).filter((id): id is string => Boolean(id)),
        )];
        return removedMediaIds.filter(mediaId =>
          !db.encounters.some(item => item.sources.some(source => source.mediaId === mediaId)),
        );
      });

      await Promise.all(mediaIds.map(mediaId =>
        unlink(mediaPath(mediaId)).catch(() => {}),
      ));
      return Response.json({ deleted: true });
    }
    if (action === "create") {
      const patient = PATIENTS.find(p => p.id === body.patientId);
      if (!patient) throw new AppError(400, "Choose a fictional demo patient.");
      const encounter = await transaction(db => {
        const session = auth(db, request);
        const now = new Date().toISOString();
        const e: Encounter = { id: uid(), owner: session.owner, patientId: patient.id, specialty: patient.specialty, createdAt: now, revision: 0, consent: false, patientConfirmed: false, sources: [], findings: [], conflicts: [], analysis: "none", analysisError: "", model: "", promptVersion: "visual-v1", approval: null, export: null, audit: [{ at: now, action: "created", revision: 0 }] };
        db.encounters.push(e); return safe(e);
      });
      return Response.json({ encounter });
    }
    if (action === "remove-image") {
      const result = await transaction(db => {
        auth(db, request, encounterId);
        const encounter = db.encounters.find(item => item.id === encounterId)!;
        checkRevision(encounter, body.revision);

        const sourceIndex = encounter.sources.findIndex(
          source => source.id === body.sourceId && source.kind === "image",
        );
        if (sourceIndex < 0) throw new AppError(404, "Image not found.");

        const [source] = encounter.sources.splice(sourceIndex, 1);
        const removedFindingIds = new Set(
          encounter.findings
            .filter(finding => finding.evidence.some(evidence => evidence.sourceId === source.id))
            .map(finding => finding.id),
        );
        encounter.findings = encounter.findings.filter(finding => !removedFindingIds.has(finding.id));
        encounter.conflicts = encounter.conflicts.filter(
          conflict => conflict.findingIds.every(id => !removedFindingIds.has(id)),
        );
        encounter.imageAnalyses = [];
        encounter.analysisWarnings = [];
        encounter.warningsAcknowledged = false;
        encounter.analysis = "none";
        encounter.analysisError = "";
        encounter.activeAnalysis = undefined;
        changed(encounter, "image removed");

        return { encounter: safe(encounter), mediaIds: [source.mediaId, source.previewMediaId].filter((value): value is string => Boolean(value)) };
      });

      await Promise.all(result.mediaIds.map(mediaId => unlink(mediaPath(mediaId)).catch(() => {})));
      return Response.json({ encounter: result.encounter });
    }

    const encounter = await transaction(db => {
      auth(db, request, encounterId);
      const e = db.encounters.find(v => v.id === encounterId)!;
      checkRevision(e, body.revision);
      if (action === "chart-context") {
        if (!e.consent || !e.patientConfirmed) throw new AppError(400, "Confirm patient and consent before including chart history.");
        e.chartContext = selectedChartContext(db, e, body.selection);
        changed(e, "reviewed chart history updated");
      } else if (action === "context") {
        const context = contextSchema.safeParse(body.context);
        if (!context.success) throw new AppError(400, "Choose a supported specialty/image type and bounded clinical context.");
        e.clinicalContext = context.data; e.specialty = context.data.specialty;
        changed(e, "clinical context updated");
      } else if (action === "acknowledge-warnings") {
        e.warningsAcknowledged = true; changed(e, "analysis limitations acknowledged");
      } else if (action === "confirm") {
        if (typeof body.confirmed !== "boolean" || typeof body.consent !== "boolean") throw new AppError(400, "Confirm identity and consent.");
        e.patientConfirmed = body.confirmed; e.consent = body.consent; changed(e, "confirmation updated");
      } else if (action === "review") {
        const f = e.findings.find(v => v.id === body.findingId);
        if (!f || !["accepted", "rejected", "pending"].includes(body.review)) throw new AppError(400, "Invalid review decision.");
        f.review = body.review; f.text = required(body.text, 500); f.reviewNote = required(body.reviewNote, 500);
        if (!f.text && f.review === "accepted") throw new AppError(400, "An accepted finding needs text.");
        for (const conflict of e.conflicts.filter(c => c.findingIds.includes(f.id))) conflict.resolution = "";
        changed(e, "finding reviewed");
      } else if (action === "manual") {
        const source = e.sources.find(v => v.id === body.sourceId);
        const wording = required(body.text, 500).trim();
        const evidenceQuote = required(body.evidenceQuote, 250).trim();
        if (!source || !wording || !evidenceQuote || !["S", "O", "A", "P"].includes(body.section)) throw new AppError(400, "Provide a section, wording, and an observation linked to an existing source.");
        if (source.kind === "transcript" && !source.text?.includes(evidenceQuote)) throw new AppError(400, "The transcript quote must match the stored source exactly.");
        e.findings.push({ id: uid(), section: body.section, text: wording, originalText: wording, origin: "clinician", certainty: "observed", limitation: "", evidence: [{ sourceId: source.id, quote: evidenceQuote }], review: "pending", reviewNote: "" });
        changed(e, "clinician observation added");
      } else if (action === "resolve") {
        const conflict = e.conflicts.find(c => c.id === body.conflictId);
        if (!conflict) throw new AppError(400, "Conflict not found.");
        conflict.resolution = required(body.resolution, 500); changed(e, "conflict reviewed");
      } else if (action === "approve" || action === "approve-send") {
        const blockers = reviewBlockers(e);
        if (blockers.length) throw new AppError(400, blockers.join(" "));
        const physician = required(body.physician, 100).trim();
        if (physician.length < 3) throw new AppError(400, "Enter the reviewing clinician’s name.");
        const note = composeNote(e);
        if (!e.approval || e.approval.revision !== e.revision || e.approval.digest !== digest(note)) {
          e.approval = { revision: e.revision, physician, at: new Date().toISOString(), note, digest: digest(note) };
          e.audit.push({ at: new Date().toISOString(), action: "approved", revision: e.revision });
        }
        if (action === "approve-send") demoEhr.submitApprovedNote(db, e);
      } else if (action === "export") {
        demoEhr.submitApprovedNote(db, e);
      } else throw new AppError(400, "Unknown action.");
      return { encounter: safe(e) };
    });
    return Response.json(encounter);
  } catch (error) { return respondError(error); }
}

async function upload(request: Request) {
  const contentLength = Number(request.headers.get("content-length"));
  const maximumRequestBytes = Math.max(imageUploadLimitBytes(), 20 * 1024 * 1024) + 1024 * 1024;
  if (Number.isFinite(contentLength) && contentLength > maximumRequestBytes) throw new AppError(413, "The upload request exceeds the configured media limit.");
  const form = await request.formData();
  const id = required(form.get("encounterId"), 32);
  const revision = Number(form.get("revision"));
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError(400, "Select a file.");
  const kind = form.get("kind");
  const image = kind === "image";
  if (!image && kind !== "audio") throw new AppError(400, "Choose audio or image.");
  const uploadLimit = image ? imageUploadLimitBytes() : 20 * 1024 * 1024;
  if (file.size === 0) throw new AppError(400, "The selected file is empty.");
  if (file.size > uploadLimit) throw new AppError(413, `The selected ${image ? "image" : "audio file"} exceeds the configured ${Math.round(uploadLimit / 1024 / 1024)} MB limit.`);
  if (image ? !["image/jpeg", "image/png"].includes(file.type) : !["audio/webm", "audio/mp4", "audio/wav", "audio/mpeg", "audio/ogg"].includes(file.type)) throw new AppError(415, "Unsupported media format.");
  await transaction(db => {
    auth(db, request, id);
    const e = db.encounters.find(v => v.id === id)!;
    checkRevision(e, revision);
    if (!e.consent || !e.patientConfirmed) throw new AppError(400, "Confirm patient and consent before media processing.");
  });
  const original = Buffer.from(await file.arrayBuffer());
  const assessment = image ? await assessImage(original) : null;
  const mediaId = uid(), previewMediaId = image ? uid() : undefined, sourceId = uid();
  const bytes = assessment?.normalized || original;
  const encounter = await transaction(async db => {
    auth(db, request, id);
    const e = db.encounters.find(v => v.id === id)!;
    checkRevision(e, revision);
    if (!e.consent || !e.patientConfirmed) throw new AppError(400, "Confirm the patient and capture consent first.");
    if (!image && e.sources.some(s => s.kind === "audio")) throw new AppError(400, "This demo supports one recording per encounter. Create another encounter to record again.");
    if (e.sources.length >= 8) throw new AppError(400, "This demo supports up to eight sources per encounter.");
    const source: Source = { id: sourceId, kind: image ? "image" : "audio", label: image ? `Photo ${e.sources.filter(s => s.kind === "image").length + 1}` : "Encounter audio", mediaId, previewMediaId, mime: image ? assessment!.mime : file.type, originalMime: image ? file.type : undefined, byteSize: image ? bytes.length : file.size, quality: assessment?.quality, width: assessment?.width, height: assessment?.height, imagePreparation: image ? "oriented_lossless_png_metadata_stripped" : undefined, createdAt: new Date().toISOString() };
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    await writeFile(mediaPath(mediaId), bytes, { flag: "wx", mode: 0o600 });
    if (previewMediaId) await writeFile(mediaPath(previewMediaId), assessment!.preview, { flag: "wx", mode: 0o600 });
    e.sources.push(source); e.findings = []; e.conflicts = []; e.imageAnalyses = []; e.analysisWarnings = []; e.warningsAcknowledged = false; e.activeAnalysis = undefined; e.analysis = "none"; e.analysisError = ""; changed(e, "media added");
    return safe(e);
  });
  return Response.json({ encounter });
}
async function analyze(request: Request) {
  const body = await request.json();
  const id = required(body.encounterId, 32);
  const runId = uid();
  const encounter = await transaction(db => {
    auth(db, request, id);
    const e = db.encounters.find(v => v.id === id)!;
    checkRevision(e, body.revision);
    if (!e.consent || !e.patientConfirmed || !e.sources.some(s => ["image", "audio", "transcript"].includes(s.kind))) throw new AppError(400, "Confirm patient and consent, then capture media.");
    if (e.analysis === "running" && e.activeAnalysis?.expiresAt && e.activeAnalysis.expiresAt > Date.now()) throw new AppError(409, "Analysis is already queued or processing.");
    if (e.analysis === "running") {
      e.analysis = "failed";
      e.activeAnalysis = undefined;
      e.analysisError = "The previous analysis expired before completion.";
    }
    e.analysis = "running"; e.analysisError = "";
    e.activeAnalysis = { id: runId, status: "queued", queuedAt: new Date().toISOString(), attempts: 0, expiresAt: Date.now() + 2 * 60 * 60 * 1000 };
    changed(e, "analysis started");
    return safe(e);
  });
  void kickAnalysisWorker();
  return Response.json({ encounter }, { status: 202 });
}
