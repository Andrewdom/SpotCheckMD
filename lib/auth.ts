import { createHash, createHmac, randomBytes } from "node:crypto";
import { hash, verify, type Options } from "@node-rs/argon2";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { sql } from "./database";
import { AppError } from "./store";

export const SESSION_COOKIE = "spotcheck_session";
const SESSION_SECONDS = 12 * 60 * 60;
const ARGON_OPTIONS: Options = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 };
const DUMMY_HASH = "$argon2id$v=19$m=19456,t=2,p=1$MTIzNDU2Nzg5MDEyMzQ1Ng$YBMQicXF4IIaOJQAhJgaif2yPXrgOknDC8vB/wIsazM";

export type PhysicianIdentity = { physicianId: string; organizationId: string; username: string; displayName: string; role: "physician" | "admin" };
export const sessionTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const normalizeUsername = (value: string) => value.trim().toLowerCase();
const fingerprint = (value: string) => createHmac("sha256", process.env.AUTH_RATE_LIMIT_SECRET || "development-only-rate-limit-secret").update(value).digest("hex");

export async function hashPassword(password: string) {
  if (password.length < 12 || password.length > 200) throw new AppError(400, "Password must contain at least 12 characters.");
  return hash(password, ARGON_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string) {
  try { return await verify(passwordHash, password, ARGON_OPTIONS); }
  catch { return false; }
}

export function requestClient(request: Request) {
  const forwarded = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return { ipHash: fingerprint(forwarded), userAgentHash: fingerprint(request.headers.get("user-agent") || "unknown") };
}

export async function signIn(usernameInput: string, password: string, request: Request) {
  const username = normalizeUsername(usernameInput);
  const client = requestClient(request);
  const throttleKey = fingerprint(`${username}|${client.ipHash}`);
  const outcome = await sql().begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${throttleKey}, 0))`;
    const recent = await db<{ failures: number }[]>`
      SELECT count(*)::int AS failures FROM login_attempts
      WHERE throttle_key = ${throttleKey} AND success = false AND attempted_at > now() - interval '15 minutes'
    `;
    if ((recent[0]?.failures || 0) >= 5) return { throttled: true as const };
    const rows = await db<{ id: string; username: string; display_name: string; password_hash: string; organization_id: string; role: "physician" | "admin" }[]>`
      SELECT p.id, p.username, p.display_name, p.password_hash, m.organization_id, m.role
      FROM physicians p JOIN organization_memberships m ON m.physician_id = p.id
      WHERE p.username_normalized = ${username} AND p.active = true
      ORDER BY m.created_at LIMIT 1
    `;
    const physician = rows[0];
    const valid = await verifyPassword(physician?.password_hash || DUMMY_HASH, password);
    await db`INSERT INTO login_attempts (throttle_key, success) VALUES (${throttleKey}, ${Boolean(physician && valid)})`;
    if (!physician || !valid) return { invalid: true as const };
    const token = randomBytes(32).toString("base64url");
    await db`
      INSERT INTO physician_sessions (token_hash, physician_id, organization_id, expires_at, ip_hash, user_agent_hash)
      VALUES (${sessionTokenHash(token)}, ${physician.id}, ${physician.organization_id}, now() + interval '12 hours', ${client.ipHash}, ${client.userAgentHash})
    `;
    return { token, physician };
  });
  if ("throttled" in outcome) throw new AppError(429, "Sign-in is temporarily unavailable. Wait before trying again.");
  if ("invalid" in outcome) throw new AppError(401, "Invalid username or password.");
  const { token, physician } = outcome;
  return { token, identity: { physicianId: physician.id, organizationId: physician.organization_id, username: physician.username, displayName: physician.display_name, role: physician.role } satisfies PhysicianIdentity };
}

export async function identityForToken(token: string | undefined): Promise<PhysicianIdentity | null> {
  if (!token) return null;
  const rows = await sql()<PhysicianIdentity[]>`
    SELECT p.id AS "physicianId", s.organization_id AS "organizationId", p.username, p.display_name AS "displayName", m.role
    FROM physician_sessions s
    JOIN physicians p ON p.id = s.physician_id AND p.active = true
    JOIN organization_memberships m ON m.physician_id = p.id AND m.organization_id = s.organization_id
    WHERE s.token_hash = ${sessionTokenHash(token)} AND s.revoked_at IS NULL AND s.expires_at > now()
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function revokeSession(token: string | undefined) {
  if (token) await sql()`UPDATE physician_sessions SET revoked_at = now() WHERE token_hash = ${sessionTokenHash(token)} AND revoked_at IS NULL`;
}

export function sessionCookie(token: string, request: Request) {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const secure = forwardedProto === "https" || new URL(request.url).protocol === "https:";
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}`;
}

export function expiredSessionCookie(request: Request) {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const secure = forwardedProto === "https" || new URL(request.url).protocol === "https:";
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;
}

export async function requirePageIdentity() {
  const cookieStore = await cookies();
  const identity = await identityForToken(cookieStore.get(SESSION_COOKIE)?.value);
  if (!identity) {
    const headerStore = await headers();
    const reason = headerStore.get("cookie")?.includes(`${SESSION_COOKIE}=`) ? "expired" : "required";
    redirect(`/sign-in?reason=${reason}`);
  }
  return identity;
}
