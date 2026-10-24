import type { Encounter } from "../domain";
import { recordFixtures } from "../ehr/fixtures";

export function transcriptionKeyterms(encounter: Encounter) {
  const terms: string[] = [
    encounter.clinicalContext?.specialty || encounter.specialty,
    ...recordFixtures(encounter.patientId)
      .filter(record => ["medication", "condition", "allergy"].includes(record.category) && !/discontinued|resolved/i.test(record.status))
      .map(record => record.title),
  ]
    .map(term => term.replaceAll("_", " ").trim())
    .filter(term => term.length > 1 && term.length <= 50);
  return [...new Set(terms)].slice(0, 100);
}
