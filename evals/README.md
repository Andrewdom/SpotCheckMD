# SpotCheckMD evaluation guide

This guide covers research evaluation of SpotCheckMD's MedGemma 1.5 4B image-analysis workflow and its separate doctor-dictation workflow. No clinical performance has been established. Use fictional cases or data whose licenses, consent, and approvals explicitly permit the specific processing and evaluation. Keep images, audio, transcripts, manifests, and case-level results outside the repository.

Do not use model output as ground truth. Have qualified clinicians independently annotate reference findings before reviewing model responses, then adjudicate disagreements. A patient's or doctor's text can focus image review, but transcript content is not evidence that a feature is visible in an image.

## Evaluation design

- Compare MedGemma on the same image with and without the clinician's context. Keep image bytes, preprocessing, quality flags, specialty, and image type identical; remove only the transcript/context under study.
- Score atomic claims for visual support, unsupported additions, missed visible findings, incorrect laterality, transcript-attribution errors, missed negation, inferred history/time, image limitations, and clinician corrections.
- Evaluate transcript quality separately against a human-checked transcript. The current AssemblyAI path is configured for doctor-only dictation and rejects audio when multiple voices are detected. Treat live captions as provisional, not as the transcript ground truth.
- Include image-quality conditions, capture devices, lighting, and skin-tone groups when relevant. Record how group labels were obtained; never infer race from an image. Small strata are not evidence of fairness.
- Keep all images from a case/patient in one data split. If training is later attempted, reserve a patient-level test set before training and do not tune on it.
- Record model revision, MedGemma runtime/backend, quantization, prompt version, preprocessing, failures, latency, and cost assumptions. Report every numerator with its denominator and subgroup sample count. Certainty labels are not calibrated probabilities.

## Summarize clinician review

`scripts/evaluate.mjs` aggregates human-reviewed counts; it does not run models or determine whether a claim is correct. Use non-identifying synthetic case IDs. The following is a fictional format example, not an evaluation result:

```json
[
  {
    "id": "fictional-001",
    "reviewed": true,
    "skinTone": "dark",
    "lighting": "low",
    "accent": "not-applicable",
    "terminology": "not-applicable",
    "expected": 4,
    "supported": 3,
    "unsupported": 1,
    "missed": 1,
    "corrected": 1,
    "totalTranscriptTerms": 0,
    "missedTranscriptTerms": 0
  }
]
```

Run the summary with:

```powershell
node scripts/evaluate.mjs evals/reviewed-cases.json
```

Never store identifying clinical information or patient photos in this repository. Report failed model runs separately; do not count a failure as a perfect empty response. No clinical accuracy, safety, or fairness claims should be made from a small technical sample.

## MedGemma technical verification

For an authorized single-case integration check, the repository provides `scripts/verify-scin-medgemma.ts` for SCIN and `scripts/verify-local-medgemma.ts` for a generated non-patient image. See the exact setup and commands in [MedGemma documentation](../docs/medgemma.md). Keep SCIN media, metadata, manifests, and reports private and follow the [SCIN Data Use License](https://github.com/google-research-datasets/scin/blob/main/LICENSE). The SCIN workflow must not send images to an external provider or include dermatologist labels in model input. Its demographic and symptom metadata has limitations and is not a substitute for clinician-authored visual descriptions.

A contract-valid response establishes only that transport, generation, parsing, and evidence validation succeeded for that input. It does not establish clinical accuracy. The general `scripts/compare-image-analysis.ts` research utility retains a legacy OpenAI comparison adapter; it is not used by the app's image-analysis path. The product workflow is MedGemma-only for images. Do not use the legacy adapter with restricted datasets or include it in a MedGemma-only study.

## MedGemma citation

```bibtex
@article{sellergren2026medgemma,
  title={MedGemma 1.5 Technical Report},
  author={Sellergren, Andrew and Gao, Chufan and Mahvar, Fereshteh and Kohlberger, Timo and Jamil, Fayaz and Traverse, Madeleine and Tono, Alberto and Sadjad, Bashir and Yang, Lin and Lau, Charles and others},
  journal={arXiv preprint arXiv:2604.05081},
  year={2026}
}
```

[arXiv:2604.05081](https://arxiv.org/abs/2604.05081). Results from this prototype are not a clinical validation or performance claim.
