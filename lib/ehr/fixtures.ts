import type { ChartRecord, PatientProfile } from "./types";

// Entirely fictional profiles. Stable IDs keep existing demo encounters compatible.
const profiles: PatientProfile[] = [
  { id: "demo-001", name: "Alex Morgan", mrn: "DEMO-001", dateOfBirth: "1992-04-18", recordedSex: "Female", genderIdentity: "Woman", language: "English", phone: "202-555-0101", address: "101 Example Lane, Demo City", emergencyContact: "Sam Morgan · sibling · 202-555-0102", primaryClinician: "Dr. Avery Chen (demo)", pharmacy: "Example Community Pharmacy", insurance: "Demonstration Health · fictional plan", allergyStatus: "documented" },
  { id: "demo-002", name: "Jordan Lee", mrn: "DEMO-002", dateOfBirth: "1999-08-09", recordedSex: "Male", genderIdentity: "Man", language: "English", phone: "202-555-0111", address: "202 Sample Avenue, Demo City", emergencyContact: "Casey Lee · sibling · 202-555-0112", primaryClinician: "Dr. Riley Brooks (demo)", pharmacy: "Sample Neighborhood Pharmacy", insurance: "Demo Care · fictional plan", allergyStatus: "unknown" },
];
const record = (id: string, category: ChartRecord["category"], title: string, text: string, recordedAt: string, status: string, source = "Demo EHR · Dr. Avery Chen"): ChartRecord => ({ id, category, title, text, recordedAt, status, source });
const records: Record<string, ChartRecord[]> = {
  "demo-001": [
    record("alex-condition-1", "condition", "Seasonal allergic rhinitis", "Seasonal allergic rhinitis listed on the problem list.", "2026-04-14", "Active"),
    record("alex-condition-2", "condition", "Prior ankle sprain", "Right ankle sprain from 2024; documented as resolved.", "2025-01-20", "Resolved"),
    record("alex-medication-1", "medication", "Cetirizine", "10 mg by mouth once daily as needed; listed for seasonal allergy symptoms. Prescriber: Dr. Avery Chen. Last reconciled April 14, 2026.", "2026-04-14", "Listed as active"),
    record("alex-medication-2", "medication", "Ibuprofen", "200 mg by mouth as needed; historical entry marked discontinued at the January 2025 visit.", "2025-01-20", "Discontinued"),
    record("alex-allergy-1", "allergy", "Penicillin", "Reaction: rash. Recorded severity: moderate. Patient-reported; verification remains unconfirmed.", "2026-04-14", "Unconfirmed"),
    record("alex-history-1", "history", "Surgical history", "Appendectomy documented in 2010.", "2026-04-14", "Historical"),
    record("alex-history-2", "history", "Family history", "Mother reported to have hypertension.", "2026-04-14", "Patient-reported"),
    record("alex-history-3", "history", "Social history", "At the April visit, patient reported no tobacco use and occasional alcohol use.", "2026-04-14", "Patient-reported"),
    record("alex-vital-1", "vital", "Blood pressure", "118/76 mmHg, seated. Measurement from the prior office visit.", "2026-04-14", "Historical measurement"),
    record("alex-vital-2", "vital", "Weight", "68 kg measured at the prior office visit.", "2026-04-14", "Historical measurement"),
    record("alex-lab-1", "lab", "Hemoglobin", "13.4 g/dL. Recorded laboratory reference interval: 12.0–15.5 g/dL.", "2026-04-15", "Final", "Demo EHR · Example Laboratory"),
    record("alex-note-1", "note", "Primary care follow-up", "Reason for visit: seasonal allergy symptoms. Patient reported intermittent sneezing during spring. Medication list and patient-reported penicillin reaction were reviewed. Follow-up was discussed. This is a fictional historical note.", "2026-04-14", "Final"),
    record("alex-note-2", "note", "Ankle follow-up", "Patient reported improvement after a prior right ankle sprain. The clinician marked the problem resolved and reviewed the historical medication list. This is a fictional historical note.", "2025-01-20", "Final"),
  ],
  "demo-002": [
    record("jordan-condition-1", "condition", "Seasonal allergic rhinitis", "Seasonal allergic rhinitis recorded in the problem list.", "2026-06-02", "Active", "Demo EHR · Dr. Riley Brooks"),
    record("jordan-medication-1", "medication", "Loratadine", "10 mg by mouth once daily as needed; patient-reported over-the-counter use. Last reconciled June 2, 2026.", "2026-06-02", "Patient-reported", "Demo EHR · Dr. Riley Brooks"),
    record("jordan-history-1", "history", "Social history", "Patient reported working as a teacher at the June visit.", "2026-06-02", "Patient-reported", "Demo EHR · Dr. Riley Brooks"),
    record("jordan-vital-1", "vital", "Blood pressure", "122/78 mmHg. Measurement from the June office visit.", "2026-06-02", "Historical measurement", "Demo EHR · Dr. Riley Brooks"),
    record("jordan-note-1", "note", "Establish care", "Reason for visit: establish primary care. Patient-reported over-the-counter medication use was recorded. Allergy verification and family and surgical history were not completed. This is a fictional historical note.", "2026-06-02", "Final", "Demo EHR · Dr. Riley Brooks"),
  ],
};
export function patientFixture(id: string) { return profiles.find(patient => patient.id === id); }
export function recordFixtures(id: string) { return structuredClone(records[id] || []); }
