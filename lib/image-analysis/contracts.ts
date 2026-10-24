import { z } from "zod";
import type { Quality } from "../domain";

const text = (max = 500) => z.string().trim().min(1).max(max);
export const specialties = ["general", "primary_care", "urgent_care", "dermatology", "radiology", "other", "skin", "throat"] as const;
export const contextSchema = z.object({
  specialty: z.enum(specialties),
  imageType: z.enum(["clinical_photo", "radiograph", "other_2d"]),
  anatomicalLocation: z.string().trim().max(200),
  physicianContext: z.string().trim().max(2000),
}).strict();
export type ClinicalContext = z.infer<typeof contextSchema>;
export const imageAnalysisSchema = z.object({
  imageSourceId: text(64), imageType: text(100), specialty: z.enum(specialties),
  anatomicalRegion: z.object({
    value: z.string().trim().max(200), source: z.enum(["image", "transcript", "clinician", "unknown"]),
    visuallyConfirmed: z.boolean(), transcriptQuote: z.string().trim().max(500).nullable(),
  }).strict(),
  characteristics: z.array(z.object({
    id: text(64), category: text(100), description: text(),
    certainty: z.enum(["observed", "uncertain", "not_assessable"]),
    evidence: z.object({ imageSourceId: text(64), visibleRegion: text(), transcriptSourceId: text(64).nullable(), transcriptQuote: text().nullable() }).strict(),
    limitations: z.string().trim().max(500),
  }).strict()).max(10),
  reportedHistory: z.array(z.object({
    description: text(), attribution: z.enum(["patient_report", "clinician_statement", "unknown"]),
    transcriptSourceId: text(64), transcriptQuote: text(), verifiedByCurrentImage: z.literal(false),
  }).strict()).max(10),
  conflicts: z.array(z.object({
    description: text(), characteristicIds: z.array(text(64)).min(1).max(10),
    transcriptSourceId: text(64), transcriptQuote: text(),
  }).strict()).max(10),
  limitations: z.array(text()).max(10), requiresPhysicianReview: z.literal(true),
}).strict();
export type ImageAnalysis = z.infer<typeof imageAnalysisSchema>;
export type TranscriptContext = { id: string; text: string; start: number; end: number };
export type ImageInput = { id: string; bytes: Buffer; quality: Quality };
export type ImageRequest = { image: ImageInput; transcript: TranscriptContext | null; context: ClinicalContext };
export type ImageResult = { inputContext?: ClinicalContext; inputTranscriptSourceId?: string | null; analysis: ImageAnalysis; model: string; modelRevision: string; latencyMs: number; contextRange: { start: number; end: number } | null };
export type ImageProvider = { id: string; analyze(input: ImageRequest): Promise<ImageResult> };
export const PROMPT_VERSION = "contextual-image-v1";

export function validateImageAnalysis(value: unknown, request: ImageRequest): ImageAnalysis {
  const result = imageAnalysisSchema.parse(value);
  const transcript = request.transcript;
  const quote = (id: string | null, words: string | null) => {
    if (!transcript || id !== transcript.id || !words?.trim() || !transcript.text.includes(words)) throw new Error("Invalid transcript evidence");
  };
  if (result.imageSourceId !== request.image.id || result.specialty !== request.context.specialty) throw new Error("Mismatched image or specialty");
  const ids = new Set<string>();
  for (const c of result.characteristics) {
    if (ids.has(c.id) || c.evidence.imageSourceId !== request.image.id) throw new Error("Invalid image evidence");
    ids.add(c.id);
    if (c.evidence.transcriptSourceId !== null || c.evidence.transcriptQuote !== null) quote(c.evidence.transcriptSourceId, c.evidence.transcriptQuote);
    if (c.certainty !== "observed" && !c.limitations) throw new Error("Uncertainty requires a limitation");
  }
  for (const h of result.reportedHistory) quote(h.transcriptSourceId, h.transcriptQuote);
  for (const c of result.conflicts) {
    if (c.characteristicIds.some(id => !ids.has(id))) throw new Error("Invalid conflict finding");
    quote(c.transcriptSourceId, c.transcriptQuote);
  }
  const region = result.anatomicalRegion;
  if (region.source === "transcript") { quote(transcript?.id || null, region.transcriptQuote); if (region.visuallyConfirmed) throw new Error("Transcript is not visual proof"); }
  else if (region.transcriptQuote !== null) throw new Error("Unexpected anatomical quote");
  if (region.source === "clinician" && (!request.context.anatomicalLocation || region.value !== request.context.anatomicalLocation || region.visuallyConfirmed)) throw new Error("Invalid confirmed location");
  if (region.source === "unknown" && (region.value || region.visuallyConfirmed)) throw new Error("Unknown anatomy must remain unknown");
  if (region.source === "image" && (!region.value || !region.visuallyConfirmed)) throw new Error("Invalid visual anatomy");
  return result;
}

/** Every character is covered. Whole sentences/utterances plus an overlapping unit
 * keep negations, laterality and history intact; no keyword ranking or summary. */
export function transcriptWindows(transcript: { id: string; text: string }, budget = 6000): TranscriptContext[] {
  if (!transcript.text.trim()) return [];
  if (transcript.text.length > 100000) throw new Error("Transcript exceeds the 100,000-character demo limit; supply a shorter authorized recording.");
  const boundaries = [...transcript.text.matchAll(/[.!?](?=\s|$)|\n/g)].map(m => m.index! + m[0].length);
  if (boundaries.at(-1) !== transcript.text.length) boundaries.push(transcript.text.length);
  const units = boundaries.map((end, i) => ({ start: i ? boundaries[i - 1] : 0, end }));
  if (!units.length) return [];
  const windows: TranscriptContext[] = [];
  let first = 0;
  while (first < units.length) {
    let last = first;
    if (units[first].end - units[first].start > budget) throw new Error("A transcript utterance exceeds the context limit; review and split it without changing its meaning.");
    while (last + 1 < units.length && units[last + 1].end - units[first].start <= budget) last++;
    const start = first === 0 ? 0 : units[first].start;
    const end = last === units.length - 1 ? transcript.text.length : units[last].end;
    windows.push({ id: transcript.id, text: transcript.text.slice(start, end), start, end });
    first = last > first && last < units.length - 1 ? last : last + 1;
  }
  return windows;
}
