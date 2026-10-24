import type { ClinicalContext, ImageResult } from "./image-analysis/contracts";
import { formatChartContext, type ChartContext, type EhrReceipt } from "./ehr/types";
import type { TranscriptArtifact, TranscriptEvidence, TranscriptRoles } from "./transcription/types";
export type Specialty = ClinicalContext["specialty"];
export type Section = "S" | "O" | "A" | "P";
export type Evidence = { sourceId: string; quote: string; role?: "visual" | "context" | "spoken" | "clinician"; transcript?: TranscriptEvidence };
export type Quality = { status: "usable" | "limited" | "retake"; reasons: string[]; guidance: string[] };
export type Source = {
  id: string; kind: "image" | "audio" | "transcript" | "clinician";
  label: string; text?: string; mediaId?: string; start?: number; end?: number;
  transcriptArtifactId?: string;
  mime?: string;
  quality?: Quality; width?: number; height?: number; createdAt: string;
};
export type Finding = {
  id: string; section: Section; text: string; origin: "visual" | "spoken" | "clinician";
  certainty: "observed" | "uncertain" | "not_assessable";
  limitation: string; evidence: Evidence[];
  review: "pending" | "accepted" | "rejected";
  reviewNote: string; originalText: string;
  category?: string; analysisRunId?: string; provider?: string;
};
export type Conflict = { id: string; findingIds: string[]; description: string; resolution: string };
export type Encounter = {
  id: string; owner: string; patientId: string; specialty: Specialty; createdAt: string;
  revision: number; consent: boolean; patientConfirmed: boolean;
  sources: Source[]; findings: Finding[]; conflicts: Conflict[];
  analysis: "none" | "running" | "ready" | "failed"; analysisError: string;
  model: string; promptVersion: string;
  clinicalContext?: ClinicalContext;
  imageAnalyses?: (ImageResult & { runId: string; provider: string })[];
  analysisWarnings?: string[]; warningsAcknowledged?: boolean;
  activeAnalysis?: { id: string; expiresAt: number };
  chartContext?: ChartContext;
  ehrReceipts?: EhrReceipt[];
  transcripts?: TranscriptArtifact[];
  transcriptRoles?: TranscriptRoles;
  approval: null | { revision: number; physician: string; at: string; note: string; digest: string };
  export: null | { id: string; at: string; revision: number; mode: "simulation" };
  audit: { at: string; action: string; revision: number }[];
};
export const PATIENTS = [
  { id: "demo-001", name: "Alex Morgan", initials: "AM", age: 34, record: "DEMO-001", detail: "Skin observation", specialty: "skin" as Specialty },
  { id: "demo-002", name: "Jordan Lee", initials: "JL", age: 27, record: "DEMO-002", detail: "Throat observation", specialty: "throat" as Specialty },
];
export const sectionLabels: Record<Section, string> = { S: "Subjective", O: "Objective", A: "Assessment", P: "Plan" };
const transcriptTimestamp = (milliseconds: number) => {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

export function reviewBlockers(e: Encounter): string[] {
  const errors: string[] = [];
  if (!e.patientConfirmed) errors.push("Confirm the patient and encounter.");
  if (!e.consent) errors.push("Confirm capture and processing consent.");
  if (e.chartContext && e.chartContext.patientId !== e.patientId) errors.push("Chart context must belong to this patient.");
  if (e.analysis === "running") errors.push("Wait for analysis to finish.");
  if (e.analysisWarnings?.length && !e.warningsAcknowledged) errors.push("Acknowledge incomplete analysis and its limitations before approval.");
  if (!e.findings.some(f => f.review === "accepted")) errors.push("Accept at least one supported finding.");
  if (e.findings.some(f => f.review === "pending")) errors.push("Review every proposed finding.");
  if (e.conflicts.some(c => !c.resolution.trim())) errors.push("Resolve each conflict with a written explanation.");
  const ids = new Set(e.sources.map(s => s.id));
  const acceptedSpoken = e.findings.filter(f => f.review === "accepted" && f.origin === "spoken");
  const labeledArtifacts = (e.transcripts || []).filter(artifact => artifact.settings.speakerLabels && new Set(artifact.utterances.map(utterance => utterance.speaker).filter(speaker => speaker !== "UNKNOWN")).size > 1);
  if (acceptedSpoken.some(f => f.evidence.some(v => labeledArtifacts.some(artifact => artifact.id === v.transcript?.artifactId))) &&
      (!e.transcriptRoles || e.transcriptRoles.patientSpeaker === e.transcriptRoles.clinicianSpeaker || !labeledArtifacts.some(artifact => artifact.id === e.transcriptRoles?.artifactId))) {
    errors.push("Confirm which transcript speaker is the patient and which is the clinician.");
  }
  for (const f of e.findings.filter(f => f.review === "accepted")) {
    if (!f.evidence.length || f.evidence.some(v => !ids.has(v.sourceId) || !v.quote.trim() || (e.sources.find(s => s.id === v.sourceId)?.kind === "transcript" && !e.sources.find(s => s.id === v.sourceId)?.text?.includes(v.quote)))) errors.push("A finding has missing source evidence.");
    if (f.certainty !== "observed" && !f.reviewNote.trim()) errors.push("Explain how uncertain or unassessable findings were handled.");
    if (f.text !== f.originalText && !f.reviewNote.trim()) errors.push("Explain edited findings.");
    if (f.evidence.some(v => e.sources.find(s => s.id === v.sourceId)?.quality?.status === "retake")) errors.push("Reject findings from images marked for retake; capture a better image.");
    if (f.evidence.some(v => e.sources.find(s => s.id === v.sourceId)?.quality?.status === "limited") && !f.reviewNote.trim()) errors.push("Document the limitation of findings from limited-quality images.");
  }
  return [...new Set(errors)];
}

export function composeNote(e: Encounter, approvedOnly = true): string {
  const soap = (["S", "O", "A", "P"] as Section[]).map(section => {
    const findings = e.findings.filter(f => f.section === section && (approvedOnly ? f.review === "accepted" : f.review !== "rejected"));
    const lines = findings.map(f => {
      const evidence = f.evidence.map(v => {
        if (!v.transcript) return v.sourceId;
        const mappedRole = e.transcriptRoles?.artifactId === v.transcript.artifactId
          ? v.transcript.speaker === e.transcriptRoles.patientSpeaker ? "patient" : v.transcript.speaker === e.transcriptRoles.clinicianSpeaker ? "clinician" : "unmapped speaker"
          : `unconfirmed ${v.transcript.speaker}`;
        return `${v.sourceId}; ${mappedRole}; ${transcriptTimestamp(v.transcript.startMs)}–${transcriptTimestamp(v.transcript.endMs)}`;
      }).join(", ");
      return `${!approvedOnly && f.review === "pending" ? "[PENDING REVIEW] " : ""}${f.certainty === "observed" ? "" : `[${f.certainty.replaceAll("_", " ")}] `}${f.text}${f.limitation ? ` (Limitation: ${f.limitation})` : ""} [${evidence}]${f.reviewNote ? `\nReviewer: ${f.reviewNote}` : ""}`;
    });
    return `${sectionLabels[section].toUpperCase()}\n${lines.join("\n") || "Not documented."}`;
  }).join("\n\n");
  return [formatChartContext(e.chartContext), soap].filter(Boolean).join("\n\n");
}
