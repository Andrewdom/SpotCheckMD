# Using Evidence Replay

Evidence Replay is a read-only view on the review screen. It shows where each note sentence came from, lets you hear the part of the recording it cites, and shows whether the approved note has changed since approval. It never approves, edits or exports anything. Use fictional audio and non-patient images only.

## Before you start

- Sign in and open an encounter that has findings. The **Replay evidence** button stays disabled until at least one finding is not rejected.
- To hear spoken quotes, the encounter needs a recording transcribed with AssemblyAI (`TRANSCRIPTION_PROVIDER=assemblyai`), because only it returns word-level timing. Without timing the quotes still show but are labeled "timing unavailable" and cannot be played.
- Use a current Chrome or Edge. Safari and iOS use a simpler player without the waveform.

## Open it

1. Open an encounter from **Last edited**, or run analysis on a new one.
2. On the **Review** screen, click **Replay evidence** above the findings.
3. Click **Hide Evidence Replay** under it to close the view.

## What you see

| Area | What it shows |
| --- | --- |
| Waveform | The recording. Shaded spans are the quotes the note cites, colored by review outcome. The selected sentence's span is darker. A vertical line follows playback. |
| Photo thumbnails | Each photo with its quality label (`usable`, `limited`, `retake`). |
| Routes | Lines from each span or photo to the sentences that cite it. Dashed lines are transcript context, not proof. Shown on wide screens only. |
| Note sentences | The note grouped as S, O, A, P. The stripe color is the review outcome: teal accepted, amber edited by the reviewer, gray pending, light rejected. Chips list each source. |
| Seal | Whether the approved note still matches its approval record (see below). |
| Transcript | The word-timed transcript. Cited words are highlighted, the spoken word is darker, and a dotted underline marks words the transcription service was unsure of. |
| Selected evidence | The exact stored quote, a play button, the cited photo, and the model-written description of it. |

## Things to try

1. **Hear a source.** Click a Subjective sentence. The cited part of the recording plays and its words light up. Click a shaded span on the waveform to replay it, or **Play recording** for the whole file. Press **Escape** to stop.
2. **Check a photo claim.** Click an Objective sentence that came from a photo. The photo opens beside the model's description, labeled "verify against the photo." The description shows what the model wrote, not proof that it is true.
3. **See an edit.** An amber "Edited by reviewer" sentence shows the original generated wording in the detail panel.
4. **Check the seal.**
   - **Sealed:** the digest of the approved note, computed in your browser, matches the server record.
   - **Approval revoked:** something changed after approval. The seal lists each change. Approve again to re-seal.
   - **Digest mismatch:** the browser and server disagree. Do not rely on the approval and report it.
   - **Cannot be verified:** the browser blocks hashing on plain HTTP. Use HTTPS or `localhost`.
5. **Show rejected.** Tick **Show rejected** to see rejected sentences struck through. They are never part of the note.

## Limits to remember

- It shows provenance, not correctness. A matching quote does not prove a statement is true. Review every source before approval.
- Dotted-underline confidence comes from the speech-recognition service, not from clinical judgment.
- No regions are drawn on photos, because the model returns no coordinates.
- The seal's signature is a typed name. It does not authenticate a physician.
- Verified so far in headless Chromium with synthetic data. Safari/iOS, live AssemblyAI audio and live MedGemma output are untested.

Design notes and the build record are in [evidence-replay-plan.md](evidence-replay-plan.md).
