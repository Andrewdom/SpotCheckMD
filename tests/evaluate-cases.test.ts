import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.join(process.cwd(), "scripts", "evaluate.mjs");
const valid = { id: "fictional-001", reviewed: true, skinTone: "dark", lighting: "low", accent: "regional", terminology: "complex", expected: 4, supported: 3, unsupported: 1, missed: 1, corrected: 1, totalTranscriptTerms: 5, missedTranscriptTerms: 1 };

function run(cases: unknown) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "eval-")), "cases.json");
  writeFileSync(file, JSON.stringify(cases));
  return spawnSync(process.execPath, [script, file], { encoding: "utf8" });
}

test("valid fictional counts keep the published subgroup rates", () => {
  const result = run([valid]);
  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout.trim().split("\n").slice(1);
  assert.equal(rows.length, 4);
  for (const line of rows) {
    const columns = line.split("\t");
    assert.equal(columns[2], "25.0%");
    assert.equal(columns[3], "25.0%");
    assert.equal(columns[4], "25.0%");
    assert.equal(columns[5], "20.0%");
  }
});

test("a case with no generated findings stays reportable", () => {
  const result = run([{ ...valid, expected: 2, supported: 0, unsupported: 0, missed: 2, corrected: 0, totalTranscriptTerms: 0, missedTranscriptTerms: 0 }]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /100\.0%/);
  assert.match(result.stdout, /N\/A/);
});

test("negative and impossible annotation counts are rejected", () => {
  const negative = run([{ ...valid, supported: -1 }]);
  assert.notEqual(negative.status, 0);
  assert.match(negative.stderr, /missing human review counts/);
  for (const patch of [{ missed: 5 }, { corrected: 5 }, { missedTranscriptTerms: 6 }]) {
    const result = run([{ ...valid, ...patch }]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /impossible annotation counts/);
  }
});
