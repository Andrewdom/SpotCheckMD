import { z } from "zod";
export const variants = ["gpt4o-context", "medgemma-image-only", "medgemma-context"] as const;
const count = z.number().int().nonnegative();
export const evaluationRow = z.object({
  caseId: z.string().min(1), variant: z.enum(variants), status: z.enum(["success", "failed"]),
  reviewed: z.boolean(), expected: count, supported: count, unsupported: count, missed: count, corrected: count,
  latencyMs: z.number().finite().nonnegative(), costUsd: z.number().finite().nonnegative().nullable(),
}).strict().superRefine((r, ctx) => {
  if (r.status === "success" && !r.reviewed) ctx.addIssue({ code: "custom", message: "Successful outputs need independent human review" });
  if (r.missed > r.expected || r.corrected > r.supported + r.unsupported) ctx.addIssue({ code: "custom", message: "Impossible annotation counts" });
  if (r.status === "failed" && (r.supported || r.unsupported || r.corrected)) ctx.addIssue({ code: "custom", message: "Failed outputs cannot have finding counts" });
});
export function summarizeComparison(raw: unknown) {
  const rows = z.array(evaluationRow).min(3).parse(raw);
  const cases = new Map<string, typeof rows>();
  for (const row of rows) cases.set(row.caseId, [...(cases.get(row.caseId) || []), row]);
  for (const entries of cases.values()) {
    if (entries.length !== variants.length || new Set(entries.map(r => r.variant)).size !== variants.length || new Set(entries.map(r => r.expected)).size !== 1) throw new Error("Each case needs all three variants and the same reference denominator");
  }
  return variants.map(variant => {
    const group = rows.filter(r => r.variant === variant), successful = group.filter(r => r.status === "success");
    const sum = (key: "supported" | "unsupported" | "missed" | "expected" | "corrected") => successful.reduce((n, r) => n + r[key], 0);
    const generated = sum("supported") + sum("unsupported");
    const rate = (numerator: number, denominator: number) => ({ numerator, denominator, rate: denominator ? numerator / denominator : null });
    return { variant, cases: group.length, failures: group.length - successful.length, reviewedSuccessfulCases: successful.length,
      supported: sum("supported"), unsupported: rate(sum("unsupported"), generated), missed: rate(sum("missed"), sum("expected")), corrections: rate(sum("corrected"), generated),
      meanLatencyMs: group.reduce((n, r) => n + r.latencyMs, 0) / group.length,
      recordedCostCases: group.filter(r => r.costUsd !== null).length,
      totalCostUsd: group.every(r => r.costUsd !== null) ? group.reduce((n, r) => n + r.costUsd!, 0) : null,
    };
  });
}
