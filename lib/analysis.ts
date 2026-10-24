import sharp from "sharp";
import { z } from "zod";
import type { Quality } from "./domain";
import { AppError } from "./store";

const mib = 1024 * 1024;
function configuredInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new AppError(503, `${name} must be an integer between ${minimum} and ${maximum}.`);
  return value;
}
export const imageUploadLimitBytes = () => configuredInteger("SPOTCHECK_IMAGE_UPLOAD_MAX_MB", 50, 1, 200) * mib;
export const imagePixelLimit = () => configuredInteger("SPOTCHECK_IMAGE_MAX_PIXELS", 60_000_000, 1_000_000, 100_000_000);
export const inferenceImageLimitBytes = () => configuredInteger("SPOTCHECK_INFERENCE_IMAGE_MAX_MB", 256, 10, 512) * mib;

export async function assessImage(bytes: Buffer): Promise<{ quality: Quality; width: number; height: number; normalized: Buffer; preview: Buffer; mime: "image/png" }> {
  try {
    const image = sharp(bytes, { limitInputPixels: imagePixelLimit(), failOn: "error" });
    const meta = await image.metadata();
    if (!meta.width || !meta.height || !["jpeg", "png"].includes(meta.format || "")) throw new AppError(415, "Use a readable JPEG or PNG image. HEIC/HEIF is not enabled because decoder support is not consistent across development machines.");
    // Decode once, apply EXIF orientation, strip metadata (Sharp's default), and
    // encode losslessly without changing the oriented pixel dimensions.
    const inference = await image.clone().rotate().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer({ resolveWithObject: true });
    if (inference.data.length > inferenceImageLimitBytes()) throw new AppError(413, `The lossless inference copy exceeds the configured ${Math.round(inferenceImageLimitBytes() / mib)} MB processing limit.`);
    const qualityImage = sharp(inference.data, { limitInputPixels: imagePixelLimit(), failOn: "error" });
    const { data, info } = await qualityImage.clone().resize({ width: 256, height: 256, fit: "inside" }).greyscale().raw().toBuffer({ resolveWithObject: true });
    let mean = 0, gradient = 0, count = 0;
    for (let y = 1; y < info.height - 1; y++) for (let x = 1; x < info.width - 1; x++) {
      const i = y * info.width + x;
      mean += data[i]; gradient += Math.abs(4 * data[i] - data[i - 1] - data[i + 1] - data[i - info.width] - data[i + info.width]); count++;
    }
    mean /= count || 1; gradient /= count || 1;
    const reasons: string[] = [], guidance: string[] = [];
    if (Math.min(inference.info.width, inference.info.height) < 640) { reasons.push("Low source resolution"); guidance.push("Retake closer with the subject in focus; preserve the full area."); }
    if (mean < 42) { reasons.push("Image appears dark"); guidance.push("Add even light without using a harsh flash."); }
    if (mean > 220) { reasons.push("Image appears overexposed"); guidance.push("Reduce glare and avoid direct flash."); }
    if (gradient < 9) { reasons.push("Image may lack sharp detail"); guidance.push("Hold the phone steady, tap to focus, then retake."); }
    const status: Quality["status"] = Math.min(inference.info.width, inference.info.height) < 400 || mean < 25 || mean > 240 ? "retake" : reasons.length ? "limited" : "usable";
    const preview = await qualityImage.clone().resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    return { width: inference.info.width, height: inference.info.height, normalized: inference.data, preview, mime: "image/png", quality: { status, reasons, guidance } };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, "The image could not be decoded safely. Use a valid JPEG or PNG within the configured pixel limit.");
  }
}

export type Suggested = { section: "S" | "O" | "A" | "P"; text: string; certainty: "observed" | "uncertain" | "not_assessable"; limitation: string; sourceIds: string[]; evidenceQuotes: string[] };
const schema = {
  type: "object", additionalProperties: false,
  properties: { findings: { type: "array", items: { type: "object", additionalProperties: false,
    properties: { section: { type: "string", enum: ["S", "O", "A", "P"] }, text: { type: "string" }, certainty: { type: "string", enum: ["observed", "uncertain", "not_assessable"] }, limitation: { type: "string" }, sourceIds: { type: "array", items: { type: "string" } }, evidenceQuotes: { type: "array", items: { type: "string" } } },
    required: ["section", "text", "certainty", "limitation", "sourceIds", "evidenceQuotes"] } } },
  required: ["findings"]
};

export async function api(path: string, body: BodyInit, contentType?: string) {
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
  const text = z.string().trim().min(1).max(100000).safeParse(data.text);
  if (!text.success) throw new AppError(502, "Transcription was empty or exceeded the demo limit; no text was silently truncated.");
  return text.data;
}
export async function suggest(images: { id: string; bytes: Buffer; quality: Quality }[], transcript: { id: string; text: string } | null, specialty: string): Promise<Suggested[]> {
  const content: object[] = [{ type: "input_text", text: `Synthetic demonstration, ${specialty} encounter. Transcript source ${transcript?.id || "none"}: ${transcript?.text || "No audio"}. Produce brief atomic SOAP documentation suggestions with exact valid sourceIds and evidenceQuotes aligned by array index. The recording contains doctor dictation only. Quote one exact short verbatim substring from the transcript. Treat speech as clinician-supplied documentation, not a recording of the patient's voice. Put a patient-reported symptom/history in S only when the doctor explicitly attributes it to the patient; put the doctor's examination observations in O; include A/P only when the doctor explicitly dictates them. Do not invent patient quotes or turn the clinician's description into a patient statement. Never convert qualitative severity into a numeric score. For images, evidenceQuotes must be short descriptions of directly visible regions, never invented measurements. Do not infer a diagnosis, malignancy, a drug, a treatment, or absent symptom from a photo. If resolution, lighting or view limits an observation mark uncertain and state the limitation. If evidence is missing, omit the finding. Max 10 findings.` }];
  for (const image of images) {
    content.push({ type: "input_text", text: `The next image is source ${image.id}. Automated quality: ${image.quality.status}. Warnings: ${image.quality.reasons.join(", ") || "none"}.` });
    content.push({ type: "input_image", image_url: `data:image/jpeg;base64,${image.bytes.toString("base64")}`, detail: "high" });
  }
  const data = await api("responses", JSON.stringify({ model: "gpt-4o", store: false, instructions: "You are a cautious clinical documentation assistant for synthetic data. Suggest only evidence-grounded, reviewable descriptions. Never diagnose from an image. Never claim an unsupported examination result. The physician must review all output.", input: [{ role: "user", content }], text: { format: { type: "json_schema", name: "evidence_findings", strict: true, schema } } }), "application/json");
  const output = (data.output || []).flatMap((v: { content?: { type: string; text?: string }[] }) => v.content || []).find((v: { type: string }) => v.type === "output_text")?.text;
  if (!output) throw new AppError(502, "The AI did not return usable findings. Nothing was added to the chart.");
  const parsed = z.object({ findings: z.array(z.object({
    section: z.enum(["S", "O", "A", "P"]), text: z.string().trim().min(1).max(500),
    certainty: z.enum(["observed", "uncertain", "not_assessable"]), limitation: z.string().max(500),
    sourceIds: z.array(z.string().min(1)).min(1), evidenceQuotes: z.array(z.string().trim().min(1).max(500)).min(1),
  }).strict()).max(10) }).strict().parse(JSON.parse(output));
  const valid = new Set([...images.map(i => i.id), ...(transcript ? [transcript.id] : [])]);
  for (const f of parsed.findings) {
    if (f.sourceIds.length !== f.evidenceQuotes.length || f.sourceIds.some(id => !valid.has(id)) || f.sourceIds.some((id, i) => id === transcript?.id && !transcript.text.includes(f.evidenceQuotes[i]))) throw new AppError(502, "Invalid source evidence in documentation response.");
    if (f.sourceIds.some(id => images.some(image => image.id === id)) && f.section !== "O") throw new AppError(502, "Image-derived assessment or plan was rejected.");
    if ((f.section === "A" || f.section === "P") && (!transcript || !f.sourceIds.includes(transcript.id))) throw new AppError(502, "Assessment/plan requires spoken evidence and physician review.");
  }
  return parsed.findings;
}

export function responseText(data: { output?: { content?: { type: string; text?: string }[] }[] }): string {
  const output = (data.output || []).flatMap(v => v.content || []).find(v => v.type === "output_text")?.text;
  if (!output) throw new AppError(502, "The model returned no usable structured response.");
  return output;
}
