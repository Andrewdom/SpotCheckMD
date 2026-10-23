import sharp from "sharp";
import type { Quality } from "./domain";
import { AppError } from "./store";

export async function assessImage(bytes: Buffer): Promise<{ quality: Quality; width: number; height: number; normalized: Buffer }> {
  const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: "error" });
  const meta = await image.metadata();
  if (!meta.width || !meta.height || !["jpeg", "png"].includes(meta.format || "")) throw new AppError(400, "Use a readable JPG or PNG photo.");
  const { data, info } = await image.clone().rotate().resize({ width: 256, height: 256, fit: "inside" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let mean = 0, gradient = 0, count = 0;
  for (let y = 1; y < info.height - 1; y++) for (let x = 1; x < info.width - 1; x++) {
    const i = y * info.width + x;
    mean += data[i]; gradient += Math.abs(4 * data[i] - data[i - 1] - data[i + 1] - data[i - info.width] - data[i + info.width]); count++;
  }
  mean /= count || 1; gradient /= count || 1;
  const reasons: string[] = [], guidance: string[] = [];
  if (Math.min(meta.width, meta.height) < 640) { reasons.push("Low source resolution"); guidance.push("Retake closer with the subject in focus; preserve the full area."); }
  if (mean < 42) { reasons.push("Image appears dark"); guidance.push("Add even light without using a harsh flash."); }
  if (mean > 220) { reasons.push("Image appears overexposed"); guidance.push("Reduce glare and avoid direct flash."); }
  if (gradient < 9) { reasons.push("Image may lack sharp detail"); guidance.push("Hold the phone steady, tap to focus, then retake."); }
  const status: Quality["status"] = Math.min(meta.width, meta.height) < 400 || mean < 25 || mean > 240 ? "retake" : reasons.length ? "limited" : "usable";
  const normalized = await image.clone().rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  return { width: meta.width, height: meta.height, normalized, quality: { status, reasons, guidance } };
}

export type Suggested = { section: "S" | "O" | "A" | "P"; text: string; certainty: "observed" | "uncertain" | "not_assessable"; limitation: string; sourceIds: string[]; evidenceQuotes: string[] };
const schema = {
  type: "object", additionalProperties: false,
  properties: { findings: { type: "array", items: { type: "object", additionalProperties: false,
    properties: { section: { type: "string", enum: ["S", "O", "A", "P"] }, text: { type: "string" }, certainty: { type: "string", enum: ["observed", "uncertain", "not_assessable"] }, limitation: { type: "string" }, sourceIds: { type: "array", items: { type: "string" } }, evidenceQuotes: { type: "array", items: { type: "string" } } },
    required: ["section", "text", "certainty", "limitation", "sourceIds", "evidenceQuotes"] } } },
  required: ["findings"]
};

async function api(path: string, body: BodyInit, contentType?: string) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new AppError(503, "OpenAI API access is not configured.");
  const response = await fetch(`https://api.openai.com/v1/${path}`, { method: "POST", headers: { Authorization: `Bearer ${key}`, ...(contentType ? { "Content-Type": contentType } : {}) }, body, signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new AppError(response.status === 429 ? 503 : 502, response.status === 429 ? "The API returned 429 (rate limit or quota). Check the project’s limits; no findings were added." : `AI processing failed (${response.status}). Check API access and retry with synthetic data.`);
  return response.json();
}
export async function transcribe(bytes: Buffer, mime: string): Promise<string> {
  const form = new FormData();
  form.append("model", "gpt-transcribe");
  const ext = mime.includes("webm") ? "webm" : mime.includes("wav") ? "wav" : mime.includes("ogg") ? "ogg" : mime.includes("mpeg") ? "mp3" : "mp4";
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), `encounter.${ext}`);
  const data = await api("audio/transcriptions", form);
  return String(data.text || "").slice(0, 20000);
}
export async function suggest(images: { id: string; bytes: Buffer; quality: Quality }[], transcript: { id: string; text: string } | null, specialty: string): Promise<Suggested[]> {
  const content: object[] = [{ type: "input_text", text: `Synthetic demonstration, ${specialty} encounter. Transcript source ${transcript?.id || "none"}: ${transcript?.text || "No audio"}. Produce brief atomic SOAP documentation suggestions with exact valid sourceIds and evidenceQuotes aligned by array index. For transcript, quote exact short verbatim substrings. For images, evidenceQuotes must be short descriptions of directly visible regions, never invented measurements. Do not infer a diagnosis, malignancy, a drug, a treatment, or absent symptom from a photo. Do not assert speaker identity. Do not transfer statements between patient and clinician when attribution is unclear. Put visual observations in O, transcript-based history in S, and omit A/P unless explicitly said in the transcript (mark attribution uncertainty). If resolution, lighting or view limits an observation mark uncertain and state the limitation. If evidence is missing, omit the finding. Max 10 findings.` }];
  for (const image of images) {
    content.push({ type: "input_text", text: `The next image is source ${image.id}. Automated quality: ${image.quality.status}. Warnings: ${image.quality.reasons.join(", ") || "none"}.` });
    content.push({ type: "input_image", image_url: `data:image/jpeg;base64,${image.bytes.toString("base64")}`, detail: "high" });
  }
  const data = await api("responses", JSON.stringify({ model: "gpt-4o", store: false, instructions: "You are a cautious clinical documentation assistant for synthetic data. Suggest only evidence-grounded, reviewable descriptions. Never diagnose from an image. Never claim an unsupported examination result. The physician must review all output.", input: [{ role: "user", content }], text: { format: { type: "json_schema", name: "evidence_findings", strict: true, schema } } }), "application/json");
  const output = (data.output || []).flatMap((v: { content?: { type: string; text?: string }[] }) => v.content || []).find((v: { type: string }) => v.type === "output_text")?.text;
  if (!output) throw new AppError(502, "The AI did not return usable findings. Nothing was added to the chart.");
  const parsed = JSON.parse(output) as { findings: Suggested[] };
  const valid = new Set([...images.map(i => i.id), ...(transcript ? [transcript.id] : [])]);
  return parsed.findings.slice(0, 10).filter(f => f.text && f.sourceIds?.length && f.sourceIds.length === f.evidenceQuotes?.length && f.sourceIds.every(id => valid.has(id)) && f.evidenceQuotes.every(Boolean) && f.sourceIds.every((id, i) => id !== transcript?.id || transcript.text.toLowerCase().includes(f.evidenceQuotes[i].trim().toLowerCase()))).map(f => ({ ...f, text: f.text.slice(0, 500), limitation: f.limitation.slice(0, 250), evidenceQuotes: f.evidenceQuotes.map(q => q.slice(0, 250)) }));
}
