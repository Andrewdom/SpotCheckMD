// Explicit local integration check using private SCIN data. No clinical scoring.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assessImage } from "../lib/analysis";
import { contextSchema, PROMPT_VERSION, type ImageRequest } from "../lib/image-analysis/contracts";
import { medgemmaProvider } from "../lib/image-analysis/providers";

const caseSchema = z.object({
  id: z.string().regex(/^scin-[A-Za-z0-9_-]+$/).max(56),
  authorizedForModelProcessing: z.literal(true),
  imagePath: z.string().min(1),
  transcript: z.string().trim().min(1).max(6000),
  context: contextSchema,
}).strict();
const provenanceSchema = z.object({
  version: z.literal(1), source: z.literal("https://github.com/google-research-datasets/scin"),
  license: z.literal("https://github.com/google-research-datasets/scin/blob/main/LICENSE"),
  noReidentification: z.literal(true), dermatologistConditionLabelsIncludedInModelInput: z.literal(false),
  metadata: z.unknown(),
  cases: z.array(z.object({ testId: z.string(), caseId: z.string(), imageObject: z.string(), imageSha256: z.string().regex(/^[0-9a-f]{64}$/) }).passthrough()),
}).strict();

const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");

function failureStage(reason: string, fallback: string) {
  return ["image decoding", "generation", "JSON parsing", "schema validation", "evidence validation",
    "response-envelope parsing", "TypeScript schema validation", "TypeScript evidence validation"]
    .find(stage => reason.includes(stage)) || fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const manifestArg = args[0], outputArg = args[1];
  const variantIndex = args.indexOf("--variant");
  const caseIndex = args.indexOf("--case");
  const variant = variantIndex >= 0 ? args[variantIndex + 1] : "";
  const requestedCase = caseIndex >= 0 ? args[caseIndex + 1] : null;
  if (!manifestArg || !outputArg || !["image-only", "image-and-context"].includes(variant) || !args.includes("--run-live")) {
    throw Error("Usage: tsx scripts/verify-scin-medgemma.ts MANIFEST NEW_OUTPUT --variant image-only|image-and-context [--case ID] --run-live");
  }
  const url = new URL(process.env.MEDGEMMA_URL || "");
  const loopback = url.protocol === "http:" && url.hostname === "127.0.0.1";
  const privateTailscale = url.protocol === "https:" && url.hostname.endsWith(".ts.net") && (!url.port || url.port === "443");
  if (url.username || url.password || url.search || url.hash || (!loopback && !privateTailscale)) {
    throw Error("SCIN verification only permits loopback HTTP or private Tailscale HTTPS");
  }
  const output = path.resolve(outputArg);
  await mkdir(output, { mode: 0o700 });
  let stage = "manifest validation";
  const started = performance.now();
  try {
    const manifestPath = path.resolve(manifestArg);
    const manifestDir = path.dirname(manifestPath);
    const cases = z.array(caseSchema).min(1).max(10).parse(JSON.parse(await readFile(manifestPath, "utf8")));
    const selectedCase = requestedCase ? cases.find(item => item.id === requestedCase) : cases[0];
    if (!selectedCase) throw Error("Requested SCIN case is not in the manifest");
    const provenance = provenanceSchema.parse(JSON.parse(await readFile(path.join(manifestDir, "scin-provenance.json"), "utf8")));
    const source = provenance.cases.find(item => item.testId === selectedCase.id);
    if (!source) throw Error("SCIN attribution is missing");
    const imagePath = path.resolve(manifestDir, selectedCase.imagePath);
    if (path.relative(manifestDir, imagePath).startsWith("..")) throw Error("SCIN image path escapes the private dataset directory");
    const original = await readFile(imagePath);
    if (digest(original) !== source.imageSha256) throw Error("SCIN image digest does not match provenance");

    stage = "image decoding";
    const assessed = await assessImage(original);
    const transcript = variant === "image-only" ? null : {
      id: `${selectedCase.id}-transcript`, text: selectedCase.transcript, start: 0, end: selectedCase.transcript.length,
    };
    const request: ImageRequest = {
      image: { id: `${selectedCase.id}-image`, bytes: assessed.normalized, mime: assessed.mime, width: assessed.width, height: assessed.height, quality: assessed.quality },
      transcript, context: selectedCase.context,
    };
    stage = "MedGemma adapter request";
    const result = await medgemmaProvider().analyze(request);
    const report = {
      purpose: "Local SCIN integration verification; not clinical validation",
      dataset: { name: "SCIN", source: provenance.source, license: provenance.license, caseId: source.caseId,
        imageObject: source.imageObject, originalSha256: source.imageSha256, normalizedSha256: digest(assessed.normalized) },
      variant, promptVersion: PROMPT_VERSION, status: "success", clinicalMetrics: null,
      validation: { imageDecoding: "passed", modelGeneration: "passed", jsonParsing: "passed",
        pythonSchema: "passed", pythonEvidence: "passed", typeScriptSchema: "passed", typeScriptEvidence: "passed",
        sourceAttribution: result.analysis.imageSourceId === request.image.id ? "passed" : "failed" },
      context: selectedCase.context, transcriptProvided: transcript !== null, sourceQuality: assessed.quality,
      latencyMs: performance.now() - started, result,
    };
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
    console.log(`${selectedCase.id} ${variant}: full inference and validation passed in ${Math.round(report.latencyMs)} ms`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "SCIN integration verification failed";
    const report = { purpose: "Local SCIN integration verification; not clinical validation", variant,
      status: "failed", failedStage: failureStage(reason, stage), reason, latencyMs: performance.now() - started,
      clinicalMetrics: null };
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
    console.error(`${variant}: failed during ${report.failedStage}; no fallback or clinical score`);
    process.exitCode = 1;
  }
}

main().catch(() => { console.error("SCIN verification could not start. Check arguments and use a new private output directory."); process.exitCode = 1; });
