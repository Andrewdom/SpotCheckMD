import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { Encounter } from "./domain";

export const dataRoot = process.env.AURA_DATA_DIR || path.join(process.cwd(), ".aura-data");
type Session = { id: string; owner: string; encounterId: string | null; expires: number };
type Pairing = { hash: string; encounterId: string; expires: number; used: boolean };
type Database = { encounters: Encounter[]; sessions: Session[]; pairings: Pairing[] };
const globalStore = globalThis as unknown as { auraLock?: Promise<unknown> };
export const uid = () => randomBytes(16).toString("hex");
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

// Single-process prototype storage. Replace with transactional encrypted storage before deployment.
export async function transaction<T>(fn: (db: Database) => T | Promise<T>): Promise<T> {
  const work = (globalStore.auraLock || Promise.resolve()).then(async () => {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    let db: Database;
    try { db = JSON.parse(await readFile(path.join(dataRoot, "db.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; db = { encounters: [], sessions: [], pairings: [] }; }
    db.sessions = db.sessions.filter(s => s.expires > Date.now());
    db.pairings = db.pairings.filter(p => p.expires > Date.now());
    const result = await fn(db);
    const temp = path.join(dataRoot, `db-${uid()}.tmp`);
    await writeFile(temp, JSON.stringify(db), { mode: 0o600 });
    await rename(temp, path.join(dataRoot, "db.json"));
    return structuredClone(result);
  });
  globalStore.auraLock = work.catch(() => {});
  return work;
}

export class AppError extends Error { constructor(public status: number, message: string) { super(message); } }
export function auth(db: Database, request: Request, encounterId?: string) {
  const cookie = request.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith("aura_session="))?.slice(13);
  const session = db.sessions.find(s => s.id === cookie && s.expires > Date.now());
  if (!session) throw new AppError(401, "Open the demo workspace or scan a fresh encounter link.");
  if (encounterId) {
    const e = db.encounters.find(v => v.id === encounterId);
    if (!e || (session.encounterId ? session.encounterId !== e.id : session.owner !== e.owner)) throw new AppError(404, "Encounter not found.");
  }
  return session;
}
export function createSession(db: Database, owner: string, encounterId: string | null = null) {
  const id = uid();
  db.sessions.push({ id, owner, encounterId, expires: Date.now() + 8 * 60 * 60 * 1000 });
  return id;
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  const host = request.headers.get("host");
  const accepted = [url.origin, host ? `${url.protocol}//${host}` : ""];
  if (!origin || !accepted.includes(origin)) throw new AppError(403, "This action must originate from the app.");
}
export function cookieHeader(id: string, request: Request) {
  return `aura_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
export function changed(e: Encounter, action: string) {
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
  return path.join(dataRoot, `${id}.bin`);
}
