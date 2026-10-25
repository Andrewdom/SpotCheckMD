import { constants } from "node:fs";
import { chown, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { assignLegacyCharts } from "../lib/legacy-import";
import type { Database } from "../lib/store";
import { closeDatabase, sql } from "../lib/database";
import { transaction } from "../lib/store";

async function main() {
const args = process.argv.slice(2);
const value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const source = path.resolve(value("--source") || "");
const physicianId = value("--physician");
const apply = args.includes("--apply");
if (!source || !physicianId) throw new Error("Usage: npm run db:import-legacy -- --source /private/data --physician <id> [--apply]");
const sourceFile = path.join(source, "db.json");
const legacy = JSON.parse(await readFile(sourceFile, "utf8")) as Database;
const physician = await sql()<[{ organization_id: string }]>`SELECT organization_id FROM organization_memberships WHERE physician_id = ${physicianId} LIMIT 1`;
if (!physician[0]) throw new Error("Seeded physician membership not found.");
const mediaKeys = new Set(legacy.encounters.flatMap(encounter => encounter.sources.flatMap(item => [item.mediaId, item.previewMediaId]).filter((item): item is string => Boolean(item))));
for (const key of mediaKeys) await readFile(path.join(source, `${key}.bin`));
console.log(`Validated ${legacy.encounters.length} encounters, ${legacy.ehrCharts?.length || 0} charts and ${mediaKeys.size} media files. Anonymous sessions will not be imported.`);
if (!apply) { console.log("Dry run only. Repeat with --apply after reviewing the backup and assignment."); await closeDatabase(); process.exit(0); }
const targetCounts = await sql()<[{ encounters: number; charts: number }]>`SELECT (SELECT count(*)::int FROM encounters) AS encounters, (SELECT count(*)::int FROM ehr_charts) AS charts`;
if (targetCounts[0].encounters || targetCounts[0].charts) throw new Error("Target database is not empty; import was stopped.");
const backup = path.join(source, "legacy-backups", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(path.join(backup, "media"), { recursive: true, mode: 0o700 });
await copyFile(sourceFile, path.join(backup, "db.json"));
await mkdir(path.join(process.env.AURA_DATA_DIR || ".aura-data", "media"), { recursive: true, mode: 0o700 });
for (const key of mediaKeys) {
  const original = path.join(source, `${key}.bin`);
  await copyFile(original, path.join(backup, "media", `${key}.bin`), constants.COPYFILE_EXCL);
  const target = path.join(process.env.AURA_DATA_DIR || ".aura-data", "media", `${key}.bin`);
  try { await copyFile(original, target, constants.COPYFILE_EXCL); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await readFile(original)).equals(await readFile(target))) throw error;
  }
  if (process.getuid?.() === 0) await chown(target, 1001, 1001);
}
await transaction(db => {
  db.encounters = legacy.encounters.map(encounter => ({ ...encounter, owner: physicianId }));
  db.ehrCharts = assignLegacyCharts(legacy.ehrCharts || [], physicianId);
  db.sessions = [];
});
console.log(`Imported legacy data assigned to physician ${physicianId}. Backup: ${backup}`);
await closeDatabase();
}

void main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await closeDatabase().catch(() => {});
  process.exitCode = 1;
});
