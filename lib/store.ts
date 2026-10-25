import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Encounter } from "./domain";
import type { StoredChart } from "./ehr/types";
import { sql } from "./database";

export const dataRoot = process.env.AURA_DATA_DIR || path.join(process.cwd(), ".aura-data");
type Session = { id: string; owner: string; organizationId?: string; expires: number };
export type Database = { encounters: Encounter[]; sessions: Session[]; ehrCharts?: StoredChart[]; pairings?: unknown[] };
const globalStore = globalThis as unknown as { auraLock?: Promise<unknown> };
export const uid = () => randomBytes(16).toString("hex");
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const tokenHash = (value: string) => digest(value);

async function legacyTransaction<T>(fn: (db: Database) => T | Promise<T>): Promise<T> {
  const work = (globalStore.auraLock || Promise.resolve()).then(async () => {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    let db: Database;
    try { db = JSON.parse(await readFile(path.join(dataRoot, "db.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; db = { encounters: [], sessions: [] }; }
    db.sessions = db.sessions.filter(s => s.expires > Date.now());
    delete db.pairings;
    db.sessions = db.sessions.filter(session => !(session as Session & { encounterId?: string | null }).encounterId);
    const result = await fn(db);
    const temp = path.join(dataRoot, `db-${uid()}.tmp`);
    await writeFile(temp, JSON.stringify(db), { mode: 0o600 });
    await rename(temp, path.join(dataRoot, "db.json"));
    return structuredClone(result);
  });
  globalStore.auraLock = work.catch(() => {});
  return work;
}

async function postgresTransaction<T>(fn: (db: Database) => T | Promise<T>): Promise<T> {
  const persisted = await sql().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(73924011)`;
    const [encounterRows, sessionRows, chartRows, jobRows] = await Promise.all([
      tx<{ document: Encounter; physician_id: string }[]>`SELECT document, physician_id FROM encounters ORDER BY created_at`,
      tx<{ token_hash: string; physician_id: string; organization_id: string; expires_ms: number }[]>`
        SELECT token_hash, physician_id, organization_id, (extract(epoch FROM expires_at) * 1000)::bigint::float8 AS expires_ms
        FROM physician_sessions WHERE revoked_at IS NULL AND expires_at > now()
      `,
      tx<{ document: StoredChart; physician_id: string }[]>`SELECT document, physician_id FROM ehr_charts`,
      tx<{ run_id: string; encounter_id: string }[]>`SELECT run_id, encounter_id FROM analysis_jobs WHERE status IN ('queued','running')`,
    ]);
    const db: Database = {
      encounters: encounterRows.map(row => ({ ...row.document, owner: row.physician_id })),
      sessions: sessionRows.map(row => ({ id: row.token_hash.trim(), owner: row.physician_id, organizationId: row.organization_id, expires: Number(row.expires_ms) })),
      ehrCharts: chartRows.map(row => ({ ...row.document, owner: row.physician_id })),
    };
    const before = JSON.stringify(db);
    const result = await fn(db);
    if (JSON.stringify(db) === before) return structuredClone(result);

    await tx`DELETE FROM physician_sessions WHERE expires_at <= now()`;
    for (const session of db.sessions.filter(item => item.expires > Date.now() && item.organizationId)) {
      await tx`
        INSERT INTO physician_sessions (token_hash, physician_id, organization_id, expires_at)
        VALUES (${session.id}, ${session.owner}, ${session.organizationId!}, ${new Date(session.expires)})
        ON CONFLICT (token_hash) DO NOTHING
      `;
    }

    const ids = db.encounters.map(item => item.id);
    if (ids.length) await tx`DELETE FROM encounters WHERE id NOT IN ${tx(ids)}`;
    else await tx`DELETE FROM encounters`;
    const memberships = await tx<{ physician_id: string; organization_id: string }[]>`SELECT physician_id, organization_id FROM organization_memberships`;
    const organizations = new Map(memberships.map(row => [row.physician_id, row.organization_id]));
    for (const encounter of db.encounters) {
      const organizationId = organizations.get(encounter.owner);
      if (!organizationId) throw new Error("Encounter owner has no organization membership.");
      await tx`
        INSERT INTO encounters (id, organization_id, physician_id, patient_id, revision, analysis_status, created_at, updated_at, document)
        VALUES (${encounter.id}, ${organizationId}, ${encounter.owner}, ${encounter.patientId}, ${encounter.revision}, ${encounter.analysis}, ${encounter.createdAt}, now(), ${tx.json(encounter as never)})
        ON CONFLICT (id) DO UPDATE SET organization_id = EXCLUDED.organization_id, physician_id = EXCLUDED.physician_id,
          patient_id = EXCLUDED.patient_id, revision = EXCLUDED.revision, analysis_status = EXCLUDED.analysis_status,
          updated_at = now(), document = EXCLUDED.document
      `;
      await tx`DELETE FROM media_objects WHERE encounter_id = ${encounter.id}`;
      for (const source of encounter.sources) {
        // A transcript source reuses its audio source's mediaId; only the audio source owns the file.
        if (source.mediaId && source.kind !== "transcript") await tx`
          INSERT INTO media_objects (file_key, source_id, encounter_id, organization_id, physician_id, kind, mime, byte_size, created_at)
          VALUES (${source.mediaId}, ${source.id}, ${encounter.id}, ${organizationId}, ${encounter.owner}, ${source.kind === "audio" ? "audio" : "image"}, ${source.mime || "application/octet-stream"}, ${source.byteSize || null}, ${source.createdAt})
        `;
        if (source.previewMediaId) await tx`
          INSERT INTO media_objects (file_key, source_id, encounter_id, organization_id, physician_id, kind, mime, byte_size, created_at)
          VALUES (${source.previewMediaId}, ${source.id}, ${encounter.id}, ${organizationId}, ${encounter.owner}, 'preview', 'image/jpeg', null, ${source.createdAt})
        `;
      }
      await tx`DELETE FROM transcript_artifacts WHERE encounter_id = ${encounter.id}`;
      for (const artifact of encounter.transcripts || []) await tx`
        INSERT INTO transcript_artifacts (id, encounter_id, physician_id, source_id, provider, model, digest, artifact, created_at)
        VALUES (${artifact.id}, ${encounter.id}, ${encounter.owner}, ${artifact.transcriptSourceId}, ${artifact.provider}, ${artifact.model}, ${artifact.digest}, ${tx.json(artifact as never)}, ${artifact.createdAt})
      `;
      await tx`DELETE FROM clinical_findings WHERE encounter_id = ${encounter.id}`;
      for (const finding of encounter.findings) await tx`
        INSERT INTO clinical_findings (id, encounter_id, physician_id, section, review_status, finding)
        VALUES (${finding.id}, ${encounter.id}, ${encounter.owner}, ${finding.section}, ${finding.review}, ${tx.json(finding as never)})
      `;
      await tx`DELETE FROM approved_notes WHERE encounter_id = ${encounter.id}`;
      if (encounter.approval) await tx`
        INSERT INTO approved_notes (encounter_id, physician_id, revision, digest, snapshot, approved_at)
        VALUES (${encounter.id}, ${encounter.owner}, ${encounter.approval.revision}, ${encounter.approval.digest}, ${tx.json(encounter.approval as never)}, ${encounter.approval.at})
      `;
      for (let index = 0; index < encounter.audit.length; index++) {
        const event = encounter.audit[index];
        await tx`
          INSERT INTO audit_events (encounter_id, physician_id, event_index, occurred_at, action, revision, event)
          VALUES (${encounter.id}, ${encounter.owner}, ${index}, ${event.at}, ${event.action}, ${event.revision}, ${tx.json(event as never)})
          ON CONFLICT (encounter_id, event_index) DO NOTHING
        `;
      }
      const active = encounter.activeAnalysis;
      if (active) await tx`
        INSERT INTO analysis_jobs (run_id, encounter_id, organization_id, physician_id, encounter_revision, status, attempts, queued_at, started_at, expires_at, snapshot)
        VALUES (${active.id}, ${encounter.id}, ${organizationId}, ${encounter.owner}, ${encounter.revision}, ${active.status === "processing" ? "running" : "queued"}, ${active.attempts}, ${active.queuedAt}, ${active.startedAt || null}, ${new Date(active.expiresAt)}, ${tx.json(encounter as never)})
        ON CONFLICT (run_id) DO UPDATE SET status = EXCLUDED.status, attempts = EXCLUDED.attempts,
          started_at = EXCLUDED.started_at, expires_at = EXCLUDED.expires_at, snapshot = EXCLUDED.snapshot
      `;
    }
    const activeIds = new Set(db.encounters.flatMap(item => item.activeAnalysis ? [item.activeAnalysis.id] : []));
    for (const job of jobRows) {
      if (activeIds.has(job.run_id)) continue;
      const encounter = db.encounters.find(item => item.id === job.encounter_id);
      const status = encounter?.analysis === "ready" && encounter.audit.at(-1)?.action === "analysis completed" ? "completed"
        : encounter?.analysis === "failed" && encounter.audit.at(-1)?.action.includes("analysis") ? "failed" : "cancelled";
      await tx`UPDATE analysis_jobs SET status = ${status}, finished_at = now(), error_code = ${status === "completed" ? null : status} WHERE run_id = ${job.run_id}`;
    }

    await tx`DELETE FROM ehr_charts`;
    for (const chart of db.ehrCharts || []) {
      const organizationId = organizations.get(chart.owner);
      if (!organizationId) throw new Error("EHR chart owner has no organization membership.");
      await tx`INSERT INTO ehr_charts (organization_id, physician_id, patient_id, version, document) VALUES (${organizationId}, ${chart.owner}, ${chart.patientId}, ${chart.version}, ${tx.json(chart as never)})`;
      for (const note of chart.notes) await tx`
        INSERT INTO ehr_notes (id, encounter_id, physician_id, patient_id, revision, digest, note, saved_at)
        VALUES (${note.id}, ${note.encounterId}, ${chart.owner}, ${note.patientId}, ${note.revision}, ${note.digest}, ${tx.json(note as never)}, ${note.savedAt})
        ON CONFLICT (id) DO UPDATE SET note = EXCLUDED.note, saved_at = EXCLUDED.saved_at
      `;
    }
    return structuredClone(result);
  });
  return persisted as T;
}

export async function transaction<T>(fn: (db: Database) => T | Promise<T>): Promise<T> {
  return process.env.DATABASE_URL ? postgresTransaction(fn) : legacyTransaction(fn);
}

export class AppError extends Error { constructor(public status: number, message: string) { super(message); } }
export function auth(db: Database, request: Request, encounterId?: string) {
  const cookieName = process.env.DATABASE_URL ? "spotcheck_session=" : "aura_session=";
  const raw = request.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith(cookieName))?.slice(cookieName.length);
  const session = db.sessions.find(s => s.id === tokenHash(raw || "") && s.expires > Date.now());
  if (!session) throw new AppError(401, "Your physician session is missing or expired. Sign in again.");
  if (encounterId) {
    const encounter = db.encounters.find(item => item.id === encounterId);
    if (!encounter || session.owner !== encounter.owner) throw new AppError(404, "Encounter not found.");
  }
  return session;
}
export function createSession(db: Database, owner: string, organizationId?: string) {
  const token = randomBytes(32).toString("base64url");
  db.sessions.push({ id: tokenHash(token), owner, organizationId, expires: Date.now() + 12 * 60 * 60 * 1000 });
  return token;
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  const host = request.headers.get("host");
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const accepted = [url.origin, host ? `${url.protocol}//${host}` : "", host && forwardedProto ? `${forwardedProto}://${host}` : ""];
  if (!origin || !accepted.includes(origin)) throw new AppError(403, "This action must originate from the app.");
}
export function cookieHeader(id: string, request: Request) {
  const name = process.env.DATABASE_URL ? "spotcheck_session" : "aura_session";
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const secure = forwardedProto === "https" || new URL(request.url).protocol === "https:";
  return `${name}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure ? "; Secure" : ""}`;
}
export function changed(e: Encounter, action: string) {
  if (e.analysis === "running" && action !== "analysis started") {
    e.analysis = "none"; e.activeAnalysis = undefined;
    e.analysisError = "Analysis was cancelled because the encounter changed. Run analysis again.";
  }
  e.revision++; e.approval = null; e.export = null;
  e.audit.push({ at: new Date().toISOString(), action, revision: e.revision });
}
export function checkRevision(e: Encounter, revision: number) {
  if (e.revision !== revision) throw new AppError(409, "This encounter changed on another device. Reload before saving.");
}
export function respondError(error: unknown) {
  if (error instanceof AppError) return Response.json({ error: error.message }, { status: error.status });
  return Response.json({ error: "The request could not be completed. No EHR write occurred." }, { status: 500 });
}
export function mediaPath(id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new AppError(400, "Invalid media identifier.");
  return path.join(dataRoot, "media", `${id}.bin`);
}
