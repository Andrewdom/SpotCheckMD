import type { StoredChart } from "./ehr/types";

export function assignLegacyCharts(charts: StoredChart[], physicianId: string): StoredChart[] {
  const assigned = new Map<string, StoredChart>();
  for (const chart of charts) {
    if (!chart.patientId) throw new Error("Legacy chart is missing its patient identifier.");
    const existing = assigned.get(chart.patientId);
    if (!existing) {
      assigned.set(chart.patientId, { ...structuredClone(chart), owner: physicianId });
      continue;
    }
    existing.version = Math.max(existing.version, chart.version);
    const notes = new Map(existing.notes.map(note => [note.id, note]));
    for (const note of chart.notes) {
      const prior = notes.get(note.id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(note)) throw new Error(`Legacy charts contain conflicting note ${note.id}.`);
      if (!prior) { existing.notes.push(structuredClone(note)); notes.set(note.id, note); }
    }
  }
  return [...assigned.values()];
}
