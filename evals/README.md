# Evaluation protocol (not yet run)

Use fictional or appropriately licensed cases with permission for the model service. Record independent clinician annotations before reading AI output, then adjudicate disagreements. Do not use a model's own description as ground truth.

For each case, record non-identifying skin-tone category from the source dataset or a standardized human annotation (never infer race from a photo), lighting condition, speaker accent if applicable, and clinical-terminology difficulty. Use `not-applicable` for audio-only or non-skin cases. Include diverse skin tones, phones, lighting, blur, and accent/terminology combinations; do not treat the sample sizes of these small strata as proof of fairness. Avoid repeating a patient's images across train/test subsets if a model is ever trained.

Count one atomic observation per finding: `expected` human-reference visible/spoken facts, `supported` generated facts backed by the source, `unsupported` generated facts lacking support, `missed` reference facts absent, and `corrected` generated facts changed by the clinician. For transcription terminology, record `totalTranscriptTerms` and `missedTranscriptTerms` against a human transcript. Also track retake detection precision/recall and time to review outside this simple report. Evaluate both the visual and audio parts, and compare direct image-to-note against evidence-linked review on the same cases. Report denominators with subgroup rates.

Create `reviewed-cases.json` as an array like the schema below (this **example is fictional and not a result**):

```json
[{"id":"fictional-001","reviewed":true,"skinTone":"dark","lighting":"low","accent":"regional","terminology":"complex","expected":4,"supported":3,"unsupported":1,"missed":1,"corrected":1,"totalTranscriptTerms":5,"missedTranscriptTerms":1}]
```

Run `node scripts/evaluate.mjs evals/reviewed-cases.json`. Do not put identifying clinical data or actual patient photos in this repository. No fairness or clinical accuracy claim should be made until enough independently labeled data and appropriate review exist.

## Region-first workflow additions

Score body-region routing separately from finding descriptions. Include unsupported anatomy, objects, very tight crops, mixed regions, no discernible finding, and unclear views. Measure wrong-route rate and appropriate abstention; a wrong route should not be hidden by a fluent final note.

For each selected region, annotate skin or oral fields independently. Count unsupported attributes and missed attributes separately even though the UI groups several attributes into one description. Test no-scale inputs (must never invent millimeters), clinician-entered size provenance, conflicting surface entries, routing overrides, and exact 10 mm boundary handling. Record whether the crop omitted a clinically relevant feature. Review skin-tone, lighting, phone, and crop-size strata independently. Crops are clinician-selected and are not ground-truth lesion masks.

The automated tests in `tests/` validate software rules using synthetic images and scripted API responses. They do not validate model accuracy, diagnostic performance, clinical safety, or fairness.
