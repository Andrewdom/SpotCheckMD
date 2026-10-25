import assert from "node:assert/strict";
import test from "node:test";
import type { ChartNote, StoredChart } from "../lib/ehr/types";
import { assignLegacyCharts } from "../lib/legacy-import";

const note = (id: string, digest = id): ChartNote => ({
  id, digest, encounterId: id.padEnd(32, "0"), patientId: "demo-001", encounterDate: "2026-01-01T00:00:00.000Z",
  approvedAt: "2026-01-01T00:00:00.000Z", savedAt: "2026-01-01T00:00:00.000Z", physician: "Synthetic Physician", text: "Synthetic note.", revision: 1,
});
const chart = (owner: string, version: number, notes: ChartNote[]): StoredChart => ({ owner, patientId: "demo-001", version, notes });

test("legacy chart assignment merges browser-owner copies for one physician and patient", () => {
  const merged = assignLegacyCharts([chart("browser-a", 1, [note("note-a")]), chart("browser-b", 2, [note("note-b")])], "physician-a");
  assert.equal(merged.length, 1);
  assert.equal(merged[0].owner, "physician-a");
  assert.equal(merged[0].version, 2);
  assert.deepEqual(merged[0].notes.map(item => item.id), ["note-a", "note-b"]);
});

test("legacy chart assignment rejects conflicting copies of one note", () => {
  assert.throws(() => assignLegacyCharts([chart("browser-a", 1, [note("note-a", "first")]), chart("browser-b", 1, [note("note-a", "second")])], "physician-a"), /conflicting note/);
});
