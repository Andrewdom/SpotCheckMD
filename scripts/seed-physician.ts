import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { hashPassword } from "../lib/auth";
import { closeDatabase, sql } from "../lib/database";

async function main() {
const input = createInterface({ input: stdin, output: stdout });
const username = (process.env.SEED_USERNAME || await input.question("Username: ")).trim();
const displayName = (process.env.SEED_DISPLAY_NAME || await input.question("Display name: ")).trim();
const organizationName = (process.env.SEED_ORGANIZATION || await input.question("Organization: ")).trim();
input.close();
async function hiddenPassword() {
  if (process.env.SPOTCHECK_SEED_PASSWORD) return process.env.SPOTCHECK_SEED_PASSWORD;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") throw new Error("Run interactively or provide SPOTCHECK_SEED_PASSWORD through a protected process environment.");
  stdout.write("Temporary password: ");
  emitKeypressEvents(stdin); stdin.setRawMode(true); stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const handler = (character: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") { stdin.setRawMode(false); stdin.pause(); reject(new Error("Cancelled.")); return; }
      if (key.name === "return" || key.name === "enter") { stdin.off("keypress", handler); stdin.setRawMode(false); stdin.pause(); stdout.write("\n"); resolve(value); return; }
      if (key.name === "backspace") value = value.slice(0, -1);
      else if (character && !key.ctrl) value += character;
    };
    stdin.on("keypress", handler);
  });
}
const password = await hiddenPassword();
if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username) || displayName.length < 3 || organizationName.length < 2) throw new Error("Invalid seed account fields.");
const physicianId = randomBytes(16).toString("hex");
const organizationId = randomBytes(16).toString("hex");
const passwordHash = await hashPassword(password);
await sql().begin(async tx => {
  await tx`INSERT INTO organizations (id, name) VALUES (${organizationId}, ${organizationName})`;
  await tx`INSERT INTO physicians (id, username, username_normalized, display_name, password_hash) VALUES (${physicianId}, ${username}, ${username.toLowerCase()}, ${displayName}, ${passwordHash})`;
  await tx`INSERT INTO organization_memberships (organization_id, physician_id, role) VALUES (${organizationId}, ${physicianId}, 'admin')`;
});
console.log(`Seeded physician ${username}. Password was hashed with Argon2id.`);
await closeDatabase();
}

void main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await closeDatabase().catch(() => {});
  process.exitCode = 1;
});
