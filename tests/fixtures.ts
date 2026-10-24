import type { Encounter, Source } from "../lib/domain";
import type { ImageAnalysis, ImageRequest } from "../lib/image-analysis/contracts";
export const image: Source = { id: "image-1", kind: "image", label: "Photo 1", mediaId: "a".repeat(32), createdAt: "2026-10-23T00:00:00Z", quality: { status: "usable", reasons: [], guidance: [] } };
export const transcript: Source = { id: "transcript-1", kind: "transcript", label: "Unverified transcript", text: "Patient reports no pain in the left forearm. Clinician says no swelling. Change was noticed six months ago.", createdAt: image.createdAt };
export function encounter(sources: Source[] = [image, transcript]): Encounter {
  return { id: "e".repeat(32), owner: "owner", patientId: "demo-001", specialty: "general", createdAt: image.createdAt, revision: 0, consent: true, patientConfirmed: true, sources: structuredClone(sources), findings: [], conflicts: [], analysis: "none", analysisError: "", model: "", promptVersion: "", approval: null, export: null, audit: [] };
}
export function request(): ImageRequest { return { image: { id: image.id, bytes: Buffer.from("synthetic"), quality: image.quality! }, transcript: { id: transcript.id, text: transcript.text!, start: 0, end: transcript.text!.length }, context: { specialty: "general", imageType: "clinical_photo", anatomicalLocation: "", physicianContext: "" } }; }
export function analysis(input = request()): ImageAnalysis {
  return { imageSourceId: input.image.id, specialty: input.context.specialty, imageType: "clinical photograph", anatomicalRegion: { value: "", source: "unknown", visuallyConfirmed: false, transcriptQuote: null }, characteristics: [{ id: "c1", category: "Appearance", description: "Possible visible swelling", certainty: "uncertain", limitations: "The view is limited", evidence: { imageSourceId: input.image.id, visibleRegion: "central area", transcriptSourceId: input.transcript?.id || null, transcriptQuote: input.transcript?.text.includes("Clinician says no swelling.") ? "Clinician says no swelling." : input.transcript?.text.trim() || null } }], reportedHistory: [], conflicts: [], limitations: [], requiresPhysicianReview: true };
}
