import test from "node:test";
import assert from "node:assert/strict";
import { clinicalContextDraft, clinicalContextSyncKey } from "../components/clinical-context";

const saved = { specialty: "dermatology" as const, imageType: "clinical_photo" as const, anatomicalLocation: "left arm", physicianContext: "Staged photo." };

test("replacing the encounter object keeps the same saved-context key", () => {
  const first = { id: "encounter-1", specialty: "dermatology" as const, clinicalContext: saved };
  const refreshed = { id: "encounter-1", specialty: "dermatology" as const, clinicalContext: { ...saved } };
  assert.equal(clinicalContextSyncKey(first), clinicalContextSyncKey(refreshed));
  assert.deepEqual(clinicalContextDraft(refreshed), saved);
});

test("saved context edits and encounter changes produce a new key", () => {
  const encounter = { id: "encounter-1", specialty: "dermatology" as const, clinicalContext: saved };
  assert.notEqual(clinicalContextSyncKey(encounter), clinicalContextSyncKey({ ...encounter, clinicalContext: { ...saved, anatomicalLocation: "right arm" } }));
  assert.notEqual(clinicalContextSyncKey(encounter), clinicalContextSyncKey({ ...encounter, clinicalContext: { ...saved, physicianContext: "Different note." } }));
  assert.notEqual(clinicalContextSyncKey(encounter), clinicalContextSyncKey({ ...encounter, clinicalContext: { ...saved, imageType: "other_2d" } }));
  assert.notEqual(clinicalContextSyncKey(encounter), clinicalContextSyncKey({ ...encounter, clinicalContext: { ...saved, specialty: "general" } }));
  assert.notEqual(clinicalContextSyncKey(encounter), clinicalContextSyncKey({ ...encounter, id: "encounter-2" }));
});

test("an encounter without saved context follows its specialty until context is saved", () => {
  const skin = { id: "encounter-1", specialty: "skin" as const };
  const same = { id: "encounter-1", specialty: "skin" as const };
  const changed = { id: "encounter-1", specialty: "dermatology" as const };
  assert.equal(clinicalContextSyncKey(skin), clinicalContextSyncKey(same));
  assert.notEqual(clinicalContextSyncKey(skin), clinicalContextSyncKey(changed));
  assert.equal(clinicalContextDraft(skin).specialty, "skin");
  assert.equal(clinicalContextDraft(skin).imageType, "clinical_photo");
});
