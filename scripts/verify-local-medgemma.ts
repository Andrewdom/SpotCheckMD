// Real local inference on a generated non-patient diagram. No clinical scoring.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { assessImage } from "../lib/analysis";
import { medgemmaProvider } from "../lib/image-analysis/providers";
import { PROMPT_VERSION, type ImageRequest } from "../lib/image-analysis/contracts";

async function main() {
  const [output, flag] = process.argv.slice(2);
  if (!output || flag !== "--run-live") throw Error("Supply a new output directory and --run-live");
  const url = new URL(process.env.MEDGEMMA_URL || "");
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw Error("This verification only permits the local service");
  await mkdir(output, { mode: 0o700 }); // Refuse to overwrite a previous run.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="#eeeeee"/><circle cx="270" cy="360" r="120" fill="#cc6633"/><rect x="460" y="240" width="180" height="240" fill="#3366aa"/><text x="100" y="650" font-size="24">SYNTHETIC DIAGRAM - NO PATIENT</text></svg>');
  const source = await assessImage(await sharp(svg).jpeg().toBuffer());
  await writeFile(path.join(output, "synthetic-diagram.jpg"), source.normalized, { flag: "wx", mode: 0o600 });
  const context: ImageRequest["context"] = { specialty: "general", imageType: "other_2d", anatomicalLocation: "", physicianContext: "This is a synthetic geometric diagram, not a patient photograph. Do not infer anatomy or medical findings." };
  const text = "Clinician: This is a synthetic diagram with colored shapes. Fictional patient: I have no pain.";
  let failed = false;
  for (const variant of ["image-only", "image-and-transcript"]) {
    const started = performance.now();
    const input: ImageRequest = { image: { id: "synthetic-image", bytes: source.normalized, quality: source.quality }, context,
      transcript: variant === "image-only" ? null : { id: "synthetic-transcript", text, start: 0, end: text.length } };
    try {
      const result = await medgemmaProvider().analyze(input);
      await writeFile(path.join(output, `${variant}.json`), JSON.stringify({ purpose: "Synthetic technical verification, not clinical validation", promptVersion: PROMPT_VERSION, context, transcript: input.transcript, result }, null, 2), { flag: "wx", mode: 0o600 });
      console.log(`${variant}: validated real response in ${Math.round(performance.now() - started)} ms`);
    } catch (error) {
      failed = true;
      // Provider exceptions are already redacted; never retain raw service bodies.
      const reason = error instanceof Error ? error.message : "Local inference failed";
      await writeFile(path.join(output, `${variant}.json`), JSON.stringify({ status: "failed", reason, latencyMs: performance.now() - started, clinicalMetrics: null }), { flag: "wx", mode: 0o600 });
      console.error(`${variant}: failed; no fallback or clinical score`);
    }
  }
  if (failed) process.exitCode = 1;
}
main().catch(() => { console.error("Local verification could not run. Check local configuration and use a new output directory."); process.exitCode = 1; });
