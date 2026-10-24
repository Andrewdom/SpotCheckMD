import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { assessImage } from "../lib/analysis";
import { contextSchema, transcriptWindows, PROMPT_VERSION, type ImageResult } from "../lib/image-analysis/contracts";
import { medgemmaProvider, openaiImageProvider } from "../lib/image-analysis/providers";
import { variants } from "../lib/image-analysis/evaluation";

async function main() {
  const [manifest, output, flag] = process.argv.slice(2);
  if (!manifest || !output || flag !== "--run-live") throw Error("Usage: tsx scripts/compare-image-analysis.ts MANIFEST OUTPUT_DIR --run-live (sends authorized inputs to configured providers)");
  const cases = z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(80), authorizedForModelProcessing: z.literal(true), imagePath: z.string().min(1), transcript: z.string().trim().min(1).max(100000), context: contextSchema }).strict()).min(1).parse(JSON.parse(await readFile(manifest, "utf8")));
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw Error("Duplicate case IDs");
  await mkdir(output, { recursive: true, mode: 0o700 });
  const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  for (const [index, c] of cases.entries()) {
    const source = await assessImage(await readFile(path.resolve(path.dirname(manifest), c.imagePath)));
    const windows = transcriptWindows({ id: `${c.id}-transcript`, text: c.transcript });
    // Rotate execution order across cases; record it, so ordering is not hidden.
    const order = [...variants.slice(index % 3), ...variants.slice(0, index % 3)];
    for (const variant of order) {
      const provider = variant === "gpt4o-context" ? openaiImageProvider() : medgemmaProvider();
      const started = performance.now(); const results: ImageResult[] = []; let status = "success";
      try {
        for (const transcript of variant === "medgemma-image-only" ? [null] : windows) results.push(await provider.analyze({ image: { id: `${c.id}-image`, bytes: source.normalized, quality: source.quality }, transcript, context: c.context }));
      } catch { status = "failed"; }
      const record = { caseId: c.id, variant, status, order, promptVersion: PROMPT_VERSION, imageDigest: digest(source.normalized), transcriptDigest: digest(c.transcript), clinicalContext: c.context, sourceQuality: source.quality, results, latencyMs: performance.now() - started, costUsd: null, reviewed: false, expected: null, supported: null, unsupported: null, missed: null, corrected: null };
      await writeFile(path.join(output, `${c.id}-${variant}.json`), JSON.stringify(record, null, 2), { flag: "wx", mode: 0o600 });
      console.log(`${c.id} ${variant}: ${status}`);
    }
  }
}
main().catch(() => { console.error("Comparison failed. Check manifest, authorization, credentials, service access, and use a new output directory. No clinical metrics were generated."); process.exitCode = 1; });
