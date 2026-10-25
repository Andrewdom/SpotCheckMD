import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, sessionCookie, sessionTokenHash, verifyPassword } from "../lib/auth";
import { AppError, auth, createSession, type Database } from "../lib/store";
import type { Encounter } from "../lib/domain";

const encounter = (owner: string): Encounter => ({
  id: "1".repeat(32), owner, patientId: "demo-001", specialty: "skin", createdAt: new Date().toISOString(), revision: 0,
  consent: false, patientConfirmed: false, sources: [], findings: [], conflicts: [], analysis: "none", analysisError: "",
  model: "", promptVersion: "visual-v1", approval: null, export: null, audit: [],
});
const request = (token: string) => new Request("https://spotcheckmd.example/api/demo", { headers: { Cookie: `aura_session=${token}` } });

test("passwords use Argon2id and reject incorrect credentials", async () => {
  const encoded = await hashPassword("synthetic-password-123");
  assert.match(encoded, /^\$argon2id\$/);
  assert.equal(await verifyPassword(encoded, "synthetic-password-123"), true);
  assert.equal(await verifyPassword(encoded, "incorrect-password"), false);
  assert.doesNotMatch(encoded, /synthetic-password/);
});

test("session cookies are proxy-aware, HttpOnly, Secure and SameSite", () => {
  const header = sessionCookie("synthetic-token", new Request("http://internal/api/auth/login", { headers: { "x-forwarded-proto": "https" } }));
  assert.match(header, /^spotcheck_session=/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Secure/);
  assert.doesNotMatch(header, /synthetic-password/);
});

test("two device sessions share one physician workspace while another physician is denied", () => {
  delete process.env.DATABASE_URL;
  const db: Database = { encounters: [encounter("physician-a")], sessions: [] };
  const first = createSession(db, "physician-a");
  const second = createSession(db, "physician-a");
  const foreign = createSession(db, "physician-b");
  assert.notEqual(first, second);
  assert.equal(auth(db, request(first), db.encounters[0].id).owner, "physician-a");
  assert.equal(auth(db, request(second), db.encounters[0].id).owner, "physician-a");
  assert.throws(() => auth(db, request(foreign), db.encounters[0].id), (error: unknown) => error instanceof AppError && error.status === 404);
  assert.ok(db.sessions.every(session => ![first, second, foreign].includes(session.id)));
  assert.equal(db.sessions[0].id, sessionTokenHash(first));
});

test("expired sessions are rejected", () => {
  delete process.env.DATABASE_URL;
  const db: Database = { encounters: [encounter("physician-a")], sessions: [] };
  const token = createSession(db, "physician-a");
  db.sessions[0].expires = Date.now() - 1;
  assert.throws(() => auth(db, request(token)), (error: unknown) => error instanceof AppError && error.status === 401);
});
