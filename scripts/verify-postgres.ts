import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

async function main() {
const databaseUrl = process.env.DATABASE_URL || "";
if (!/\/(spotcheckmd_test)(?:\?|$)/.test(databaseUrl)) throw new Error("Refusing to run unless DATABASE_URL selects spotcheckmd_test.");
const mediaRoot = await mkdtemp(path.join(tmpdir(), "spotcheckmd-postgres-test-"));
process.env.AURA_DATA_DIR = mediaRoot;
process.env.AUTH_RATE_LIMIT_SECRET ||= "synthetic-integration-rate-limit-secret";

const { sql, closeDatabase } = await import("../lib/database");
const { hashPassword, identityForToken, revokeSession, signIn } = await import("../lib/auth");
const store = await import("../lib/store");
const api = await import("../app/api/demo/route");
const mediaApi = await import("../app/api/media/[id]/route");

const db = sql();
await db`TRUNCATE login_attempts, physician_sessions, audit_events, approved_notes, ehr_notes, ehr_charts, analysis_jobs, clinical_findings, transcript_artifacts, media_objects, encounters, organization_memberships, physicians, organizations CASCADE`;
const passwordHash = await hashPassword("synthetic-password-123");
for (const [physicianId, username] of [["a".repeat(32), "physician-a"], ["b".repeat(32), "physician-b"]]) {
  const organizationId = `${physicianId.slice(0, 31)}o`;
  await db`INSERT INTO organizations (id, name) VALUES (${organizationId}, ${`Synthetic ${username}`})`;
  await db`INSERT INTO physicians (id, username, username_normalized, display_name, password_hash) VALUES (${physicianId}, ${username}, ${username}, ${username}, ${passwordHash})`;
  await db`INSERT INTO organization_memberships (organization_id, physician_id, role) VALUES (${organizationId}, ${physicianId}, 'physician')`;
}
const origin = "http://localhost:3107";
const request = (body: unknown) => new Request(`${origin}/api/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
await assert.rejects(signIn("physician-a", "wrong-password", request({})), (error: unknown) => error instanceof store.AppError && error.status === 401);
const first = await signIn("physician-a", "synthetic-password-123", request({}));
const second = await signIn("physician-a", "synthetic-password-123", request({}));
const foreign = await signIn("physician-b", "synthetic-password-123", request({}));
assert.notEqual(first.token, second.token);
const cookie = (token: string) => `spotcheck_session=${token}`;
async function action(token: string, name: string, body: Record<string, unknown> | FormData) {
  return api.POST(new Request(`${origin}/api/demo?action=${name}`, { method: "POST", headers: { Origin: origin, Cookie: cookie(token), ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }) }, body: body instanceof FormData ? body : JSON.stringify(body) }));
}
let response = await action(first.token, "create", { patientId: "demo-001" });
assert.equal(response.status, 200); let encounter = (await response.json()).encounter;
const shared = await api.GET(new Request(`${origin}/api/demo`, { headers: { Cookie: cookie(second.token) } }));
assert.ok((await shared.json()).encounters.some((item: { id: string }) => item.id === encounter.id));
const isolated = await api.GET(new Request(`${origin}/api/demo`, { headers: { Cookie: cookie(foreign.token) } }));
assert.equal((await isolated.json()).encounters.length, 0);
const concurrent = await Promise.all([
  action(first.token, "confirm", { encounterId: encounter.id, revision: encounter.revision, confirmed: true, consent: true }),
  action(second.token, "confirm", { encounterId: encounter.id, revision: encounter.revision, confirmed: true, consent: true }),
]);
assert.deepEqual(concurrent.map(item => item.status).sort(), [200, 409]);
encounter = (await (await api.GET(new Request(`${origin}/api/demo`, { headers: { Cookie: cookie(first.token) } }))).json()).encounters[0];
const blocked = await action(foreign.token, "confirm", { encounterId: encounter.id, revision: encounter.revision, confirmed: true, consent: true });
assert.equal(blocked.status, 404);

const image = await sharp({ create: { width: 800, height: 800, channels: 3, background: "#887766" } }).jpeg().toBuffer();
const form = new FormData(); form.set("encounterId", encounter.id); form.set("revision", String(encounter.revision)); form.set("kind", "image"); form.set("file", new Blob([new Uint8Array(image)], { type: "image/jpeg" }), "synthetic.jpg");
response = await action(first.token, "upload", form); assert.equal(response.status, 200); encounter = (await response.json()).encounter;
const mediaId = encounter.sources[0].mediaId;
assert.equal((await mediaApi.GET(new Request(`${origin}/api/media/${mediaId}`, { headers: { Cookie: cookie(second.token) } }), { params: Promise.resolve({ id: mediaId }) })).status, 200);
assert.equal((await mediaApi.GET(new Request(`${origin}/api/media/${mediaId}`, { headers: { Cookie: cookie(foreign.token) } }), { params: Promise.resolve({ id: mediaId }) })).status, 404);

response = await action(first.token, "manual", { encounterId: encounter.id, revision: encounter.revision, section: "O", sourceId: encounter.sources[0].id, text: "Synthetic field is visible.", evidenceQuote: "Central synthetic field" }); encounter = (await response.json()).encounter;
response = await action(first.token, "review", { encounterId: encounter.id, revision: encounter.revision, findingId: encounter.findings[0].id, review: "accepted", text: encounter.findings[0].text, reviewNote: "Reviewed synthetic source." }); encounter = (await response.json()).encounter;
response = await action(first.token, "approve-send", { encounterId: encounter.id, revision: encounter.revision, physician: "Synthetic Physician" }); assert.equal(response.status, 200); encounter = (await response.json()).encounter;
assert.equal((await db<[{ count: number }]>`SELECT count(*)::int AS count FROM ehr_notes WHERE encounter_id = ${encounter.id}`)[0].count, 1);

await store.transaction(database => {
  const current = database.encounters.find(item => item.id === encounter.id)!;
  current.analysis = "running";
  current.activeAnalysis = { id: "c".repeat(32), status: "queued", queuedAt: new Date().toISOString(), attempts: 0, expiresAt: Date.now() + 60_000 };
});
assert.equal((await db<[{ status: string }]>`SELECT status FROM analysis_jobs WHERE run_id = ${"c".repeat(32)}`)[0].status, "queued");
await closeDatabase();
const reopened = (await import("../lib/database")).sql();
assert.equal((await reopened<[{ count: number }]>`SELECT count(*)::int AS count FROM encounters WHERE id = ${encounter.id}`)[0].count, 1);

await revokeSession(first.token);
assert.equal(await identityForToken(first.token), null);
await reopened`UPDATE physician_sessions SET expires_at = now() - interval '1 minute' WHERE token_hash = ${store.digest(second.token)}`;
assert.equal(await identityForToken(second.token), null);
console.log("PASS: PostgreSQL auth, isolation, two-device sharing, optimistic concurrency, media ownership, EHR persistence and queued jobs");
await closeDatabase();
await rm(mediaRoot, { recursive: true, force: true });
}

void main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  const { closeDatabase } = await import("../lib/database");
  await closeDatabase().catch(() => {});
  process.exitCode = 1;
});
