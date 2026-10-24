import { z } from "zod";
import { composeNote, reviewBlockers, type Encounter } from "../domain";
import { AppError, digest, uid } from "../store";
import { patientFixture, recordFixtures } from "./fixtures";
import type { ChartContext, ChartNote, EhrReceipt, PatientChart, StoredChart } from "./types";

type ChartDatabase = { ehrCharts?: StoredChart[] };
export interface EhrAdapter {
  readChart(db: ChartDatabase, owner: string, patientId: string): PatientChart;
  submitApprovedNote(db: ChartDatabase, encounter: Encounter): EhrReceipt;
}
function storedChart(db: ChartDatabase, owner: string, patientId: string): StoredChart {
  if (!patientFixture(patientId)) throw new AppError(404, "Demo patient chart not found.");
  db.ehrCharts ??= [];
  let chart = db.ehrCharts.find(c => c.owner === owner && c.patientId === patientId);
  if (!chart) { chart = { owner, patientId, version: 1, notes: [] }; db.ehrCharts.push(chart); }
  return chart;
}
export const demoEhr: EhrAdapter = {
  readChart(db, owner, patientId) {
    const chart = storedChart(db, owner, patientId);
    return {
      mode: "simulation", patient: structuredClone(patientFixture(patientId)!), version: chart.version,
      refreshedAt: new Date().toISOString(), notes: structuredClone(chart.notes),
      records: [...recordFixtures(patientId), ...chart.notes.map(note => ({
        id: note.id, category: "note" as const, title: note.amendsId ? "Approved visit amendment" : "Approved encounter note",
        text: note.text, recordedAt: note.encounterDate, source: `Demo EHR · ${note.physician}`, status: "Approved in demo",
      }))],
    };
  },
  submitApprovedNote(db, encounter) {
    const approval = encounter.approval;
    if (!approval || approval.revision !== encounter.revision || digest(composeNote(encounter)) !== approval.digest || digest(approval.note) !== approval.digest || reviewBlockers(encounter).length) {
      throw new AppError(400, "Review and approve the current draft first.");
    }
    const chart = storedChart(db, encounter.owner, encounter.patientId);
    // The record and receipt are committed by the caller's single storage transaction.
    let note = chart.notes.find(n => n.encounterId === encounter.id && n.revision === approval.revision && n.digest === approval.digest);
    if (!note) {
      const previous = chart.notes.findLast(n => n.encounterId === encounter.id);
      note = { id: uid(), patientId: encounter.patientId, encounterId: encounter.id, encounterDate: encounter.createdAt,
        approvedAt: approval.at, savedAt: new Date().toISOString(), physician: approval.physician, text: approval.note,
        digest: approval.digest, revision: approval.revision, ...(previous ? { amendsId: previous.id } : {}),
        provenance: { model: encounter.model, promptVersion: encounter.promptVersion, imageRuns: (encounter.imageAnalyses || []).map(result => ({ runId: result.runId, provider: result.provider, model: result.model, modelRevision: result.modelRevision, ...(result.runtime ? { runtime: structuredClone(result.runtime) } : {}) })) },
        ...(encounter.chartContext ? { chartContext: structuredClone(encounter.chartContext) } : {}) } satisfies ChartNote;
      chart.notes.push(note); chart.version++;
    }
    const receipt: EhrReceipt = { id: note.id, at: note.savedAt, revision: note.revision, mode: "simulation", patientId: note.patientId, encounterId: note.encounterId, digest: note.digest, ...(note.amendsId ? { amendsId: note.amendsId } : {}) };
    encounter.export = receipt;
    encounter.ehrReceipts ??= [];
    if (!encounter.ehrReceipts.some(r => r.id === receipt.id)) {
      encounter.ehrReceipts.push(receipt);
      encounter.audit.push({ at: receipt.at, action: "approved note saved to Demo EHR", revision: receipt.revision });
    }
    return receipt;
  },
};

const selectionSchema = z.object({ chartVersion: z.number().int().positive(), items: z.array(z.object({ id: z.string().min(1).max(100), confirmedToday: z.boolean() }).strict()).max(20) }).strict();
export function selectedChartContext(db: ChartDatabase, encounter: Encounter, input: unknown): ChartContext {
  const parsed = selectionSchema.safeParse(input);
  if (!parsed.success) throw new AppError(400, "Select up to 20 chart records and review their confirmation status.");
  const chart = demoEhr.readChart(db, encounter.owner, encounter.patientId);
  if (chart.version !== parsed.data.chartVersion) throw new AppError(409, "The chart changed. Refresh the chart before saving your selection.");
  const ids = parsed.data.items.map(i => i.id);
  if (new Set(ids).size !== ids.length) throw new AppError(400, "Select each chart record once.");
  const items = parsed.data.items.map(selection => {
    const item = chart.records.find(r => r.id === selection.id);
    if (!item || chart.notes.some(n => n.id === item.id && n.encounterId === encounter.id)) throw new AppError(400, "Choose a prior record belonging to this patient.");
    return { ...item, confirmedToday: selection.confirmedToday };
  });
  if (items.reduce((length, item) => length + item.text.length, 0) > 30000) throw new AppError(400, "Selected history is too long. Choose fewer records; no text was truncated.");
  return { version: 1, patientId: encounter.patientId, chartVersion: chart.version, importedAt: new Date().toISOString(), items };
}
