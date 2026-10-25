import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { closeDatabase, sql } from "../lib/database";

async function main() {
const directory = path.resolve(process.cwd(), "db/migrations");
for (const file of (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
  const applied = await sql()<[{ exists: boolean }]>`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists`;
  if (applied[0]?.exists) {
    const rows = await sql()<[{ applied: boolean }]>`SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = ${file.replace(/\.sql$/, "")}) AS applied`;
    if (rows[0]?.applied) { console.log(`skip ${file}`); continue; }
  }
  const connection = await sql().reserve();
  try { await connection.unsafe(await readFile(path.join(directory, file), "utf8")); }
  finally { connection.release(); }
  console.log(`applied ${file}`);
}
await closeDatabase();
}

void main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await closeDatabase().catch(() => {});
  process.exitCode = 1;
});
