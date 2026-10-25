# Simulated EHR chart and note submission

The Demo EHR supports a local round trip: read a fictional patient chart, review selected historical records alongside an encounter, approve the resulting note, and retrieve that exact saved note in a later visit. It uses no EHR credentials, external EHR service, or additional model call.

## Demonstration

1. Open Alex Morgan or Jordan Lee from the patient directory. Browse demographics, care contacts, conditions, medications, allergies, history, dated results, and prior visit notes.
2. Start a visit and confirm patient and consent. Open the chart panel, select relevant entries, optionally mark history confirmed during this visit, and choose **Save reviewed history**. The source text and dates are selected by the server; the client sends only record IDs and confirmation flags.
3. Use the existing capture and review workflow. Without configured AI access, upload a synthetic image, switch to Review, and add a clinician observation tied to that image. Accept it with any required limitation/reviewer explanation. All existing review blockers remain enforced.
4. Inspect the reviewed background and **Preview exact note for submission**. Enter a demo clinician name and choose **Approve & send to Demo EHR**. The receipt opens the saved note in Visit notes.
5. Reload the page, reopen the patient chart, and inspect the saved note. A new encounter for the same patient in the same demo workspace can read it as prior history.
6. Edit the encounter and approve again to create a linked amendment. Both the original and amendment remain in the chart. Repeated submissions of the same approved revision return the same document and receipt.

Alex has a documented but unconfirmed allergy and both active and discontinued medication entries. Jordan has unverified allergy history, no lab results, and incomplete family/surgical history. Empty data is labeled as missing rather than normal. All fixtures are fictional, including names, clinicians, medication histories, contacts, and results.

## Implementation

- `lib/ehr/types.ts`: chart, selected-history snapshot, saved-note, provenance, and receipt types.
- `lib/ehr/fixtures.ts`: stable fictional patient and record IDs. Existing `demo-001` and `demo-002` remain compatible.
- `lib/ehr/adapter.ts`: local `EhrAdapter` implementation. Reads and approved-note submissions operate inside the existing storage transaction. No model generation is performed here.
- `app/api/ehr/route.ts`: no-store chart reads authenticated by physician sessions. Each physician can read their organization-scoped fictional patient charts.
- `chart-context`: validates consent, patient, record IDs, bounded selection, and chart version. Saves a versioned snapshot, advances encounter revision, cancels stale analysis, and revokes approval through the existing mechanism.
- `approve-send`: validates review blockers and atomically saves approval, immutable note, and receipt. Existing `approve` / `export` clients remain supported; `export` now saves an actual local chart document.
- `components/patient-chart.tsx` and `components/ehr-submission.tsx`: chart browsing, loading/error/refresh states, selection, exact preview, submission status, and receipts.

The approved note contains a separate reviewed-chart-background section followed by the existing deterministic SOAP text. Historical measurements retain their dates. A clinician confirmation applies to the historical statement; it does not convert an old vital into a measurement from today's visit. Imported chart records are not represented as image evidence or transcript sources and are not automatically sent to MedGemma/OpenAI. Source record IDs, text, dates, and selection metadata persist in the saved note's snapshot. Model and image runtime provenance are retained with the saved note.

## Persistence and failure behavior

Storage adds optional `ehrCharts` to the existing local database. Each chart is keyed by workspace owner and patient ID. Existing files lacking this field are initialized lazily without rewriting encounters or deleting media. Encounters gain optional `chartContext` and `ehrReceipts`; old export markers do not pretend to be saved documents. Submitting an old approved encounter creates its first chart document.

Each new note increments the chart version. An out-of-date selection is rejected with a refresh instruction. Existing selected snapshots remain unchanged until the clinician explicitly saves a new selection. Edits clear the current approval/export pointer while preserving previous receipts and chart documents.

The note and receipt are committed in the same atomic database-file replacement. A failed write commits neither. A retry after a lost response looks up the existing owner/encounter/revision/digest and returns the same receipt. The UI reports an unconfirmed submission and refreshes the encounter after errors. This is single-process local persistence, not a durable external transport queue.

Physician sessions expire after twelve hours and can coexist on multiple devices for the same account. This MVP login and fictional chart store are not a production identity or EHR integration. A real integration needs managed identity lifecycle, stronger organization roles, vendor-specific authorization, patient matching, access scopes, mappings, transport reconciliation, retention controls and production storage.

## Verification

Run `npm test`, `npm run build`, and `npm run typecheck`, then the existing `LIVE_AI=0` HTTP smoke against an isolated server. `tests/ehr.test.ts` covers legacy initialization, missing-data states, patient/workspace authorization, exact historical content, stale charts, consent/review gates, concurrent retries, immutable originals, amendments, storage failure/retry, and isolation of chart context from model inputs. The unchanged MedGemma Python suite runs with its separate test environment.

This feature writes encounter notes and approval metadata only. It does not change structured medication/allergy/problem lists, create prescriptions, accept real records, or establish clinical validation. The pre-existing live MedGemma inference limitation remains separate from the local EHR demonstration.
