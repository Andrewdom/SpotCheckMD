import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { assessImage, suggest } from "@/lib/analysis";
import { PATIENTS, composeNote, reviewBlockers, type Encounter, type Source } from "@/lib/domain";
import { AppError, auth, changed, checkOrigin, checkRevision, cookieHeader, createSession, dataRoot, digest, mediaPath, respondError, transaction, uid } from "@/lib/store";

import { contextSchema, PROMPT_VERSION } from "@/lib/image-analysis/contracts";
import { configuredImageProvider } from "@/lib/image-analysis/providers";
import { analyzeEncounter } from "@/lib/image-analysis/pipeline";
import { demoEhr, selectedChartContext } from "@/lib/ehr/adapter";
import { configuredTranscriptionProvider, transcriptionModel } from "@/lib/transcription/providers";
import { extractiveSubjectiveFindings, soapDocumentationMode } from "@/lib/transcription/soap";

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
      } else if (action === "pair") {
        const token = randomBytes(24).toString("base64url");
        db.pairings.push({ hash: digest(token), encounterId: e.id, expires: Date.now() + 5 * 60 * 1000, used: false });
        return { encounter: safe(e), token };
      } else if (action === "review") {
        const f = e.findings.find(v => v.id === body.findingId);
        if (!f || !["accepted", "rejected", "pending"].includes(body.review)) throw new AppError(400, "Invalid review decision.");
        f.review = body.review; f.text = required(body.text, 500); f.reviewNote = required(body.reviewNote, 500);
        if (!f.text && f.review === "accepted") throw new AppError(400, "An accepted finding needs text.");
        for (const conflict of e.conflicts.filter(c => c.findingIds.includes(f.id))) conflict.resolution = "";
        changed(e, "finding reviewed");
      } else if (action === "transcript-roles") {
        const artifactId = required(body.artifactId, 64);
        const patientSpeaker = required(body.patientSpeaker, 30);
        const clinicianSpeaker = required(body.clinicianSpeaker, 30);
        const artifact = e.transcripts?.find(item => item.id === artifactId);
        const speakers = new Set(artifact?.utterances.map(utterance => utterance.speaker).filter(speaker => speaker !== "UNKNOWN") || []);
        if (!artifact || !patientSpeaker || !clinicianSpeaker || patientSpeaker === clinicianSpeaker || !speakers.has(patientSpeaker) || !speakers.has(clinicianSpeaker)) throw new AppError(400, "Choose distinct patient and clinician speakers from this transcript.");
        e.transcriptRoles = { artifactId, patientSpeaker, clinicianSpeaker, confirmedAt: new Date().toISOString() };
        if (soapDocumentationMode() === "extractive") replaceExtractiveFindings(e, artifact, patientSpeaker, e.transcriptRoles);
        changed(e, "transcript speaker roles confirmed");
      } else if (action === "transcript-extractive") {
        if (soapDocumentationMode() !== "extractive") throw new AppError(409, "Local extractive SOAP mode is not selected.");
        const artifactId = required(body.artifactId, 64);
        const patientSpeaker = required(body.patientSpeaker, 30);
        const artifact = e.transcripts?.find(item => item.id === artifactId);
        if (!artifact) throw new AppError(404, "Transcript artifact not found.");
        replaceExtractiveFindings(e, artifact, patientSpeaker);
        changed(e, "local extractive Subjective findings created");
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
  await transaction(db => {
    auth(db, request, id);
    const e = db.encounters.find(v => v.id === id)!;
    checkRevision(e, revision);
    if (!e.consent || !e.patientConfirmed) throw new AppError(400, "Confirm patient and consent before media processing.");
  });
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
    e.sources.push(source); e.findings = []; e.conflicts = []; e.imageAnalyses = []; e.analysisWarnings = []; e.warningsAcknowledged = false; e.activeAnalysis = undefined; e.analysis = "none"; e.analysisError = ""; changed(e, "media added");
    return safe(e);
  });
  return Response.json({ encounter });
}
async function analyze(request: Request) {
  const body = await request.json();
  const id = required(body.encounterId, 32);
  const runId = uid();
  const snapshot = await transaction(db => {
    auth(db, request, id);
    const e = db.encounters.find(v => v.id === id)!;
    checkRevision(e, body.revision);
    if (!e.consent || !e.patientConfirmed || !e.sources.some(s => ["image", "audio", "transcript"].includes(s.kind))) throw new AppError(400, "Confirm patient and consent, then capture media.");
    if (e.analysis === "running" && e.activeAnalysis && e.activeAnalysis.expiresAt > Date.now()) throw new AppError(409, "Analysis is already running.");
    e.analysis = "running"; e.analysisError = "";
    e.activeAnalysis = { id: runId, expiresAt: Date.now() + 30 * 60 * 1000 };
    changed(e, "analysis started");
    return structuredClone(e);
  });
  const ensureCurrent = () => transaction(db => {
    auth(db, request, id);
    const e = db.encounters.find(v => v.id === id)!;
    checkRevision(e, snapshot.revision);
    if (!e.consent || !e.patientConfirmed || e.activeAnalysis?.id !== runId || e.activeAnalysis.expiresAt <= Date.now()) throw new AppError(409, "Analysis was cancelled or expired. Review the current encounter and retry.");
  });
  try {
    const result = await analyzeEncounter(snapshot, runId, {
      provider: configuredImageProvider, transcriber: configuredTranscriptionProvider,
      document: soapDocumentationMode() === "extractive" ? async () => [] : (transcript, specialty) => suggest([], transcript, specialty),
      readMedia: source => readFile(mediaPath(source.mediaId!)), ensureCurrent,
    });
    await ensureCurrent();
    const encounter = await transaction(db => {
      auth(db, request, id);
      const e = db.encounters.find(v => v.id === id)!;
      checkRevision(e, snapshot.revision);
      if (e.activeAnalysis?.id !== runId || !e.consent || !e.patientConfirmed) throw new AppError(409, "Analysis superseded.");
      e.sources.push(...result.newSources);
      e.transcripts = [...(e.transcripts || []), ...result.newTranscripts];
      // Preserve clinician edits and prior decisions when retrying; replace only pending AI proposals.
      const retained = e.findings.filter(f => f.origin === "clinician" || f.review !== "pending");
      const retainedIds = new Set(retained.map(f => f.id));
      e.findings = [...retained, ...result.findings];
      e.conflicts = [...e.conflicts.filter(c => c.findingIds.every(id => retainedIds.has(id))), ...result.conflicts];
      e.imageAnalyses = [...(e.imageAnalyses || []), ...result.analyses];
      e.analysisWarnings = result.warnings; e.warningsAcknowledged = false;
      e.analysis = result.findings.length || result.analyses.length ? "ready" : "failed";
      const hasTranscript = e.sources.some(source => source.kind === "transcript");
      const transcriptionFailed = result.warnings.some(warning => warning.startsWith("Audio transcription failed."));
      e.analysisError = e.analysis !== "failed" ? ""
        : hasTranscript && soapDocumentationMode() === "extractive" ? "The finalized transcript is available. Confirm the patient and clinician speakers to create free local extractive Subjective findings."
          : hasTranscript ? "The finalized transcript is available, but SOAP suggestions were not generated. Check the OpenAI SOAP-extraction configuration or add a clinician observation."
          : transcriptionFailed ? "The audio was saved, but transcription failed. Check the selected transcription provider and its server-side API key, then retry."
            : "No new findings were generated. Review analysis warnings or add a supported manual observation.";
      e.activeAnalysis = undefined;
      e.model = [...new Set([...result.analyses.map(a => a.model), ...(e.transcripts || []).map(transcriptionModel), ...(result.findings.some(f => f.origin === "spoken") ? ["gpt-4o (transcript documentation)"] : [])].filter(Boolean))].join(" + ");
      e.promptVersion = PROMPT_VERSION;
      changed(e, "analysis completed"); return safe(e);
    });
    return Response.json({ encounter });
  } catch (error) {
    await transaction(db => {
      const e = db.encounters.find(v => v.id === id);
      if (e?.activeAnalysis?.id === runId) {
        e.analysis = "failed"; e.activeAnalysis = undefined;
        e.analysisError = "Analysis failed or expired. Retry with authorized demonstration inputs.";
        changed(e, "analysis failed");
      }
    });
    return respondError(error);
  }
}

function replaceExtractiveFindings(encounter: Encounter, artifact: NonNullable<Encounter["transcripts"]>[number], patientSpeaker: string, roles?: NonNullable<Encounter["transcriptRoles"]>) {
  const replacedIds = new Set(encounter.findings.filter(finding => finding.review === "pending" && finding.provider === "local-extractive-transcript" && finding.evidence.some(evidence => evidence.transcript?.artifactId === artifact.id)).map(finding => finding.id));
  encounter.findings = encounter.findings.filter(finding => !replacedIds.has(finding.id));
  encounter.conflicts = encounter.conflicts.filter(conflict => conflict.findingIds.every(id => !replacedIds.has(id)));
  const generated = extractiveSubjectiveFindings(artifact, patientSpeaker, roles);
  if (!generated.length) throw new AppError(400, "The selected speaker has no extractable transcript statements.");
  encounter.findings.push(...generated);
  encounter.analysis = "ready";
  encounter.analysisError = "";
  encounter.model = [...new Set([encounter.model, "local:extractive-soap-v1"].filter(Boolean))].join(" + ");
}
