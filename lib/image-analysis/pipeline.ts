import { randomBytes } from "node:crypto";
import type { Encounter, Finding, Source, Conflict } from "../domain";
import type { Suggested } from "../analysis";
import { transcriptionKeyterms } from "../transcription/keyterms";
import { locateTranscriptEvidence, type TranscriptArtifact, type TranscriptionProvider } from "../transcription/types";
import { AppError } from "../store";
import { validateImageAnalysis, transcriptWindows, type ImageProvider, type ImageResult } from "./contracts";
const uid = () => randomBytes(16).toString("hex");
const publicMedGemmaError = (error: unknown) => error instanceof AppError && /^MedGemma\b/.test(error.message) && /no fallback was used\.$/i.test(error.message) && error.message.length <= 300 ? error.message : null;
export type PipelineDeps = {
  ensureCurrent?: () => Promise<unknown>;
  provider: () => ImageProvider;
  transcriber: () => TranscriptionProvider;
  document: (transcript: { id: string; text: string }, specialty: string) => Promise<Suggested[]>;
  readMedia: (source: Source) => Promise<Buffer>;
};
export async function analyzeEncounter(snapshot: Encounter, runId: string, deps: PipelineDeps) {
  const warnings: string[] = [];
  const newSources: Source[] = [];
  const newTranscripts: TranscriptArtifact[] = [];
  const findings: Finding[] = [];
  const conflicts: Conflict[] = [];
  const analyses: (ImageResult & { runId: string; provider: string })[] = [];
  const context = snapshot.clinicalContext || { specialty: snapshot.specialty, imageType: "clinical_photo" as const, anatomicalLocation: "", physicianContext: "" };
  const audio = snapshot.sources.find(s => s.kind === "audio");
  let transcript = snapshot.sources.findLast(s => s.kind === "transcript" && (!audio || s.mediaId === audio.mediaId));
  if (audio && !transcript) {
    await deps.ensureCurrent?.();
    try {
      const bytes = await deps.readMedia(audio);
      const transcriptSourceId = uid();
      const artifact = await deps.transcriber().transcribe({ bytes, mime: audio.mime || "audio/webm", audioSourceId: audio.id, transcriptSourceId, keyterms: transcriptionKeyterms(snapshot) });
      if (!artifact.text.trim() || artifact.transcriptSourceId !== transcriptSourceId || artifact.audioSourceId !== audio.id) throw new Error("Invalid transcript artifact");
      transcript = { id: transcriptSourceId, kind: "transcript", label: "Unverified timestamped transcript", text: artifact.text, mediaId: audio.mediaId, transcriptArtifactId: artifact.id, createdAt: artifact.finalizedAt };
      newSources.push(transcript);
      newTranscripts.push(artifact);
    } catch { warnings.push("Audio transcription failed. Images were processed without transcript context; no spoken findings were invented. Retry or document manually."); }
  }
  let windows: ReturnType<typeof transcriptWindows> = [];
  let contextFailed = false;
  if (transcript?.text) {
    try { windows = transcriptWindows({ id: transcript.id, text: transcript.text }); }
    catch { contextFailed = true; warnings.push("Transcript context could not be safely windowed. No text was truncated. Image analysis was skipped; review the transcript and use shorter recordings."); }
    for (const window of windows) {
      await deps.ensureCurrent?.();
      try {
        for (const s of await deps.document({ id: window.id, text: window.text }, context.specialty)) {
          // Validate again at the orchestration boundary, including injected adapters.
          if (!s.sourceIds.length || s.sourceIds.length !== s.evidenceQuotes.length || s.sourceIds.some(id => id !== window.id) || s.evidenceQuotes.some(q => !q.trim() || !window.text.includes(q))) throw new Error("Invalid documentation evidence");
          const limitation = [s.limitation, ["A", "P"].includes(s.section) ? "Spoken assessment/plan: verify clinician attribution; not an image-derived recommendation." : ""].filter(Boolean).join(" ");
          const artifact = [...(snapshot.transcripts || []), ...newTranscripts].find(item => item.id === transcript?.transcriptArtifactId);
          findings.push({ id: uid(), section: s.section, text: s.text, originalText: s.text, origin: "spoken", certainty: ["A", "P"].includes(s.section) ? "uncertain" : s.certainty, limitation, evidence: s.sourceIds.map((sourceId, i) => ({ sourceId, quote: s.evidenceQuotes[i], role: "spoken", transcript: locateTranscriptEvidence(artifact, s.evidenceQuotes[i]) })), review: "pending", reviewNote: "", analysisRunId: runId, provider: artifact ? `${artifact.provider}-transcript + openai-documentation` : "openai-documentation" });
        }
      } catch { warnings.push(`Transcript documentation failed for characters ${window.start}–${window.end}. The transcript remains available for manual review.`); }
    }
  }
  const images = snapshot.sources.filter(s => s.kind === "image");
  if (images.length && !contextFailed) {
    let provider: ImageProvider | undefined;
    try { provider = deps.provider(); }
    catch (error) { warnings.push(publicMedGemmaError(error) || "Image provider configuration is invalid. No fallback was used."); }
    if (provider) for (const image of images) {
      let bytes: Buffer;
      try { bytes = await deps.readMedia(image); }
      catch { warnings.push(`${image.label}: image could not be loaded.`); continue; }
      for (const window of windows.length ? windows : [null]) {
        await deps.ensureCurrent?.();
        try {
          const mime = image.mime === "image/png" ? "image/png" as const : "image/jpeg" as const;
          const input = { image: { id: image.id, bytes, mime, width: image.width, height: image.height, quality: image.quality || { status: "limited" as const, reasons: ["Quality unavailable"], guidance: [] } }, transcript: window, context };
          const result = await provider.analyze(input);
          result.analysis = validateImageAnalysis(result.analysis, input);
          analyses.push({ ...result, runId, provider: provider.id, inputContext: structuredClone(context), inputTranscriptSourceId: window?.id || null });
          const ids = new Map<string, string>();
          for (const c of result.analysis.characteristics) {
            const id = uid(); ids.set(c.id, id);
            findings.push({ id, section: "O", category: c.category, text: c.description, originalText: c.description, origin: "visual", certainty: c.certainty, limitation: [c.limitations, ...result.analysis.limitations, !window ? "No encounter transcript was available for this analysis." : ""].filter(Boolean).join(" "), evidence: [{ sourceId: image.id, quote: c.evidence.visibleRegion, role: "visual" }, ...(c.evidence.transcriptSourceId && c.evidence.transcriptQuote ? [{ sourceId: c.evidence.transcriptSourceId, quote: c.evidence.transcriptQuote, role: "context" as const }] : [])], review: "pending", reviewNote: "", analysisRunId: runId, provider: provider.id });
          }
          for (const c of result.analysis.conflicts) conflicts.push({ id: uid(), findingIds: c.characteristicIds.map(id => ids.get(id)!), description: `${c.description}\nTranscript context [${c.transcriptSourceId}]: “${c.transcriptQuote}”`, resolution: "" });
          if (!result.analysis.characteristics.length) warnings.push(`${image.label}: no visual characteristics were assessable. ${result.analysis.limitations.join(" ")}`);
        } catch (error) {
          const fixedMedGemmaError = publicMedGemmaError(error);
          warnings.push(`${image.label}${window ? ` (transcript ${window.start}–${window.end})` : ""}: ${fixedMedGemmaError || `${provider.id} analysis failed, timed out, or returned invalid evidence. No fallback was used; this image/context needs manual review or retry.`}`);
        }
      }
    }
  }
  // Remove only exact duplicates introduced by overlapping transcript windows.
  // Preserve every conflict by remapping its references to retained finding IDs.
  const unique = new Map<string, Finding>(), remap = new Map<string, string>();
  for (const f of findings) {
    const key = JSON.stringify([f.origin, f.section, f.text, f.certainty, f.limitation, f.evidence]);
    const kept = unique.get(key);
    if (kept) remap.set(f.id, kept.id); else unique.set(key, f);
  }
  for (const c of conflicts) c.findingIds = c.findingIds.map(id => remap.get(id) || id);
  // Retain the existing conservative laterality warning; it is not anatomical inference.
  for (const visual of unique.values()) if (visual.origin === "visual") for (const spoken of unique.values()) if (spoken.origin === "spoken") {
    if ((/\bleft\b/i.test(visual.text) && /\bright\b/i.test(spoken.text)) || (/\bright\b/i.test(visual.text) && /\bleft\b/i.test(spoken.text))) conflicts.push({ id: uid(), findingIds: [visual.id, spoken.id], description: "Possible left/right discrepancy. Verify anatomy and attribution; different body sites may explain this warning.", resolution: "" });
  }
  return { newSources, newTranscripts, findings: [...unique.values()], conflicts, analyses, warnings: [...new Set(warnings)] };
}
