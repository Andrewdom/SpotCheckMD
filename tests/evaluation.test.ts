import test from "node:test";
import assert from "node:assert/strict";
import { summarizeComparison, variants } from "../lib/image-analysis/evaluation";
const rows = () => variants.map(variant => ({ caseId: "fictional", variant, status: "success", reviewed: true, expected: 4, supported: 3, unsupported: 1, missed: 1, corrected: 1, latencyMs: 100, costUsd: null }));
test("comparison reports denominators and leaves unknown cost null", () => {
  for (const r of summarizeComparison(rows())) { assert.equal(r.unsupported.rate, .25); assert.equal(r.unsupported.denominator, 4); assert.equal(r.totalCostUsd, null); }
});
test("comparison rejects unreviewed, negative, impossible and unpaired annotations", () => {
  for (const mutate of [(r: ReturnType<typeof rows>) => { r[0].reviewed = false; }, (r: ReturnType<typeof rows>) => { r[0].supported = -1; }, (r: ReturnType<typeof rows>) => { r[0].missed = 5; }, (r: ReturnType<typeof rows>) => { r.pop(); }, (r: ReturnType<typeof rows>) => { r[0].expected = 3; }]) { const r = rows(); mutate(r); assert.throws(() => summarizeComparison(r)); }
});
test("failures stay in case and latency counts, not clinical quality denominators", () => {
  const r = rows(); Object.assign(r[0], { status: "failed", reviewed: false, supported: 0, unsupported: 0, corrected: 0, missed: 0 });
  const result = summarizeComparison(r)[0]; assert.equal(result.failures, 1); assert.equal(result.cases, 1); assert.equal(result.unsupported.rate, null);
});
