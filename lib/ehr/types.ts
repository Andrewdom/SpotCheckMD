import type { ImageResult } from "../image-analysis/contracts";

export type ChartCategory = "condition" | "medication" | "allergy" | "history" | "vital" | "lab" | "note";
export type ChartRecord = {
  id: string; category: ChartCategory; title: string; text: string;
  recordedAt: string; source: string; status: string;
  details?: { label: string; value: string }[];
};
export type PatientProfile = {
  id: string; name: string; mrn: string; dateOfBirth: string;
  recordedSex: string; genderIdentity: string; language: string;
  phone: string; address: string; emergencyContact: string;
  primaryClinician: string; pharmacy: string; insurance: string;
  allergyStatus: "documented" | "unknown" | "none_known";
};
export type ChartContext = {
  version: 1; patientId: string; chartVersion: number; importedAt: string;
  items: (ChartRecord & { confirmedToday: boolean })[];
};
export type EhrReceipt = {
  id: string; at: string; revision: number; mode: "simulation";
  patientId: string; encounterId: string; digest: string; amendsId?: string;
};
export type ChartNote = {
  id: string; encounterId: string; patientId: string; encounterDate: string;
  approvedAt: string; savedAt: string; physician: string;
  text: string; digest: string; revision: number; amendsId?: string;
  chartContext?: ChartContext;
  provenance?: { model: string; promptVersion: string; imageRuns: { runId: string; provider: string; model: string; modelRevision: string; runtime?: ImageResult["runtime"] }[] };
};
export type StoredChart = { owner: string; patientId: string; version: number; notes: ChartNote[] };
export type PatientChart = {
  mode: "simulation"; patient: PatientProfile; version: number;
  refreshedAt: string; records: ChartRecord[]; notes: ChartNote[];
};

export function patientAge(dateOfBirth: string, at = new Date()): number {
  const [year, month, day] = dateOfBirth.split("-").map(Number);
  return at.getFullYear() - year - (at.getMonth() + 1 < month || (at.getMonth() + 1 === month && at.getDate() < day) ? 1 : 0);
}

export function formatChartContext(context?: ChartContext): string {
  if (!context?.items.length) return "";
  return "REVIEWED CHART BACKGROUND\n" + context.items.map(item =>
    `${item.title} — ${item.text}\nSource: ${item.source}; recorded ${item.recordedAt}; status: ${item.status}; record ${item.id}. ${item.confirmedToday ? "Clinician marked this history confirmed during this visit." : "Historical chart entry; not confirmed during this visit."}`
  ).join("\n\n");
}
