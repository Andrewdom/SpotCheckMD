# Evaluation protocol (not yet run)

Use fictional or appropriately licensed cases with permission for the model service. Record independent clinician annotations before reading AI output, then adjudicate disagreements. Do not use a model's own description as ground truth.

For each case, record non-identifying skin-tone category from the source dataset or a standardized human annotation (never infer race from a photo), lighting condition, speaker accent if applicable, and clinical-terminology difficulty. Use `not-applicable` for audio-only or non-skin cases. Include diverse skin tones, phones, lighting, blur, and accent/terminology combinations; do not treat the sample sizes of these small strata as proof of fairness. Avoid repeating a patient's images across train/test subsets if a model is ever trained.

Count one atomic observation per finding: `expected` human-reference visible/spoken facts, `supported` generated facts backed by the source, `unsupported` generated facts lacking support, `missed` reference facts absent, and `corrected` generated facts changed by the clinician. For transcription terminology, record `totalTranscriptTerms` and `missedTranscriptTerms` against a human transcript. Also track retake detection precision/recall and time to review outside this simple report. Evaluate both the visual and audio parts, and compare direct image-to-note against evidence-linked review on the same cases. Report denominators with subgroup rates.

Create `reviewed-cases.json` as an array like the schema below (this **example is fictional and not a result**):

```json
[{"id":"fictional-001","reviewed":true,"skinTone":"dark","lighting":"low","accent":"regional","terminology":"complex","expected":4,"supported":3,"unsupported":1,"missed":1,"corrected":1,"totalTranscriptTerms":5,"missedTranscriptTerms":1}]
```

Run `node scripts/evaluate.mjs evals/reviewed-cases.json`. Do not put identifying clinical data or actual patient photos in this repository. No fairness or clinical accuracy claim should be made until enough independently labeled data and appropriate review exist.

## Three-way image-analysis comparison

This path has not produced clinical results. Use the same authorized encounters and independently annotated visible characteristics for all variants:

1. `gpt4o-context`: the optional GPT-4o image provider with transcript context.
2. `medgemma-image-only`: official MedGemma 1.5 4B without a transcript.
3. `medgemma-context`: the same MedGemma model with transcript context.

All arms use the same normalized image, quality flags, declared specialty/image type and confirmed clinician context. The image-only arm removes only the transcript. To test strictly image-only rather than this controlled transcript ablation, leave `anatomicalLocation` and `physicianContext` empty in every arm. The GPT-4o adapter uses the new common observation schema/prompt; it is not a byte-identical replay of the historical `visual-v1` prompt. Keep that distinction in reports. Existing transcript SOAP generation is excluded from visual-quality scoring.

Create a private manifest outside source control. The following is a **fictional schema example, not an evaluated encounter**:

```json
[
  {
    "id": "fictional-001",
    "authorizedForModelProcessing": true,
    "imagePath": "authorized-example.jpg",
    "transcript": "Patient reports no pain. Clinician describes the staged image.",
    "context": {
      "specialty": "general",
      "imageType": "clinical_photo",
      "anatomicalLocation": "",
      "physicianContext": ""
    }
  }
]
```

Image paths resolve relative to the manifest. Confirm permissions for every external provider before setting the authorization flag. Configure OpenAI and the private MedGemma service as described in [setup](../docs/medgemma.md); never put credentials in the manifest. This command makes real model calls and can incur charges:

```sh
npx tsx scripts/compare-image-analysis.ts /private/path/cases.json .aura-data/comparison-run-001 --run-live
```

Use a fresh output directory. The runner refuses to overwrite an existing result file. It rotates variant order across cases, records input digests, prompt/model revisions, transcript ranges, complete structured outputs, elapsed wall time and partial failures. It does not train or grade models. Model/context windows can create repeated observations: clinicians should count unique atomic visible claims per image, including contradictions, rather than counting duplicated phrases. Failure records must not disappear from the report. No real run was performed for this implementation.

Blind/shuffle outputs for independent clinician review and retain the blinded mapping privately. Separate directly supported image characteristics from merely repeated transcript statements. Specifically annotate transcript-induced unsupported claims, missed negations, incorrect laterality, inferred temporal changes, unassessable images, conflicts and corrections. Include specialty/modality, skin-tone where applicable, quality/acquisition device, accent and terminology strata; report their sample sizes. Model certainty is not a probability. Compare contextual/noncontextual output within each case, not different case populations.

Prepare a separate reviewed JSON array with one row per case/variant using this shape (values below are arithmetic examples only):

```json
{
  "caseId": "fictional-001",
  "variant": "medgemma-context",
  "status": "success",
  "reviewed": true,
  "expected": 4,
  "supported": 3,
  "unsupported": 1,
  "missed": 1,
  "corrected": 1,
  "latencyMs": 100,
  "costUsd": null
}
```

Each case needs all three variants and the same reference `expected` count. Count `supported`/`unsupported` against the original output before clinician corrections; `corrected` is a separate count. A successful output requires independent review. For a failed variant, use `status: "failed"`, `reviewed: false`, zero generated/correction counts and actual elapsed latency; retain the reference denominator. It is reported as a failure and excluded from successful-output quality rates, not counted as a perfect empty response. Inspect failure reasons separately.

Record actual allocated hosting/inference charges or a clearly labeled estimate with its assumptions in your private experiment log, then supply `costUsd`. Include GPU rental/idle time, repeated context windows and OpenAI charges as appropriate; a local/open-weight model is not automatically free. Unknown cost stays `null`, never zero. The summary refuses to report total cost if any case cost is missing.

```sh
npx tsx scripts/summarize-comparison.ts /private/path/reviewed-comparison.json
```

This validates complete paired cases and nonnegative/consistent counts, then reports supported counts, unsupported/missed/correction numerators and denominators, failures, mean end-to-end latency and cost coverage. Run the same summary on predefined subgroup subsets and disclose small denominators; do not infer fairness or clinical validation from demo samples. Hardware, model revision, prompt version, preprocessing, warm-up/order and retries belong in the experiment log. The runner/aggregator arithmetic is mock-tested; clinical efficacy, live latency and cost remain unmeasured.
