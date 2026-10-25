# Evidence Replay: implementation plan

Status: **implemented** on `feature/evidence-replay`. This document began as the build plan and is kept as the design record; the section below lists where the implementation differs from it.

### Implementation notes (differences from the original plan)

- The audio hook lives in its own file, `components/use-replay-audio.ts`, to keep `components/evidence-replay.tsx` readable.
- A transcript-context quote on a *visual* finding is located in the transcript when it can be, so it gets a timeline band and a "Context · Audio" chip. It stays labeled "Transcript context — not visual proof".
- Provenance routes are drawn as lane-routed paths (down out of the source panel, along a private lane, then down the empty left gutter into the sentence) instead of single Bézier curves, because direct curves crossed sentence text. They sit above the cards, inactive routes are faint, and they are hidden below 1024 px where sources show as chips.
- While verifying against PostgreSQL, a separate bug surfaced and was fixed on `fix/transcript-media-object`: persisting an encounter with a recording inserted the audio file key twice (the transcript source reuses the audio `mediaId`), failing with a primary-key violation. `scripts/verify-postgres.ts` now covers it.
- Verified in headless Chromium (desktop, 1024 px, 390 px) against a synthetic encounter: waveform decode, playback and playhead, word highlighting, low-confidence marking, photo evidence, edited-wording notice, Escape to stop, rejected toggle, browser-verified seal, revoked seal after an edit, empty encounter, `no-store` media only, no new API calls, no `localStorage`/`sessionStorage`, no console errors, no horizontal scroll. Not verified: Safari/iOS (the `<audio>` fallback path), real AssemblyAI audio, and real MedGemma output.

## 1. Goal

SpotCheckMD's central claim is that every sentence in a physician-reviewed note is traceable to an encounter-local source. Evidence Replay makes that claim visible and audible in a live demo:

1. Click a sentence in the SOAP note.
2. If it came from dictation, the recording's waveform highlights the exact span, that span plays, and the transcript highlights word by word as it is spoken.
3. If it came from a photo, the photo opens beside the MedGemma characteristic and the model-written region description it was based on.
4. A provenance map draws curves from each source (audio segments, photo thumbnails) to the note sentences they support, colored by review outcome.
5. An approval seal shows the approved note's SHA-256 digest, verified in the browser, and shows when a later edit revoked approval.

It is a **read-only lens** over data the app already stores and already sends to the browser. It adds no endpoint, model call, storage field or review rule.

## 2. Non-negotiable constraints (from AGENTS.md)

| Rule | What it means here |
| --- | --- |
| Never fabricate regions, timestamps, measurements or confidence | Draw **no** boxes, heatmaps or crops on images; MedGemma returns no coordinates. Play audio only from stored word/utterance timings. If timing is missing, say "timing unavailable" and show the quote. |
| Quality labels and certainty tags are not calibrated confidence | Word tinting uses AssemblyAI's per-word `confidence` and is labeled exactly *"Speech-recognition word confidence (provider-reported; not clinical confidence)"*. Never show it as a percentage next to a finding. `observed/uncertain/not_assessable` are shown as qualitative tags. |
| A matching source ID or model-written region description does not prove a claim | Label the image panel text *"Model-written region description — verify against the photo."* The view shows *where the claim came from*, not that it is true. |
| Separate patient reports, visible observations, clinician interpretation | Keep the existing `origin` (`spoken`/`visual`/`clinician`) and `role` (`spoken`/`visual`/`context`/`clinician`) visible on every link. Transcript `context` evidence for a visual finding is drawn as a dashed "context" link, never as visual proof. |
| Approval semantics are server-side | The seal is display-only. It never approves, blocks or exports anything. The server's digest stays authoritative. |
| Credentials/media handling | Media is fetched only through the existing session-scoped `/api/media/[id]` (no-store). Do not cache media in `localStorage`/IndexedDB, do not log transcripts or media, revoke any object URLs on unmount. |
| No new framework or dependency without a requirement | Waveform uses the Web Audio API; curves are inline SVG; hashing uses `crypto.subtle`. No charting/audio libraries. |
| This Next.js version differs from training data | Before writing components, read `node_modules/next/dist/docs/01-app/` (client components, `"use client"` boundaries). |

## 3. What data already exists (verified against `main` at `d0a5b43`)

All of this reaches the browser through `GET /api/demo` (`app/api/demo/route.ts`, `safe()` strips only `owner`).

- **Findings** (`lib/domain.ts` `Finding`): `section`, `text`, `originalText`, `origin`, `certainty`, `limitation`, `review`, `reviewNote`, `category?`, `analysisRunId?`, `provider?`, `evidence: Evidence[]`.
- **Evidence** (`lib/domain.ts`): `{ sourceId, quote, role?, transcript?: TranscriptEvidence }`.
  - Spoken findings from the pipeline (`lib/image-analysis/pipeline.ts:52`) carry `transcript` = `{ artifactId, utteranceId, speaker, startMs, endMs, wordStart, wordEnd }` from `locateTranscriptEvidence`.
  - Visual findings (`pipeline.ts:77`) carry `{ sourceId: imageId, quote: visibleRegion, role: "visual" }` and optionally `{ sourceId: transcriptId, quote, role: "context" }` **without** a `transcript` locator.
  - Clinician (manual) findings carry `{ sourceId, quote }` with no role/locator.
- **Transcripts** (`encounter.transcripts: TranscriptArtifact[]`, `lib/transcription/types.ts`): `audioSourceId`, `utterances[].words[]` with `startMs`, `endMs`, `confidence | null`, `speaker`. AssemblyAI fills words; the OpenAI provider produces one utterance with `startMs = endMs = 0` and no words.
- **Sources**: image sources have `mediaId`, `previewMediaId`, `quality`, `width`, `height`; the single audio source (one recording per encounter, ≤ 20 MB, `audio/webm|mp4|wav|mpeg|ogg`) has `mediaId` and `mime`; transcript sources have `text` and `transcriptArtifactId`.
- **Image analyses** (`encounter.imageAnalyses`): `{ runId, provider, model, analysis: { imageSourceId, characteristics[{ id, category, description, certainty, evidence: { visibleRegion, … }, limitations }], limitations } }`.
- **Approval**: `encounter.approval = { revision, physician, at, note, digest }` where `digest = sha256(composeNote(e, true))` (`app/api/demo/route.ts:146-147`). Any content change runs `changed()` (`lib/store.ts`), which sets `approval = null` and appends to `encounter.audit`. Approval events are recorded in `audit` as `action: "approved"`.

### Gotchas found while planning

1. `lib/transcription/types.ts` imports `node:crypto`, so its **runtime** exports cannot be imported into a client component. Type-only imports are fine.
2. A visual finding's `context` quote comes from a transcript *window* whose text includes `SPEAKER [m:ss]: ` prefixes, so it may span utterances and fail to locate. Treat that as "timing unavailable", not an error.
3. `composeNote` (`lib/domain.ts`) is already client-safe (the dashboard imports it), so the browser can recompute the exact digested note.
4. `crypto.subtle` only exists in secure contexts (HTTPS or `localhost`). On plain-HTTP LAN access the seal must say "cannot verify in this browser", not "verified".
5. Safari may fail `decodeAudioData` on `audio/webm`. Fallback: play through an `<audio>` element seeked to `startMs`, with no waveform.

## 4. Architecture

```
GET /api/demo (unchanged) ──► Encounter in dashboard state
                                   │
                    lib/evidence-map.ts  (pure, no DOM, unit-tested)
                    buildEvidenceMap(encounter, { approvedOnly })
                                   │  EvidenceMap
                                   ▼
               components/evidence-replay.tsx  ("use client")
      ┌──────────────┬──────────────────┬────────────────┬──────────────┐
      │ SourceRail   │ ProvenanceLinks  │ NoteLens       │ ApprovalSeal │
      │ waveform +   │ SVG curves       │ clickable      │ digest check │
      │ photo thumbs │ between columns  │ sentences      │ + revocation │
      └──────────────┴──────────────────┴────────────────┴──────────────┘
                 │ audio: useReplayAudio() hook (Web Audio / <audio> fallback)
                 ▼
          /api/media/[id]  (unchanged, session-scoped, no-store)
```

### 4.1 Pure module: `lib/evidence-map.ts` (new)

No React, DOM or Node imports. Only type imports from `lib/domain.ts`, `lib/transcription/types.ts`, `lib/image-analysis/contracts.ts`.

```ts
export type LinkKind = "spoken" | "visual" | "context" | "clinician";
export type ReviewTone = "accepted" | "edited" | "pending" | "rejected";

export type AudioSpan = {
  artifactId: string; audioMediaId: string; audioMime: string;
  utteranceId: string; startMs: number; endMs: number;
  wordStart: number | null; wordEnd: number | null; // indices into utterance.words
};

export type EvidenceLink = {
  id: string;                 // `${findingId}:${index}`
  findingId: string;
  sourceId: string;
  kind: LinkKind;
  quote: string;              // exactly as stored; never rewritten
  audio: AudioSpan | null;    // null => "timing unavailable"
  image: { mediaId: string; previewMediaId?: string; quality?: Quality; characteristic?: { category: string; description: string; certainty: string; visibleRegion: string; limitations: string } } | null;
  valid: boolean;             // false if sourceId is not in encounter.sources
};

export type NoteSentence = {
  findingId: string; section: Section; text: string;
  certainty: Finding["certainty"]; origin: Finding["origin"];
  tone: ReviewTone; links: EvidenceLink[];
};

export type EvidenceMap = {
  sentences: NoteSentence[];               // ordered S, O, A, P like composeNote
  audio: { mediaId: string; mime: string; artifact: TranscriptArtifact | null; timed: boolean } | null;
  images: { sourceId: string; label: string; mediaId: string; previewMediaId?: string; quality?: Quality }[];
};

export function buildEvidenceMap(e: Encounter, opts: { approvedOnly: boolean; includeRejected?: boolean }): EvidenceMap;
export function reviewTone(f: Finding): ReviewTone;            // edited = accepted && text !== originalText
export function findCharacteristic(e: Encounter, f: Finding, imageSourceId: string): EvidenceLink["image"]["characteristic"] | undefined;
export function wordsInSpan(artifact: TranscriptArtifact, span: AudioSpan): TranscriptWord[];
export function activeWordIndex(words: TranscriptWord[], playheadMs: number): number; // -1 if none
export function computePeaks(samples: Float32Array, buckets: number): Float32Array;  // max |x| per bucket, 0..1
export function sealState(e: Encounter, recomputedDigest: string | null): SealState;
```

Rules the implementation must follow:

- **Sentence filter matches `composeNote` exactly**: `approvedOnly ? review === "accepted" : review !== "rejected"`, section order `S, O, A, P`. `includeRejected` is a separate opt-in for a "show rejected" toggle. Rejected sentences render struck through and are never part of the note.
- **Audio span resolution**, in order:
  1. If `evidence.transcript` exists, find the artifact by `artifactId`, use its `audioSourceId` to find the audio source and `mediaId`, and use the stored `startMs/endMs/wordStart/wordEnd` **unchanged**.
  2. Else if the evidence source is a transcript source, try the pure locator (see 4.2) on the matching artifact. Use the result only if it returns.
  3. Else `audio = null`.
  - If `startMs === endMs` (OpenAI provider), set `audio = null`. A zero-length span is not real timing.
- **Characteristic lookup**: match `imageAnalyses` where `runId === finding.analysisRunId && analysis.imageSourceId === sourceId`, then the characteristic whose `description === finding.originalText` (use `originalText`, because reviewers may edit `text`). If nothing matches, omit it; do not guess.
- **Links to unknown source IDs** get `valid: false` and render as a red "missing source" chip. They are never silently dropped.

### 4.2 Small refactor: client-safe transcript helpers

Move `formatTimestamp`, `transcriptText` and `locateTranscriptEvidence` from `lib/transcription/types.ts` into a new `lib/transcription/locate.ts` with **no Node imports**, and re-export them from `types.ts` so every existing import keeps working. Behavior must stay byte-identical. The existing `tests/transcription.test.ts` covers `locateTranscriptEvidence` and must pass unchanged. This is the only change to existing library code.

### 4.3 Seal logic

```ts
type SealState =
  | { kind: "sealed"; revision: number; digest: string; physician: string; at: string }   // approval.revision === e.revision && recomputed === approval.digest
  | { kind: "mismatch"; revision: number }                                              // approval present but digest differs: show warning, never "sealed"
  | { kind: "revoked"; approvedRevision: number; currentRevision: number; changes: { action: string; revision: number; at: string }[] } // no approval, audit has an earlier "approved"
  | { kind: "unverifiable" }                                                            // crypto.subtle unavailable
  | { kind: "none" };                                                                   // never approved
```

- Recompute in the component with `crypto.subtle.digest("SHA-256", new TextEncoder().encode(composeNote(e, true)))`, hex-encoded. `sealState` itself stays pure: it receives the digest, or `null` when it is unavailable.
- `revoked.changes` = audit entries after the last `"approved"` entry. Show the action strings verbatim (for example `"finding reviewed"`). They are server-written labels, not user content.
- `physician` is free text and **not authenticated**. Show it as "Typed signature: …" next to the logged-in account name, matching current wording elsewhere.

### 4.4 Component: `components/evidence-replay.tsx` (new, `"use client"`)

Props: `{ encounter: Encounter; approvedOnly: boolean; onOpenSource?: (sourceId: string) => void }`.

Sub-components can live in the same file; split them only if it passes ~400 lines.

1. **`useReplayAudio(audio)` hook**
   - On first user interaction (click a spoken sentence or press play), `fetch("/api/media/" + mediaId, { cache: "no-store" })`, then `arrayBuffer()`, then `AudioContext.decodeAudioData`. Create the `AudioContext` inside the click handler, because browsers block autoplay.
   - `playSpan(startMs, endMs)`: stop any current node, create an `AudioBufferSourceNode`, `start(0, startMs/1000, (endMs-startMs)/1000)`, and drive the playhead from `ctx.currentTime` with `requestAnimationFrame`. Expose `{ status, playheadMs, durationMs, peaks, playSpan, stop }`.
   - Pad spans by 150 ms on each side, clamped to `[0, duration]`, so clipped words stay intelligible. Highlight only the true span.
   - Fallback if decoding throws: an `<audio>` element with an object URL, `currentTime = startMs/1000`, stopped at `endMs` via `timeupdate`. `peaks = null` hides the waveform. Revoke the URL and close the context on unmount.
   - `computePeaks(channelData, 480)` runs once after decode. With 20 MB max audio this is under 100 ms on a laptop; no worker needed.
2. **`SourceRail`** (left column)
   - Waveform: a `<canvas>` or SVG bar chart of `peaks`. Every audio-linked sentence's span is drawn as a translucent band colored by tone. The active band is solid, and the playhead is a vertical line. Clicking a band plays it.
   - Below it, the karaoke transcript: utterances from the artifact, words as `<span>`s. Words inside the active span are emphasized and the word at `activeWordIndex(playheadMs)` gets a moving highlight. Words with `confidence !== null && confidence < 0.6` get a dotted amber underline and a `title` with the provider label from §2. Words with `confidence === null` are untinted.
   - Photo thumbnails from `previewMediaId || mediaId`, with the quality badge (`usable/limited/retake`). Clicking one shows the photo larger in the detail panel.
3. **`NoteLens`** (right column): sentences grouped by section headers from `sectionLabels`. Each sentence is a `<button>` (keyboard focusable, `aria-pressed` when active) showing the text, a certainty tag when it isn't `observed`, small origin icons, and a tone stripe.
   - Selecting a sentence sets `activeFindingId` and plays the first link with `audio`.
   - It also opens the detail panel, which lists every link: the quote verbatim; for images, the photo plus characteristic category, certainty, model-written region description and limitations; and "timing unavailable" where `audio === null`.
4. **`ProvenanceLinks`**: an absolutely positioned SVG over both columns.
   - Anchor points come from refs on each source anchor (waveform band centre, thumbnail edge) and each sentence's left edge, measured with `getBoundingClientRect` relative to the container. Recompute on `ResizeObserver` and scroll.
   - Each link is a cubic Bézier, `M x1 y1 C (x1+dx) y1, (x2-dx) y2, x2 y2`.
   - Stroke colors: teal for accepted, amber for edited, slate for pending, light dashed for rejected (only if shown). `context` links are dashed and `valid:false` links are red.
   - When a sentence is active, its links go to full opacity and the others fade to about 0.15.
   - Animate the active link's `stroke-dashoffset` once on selection. Skip it under `prefers-reduced-motion`.
   - **Below the `lg` breakpoint, don't render the SVG.** Columns stack, and each sentence shows its source chips inline. That keeps it working on phones without horizontal scroll.
5. **`ApprovalSeal`**:
   - `sealed`: a badge with a shield icon, the first 12 hex characters of the digest, revision, time and typed signature, plus a one-time scale-in animation (skipped under reduced motion).
   - `revoked`: the badge is drawn split, with the list of changes since approval.
   - `mismatch`: an amber warning saying the server-approved text differs from what this browser composes. This should never happen, so it needs reporting.
   - `unverifiable`: a neutral note. `none`: hidden.

Styling should follow existing dashboard conventions: the `card` class string, Tailwind slate/teal palette, `lucide-react` icons (`AudioWaveform`, `Image`, `ShieldCheck`, `ShieldAlert`, `Play`, `Pause` are available in the pinned version; confirm before use).

### 4.5 Dashboard integration (`components/dashboard.tsx`)

Keep this to a few lines:

- Add a "Replay evidence" toggle button in the **SOAP draft** card header in the `stage === "review"` branch (around `components/dashboard.tsx:879`).
- When it is on, render `<EvidenceReplay encounter={current} approvedOnly={Boolean(current.approval)} onOpenSource={id => document.getElementById("source-" + id)?.scrollIntoView({ behavior: "smooth" })} />` as a full-width section above the two-column review grid. The existing `source-${id}` anchors already exist.
- No change to `act()`, review actions, approval or export flows.

## 5. Work breakdown

Tasks are ordered and sized for parallel work. **A** unblocks everything; **B–E** can proceed in parallel against fixture data.

| # | Task | Files | Est. | Depends |
|---|---|---|---|---|
| A | Move transcript helpers to `lib/transcription/locate.ts`, re-export | `lib/transcription/locate.ts` (new), `lib/transcription/types.ts` | 0.5 h | — |
| B | `buildEvidenceMap`, `reviewTone`, `findCharacteristic`, span resolution | `lib/evidence-map.ts` | 2 h | A |
| C | `wordsInSpan`, `activeWordIndex`, `computePeaks`, `sealState` | `lib/evidence-map.ts` | 1.5 h | — |
| D | Unit tests for B and C | `tests/evidence-map.test.ts` | 1.5 h | B, C |
| E | `useReplayAudio` hook + fallback | `components/evidence-replay.tsx` | 2 h | C |
| F | `NoteLens` + detail panel | same | 2 h | B |
| G | `SourceRail` (waveform, karaoke, thumbnails) | same | 3 h | C, E |
| H | `ProvenanceLinks` SVG + responsive collapse | same | 3 h | F, G |
| I | `ApprovalSeal` | same | 1 h | C |
| J | Dashboard toggle + README section | `components/dashboard.tsx`, `README.md` | 0.5 h | F |
| K | Manual QA pass (§7) and demo rehearsal (§8) | — | 1.5 h | all |

Total is roughly 2–3 person-days. A minimum demo-worthy cut is **A, B, C, E, F, G, J**: clickable note, audio span playback and karaoke. **H and I** are the high-impact polish.

## 6. Automated tests (`tests/evidence-map.test.ts`)

Use the existing `tests/fixtures.ts` helpers and the `completed` AssemblyAI-shaped fixture pattern from `tests/transcription.test.ts`. All fixtures are synthetic.

1. Accepted spoken finding with `transcript` locator: `audio` equals the stored `startMs/endMs/wordStart/wordEnd` exactly and resolves the audio `mediaId` via `artifact.audioSourceId`.
2. OpenAI-style artifact (`startMs === endMs === 0`, no words): `audio === null`.
3. Evidence whose `sourceId` is not in `sources`: `valid === false`, still present.
4. Visual finding: `image.characteristic` matches by `analysisRunId` + `imageSourceId` + `originalText`; an edited `text` still matches; a mismatched run ID yields no characteristic.
5. Visual finding `context` evidence that cannot be located yields `kind: "context"` with `audio === null` and no error.
6. Sentence filtering equals `composeNote` membership for `approvedOnly` true and false. Assert the finding IDs line up with the lines `composeNote` emits per section.
7. `reviewTone`: accepted unchanged → `accepted`; accepted with `text !== originalText` → `edited`; pending; rejected.
8. `activeWordIndex` at boundaries (exactly `startMs`, exactly `endMs`, between words, before first, after last).
9. `computePeaks`: known sample arrays, `buckets` larger than the sample count, all-zero input, output in `[0,1]`.
10. `sealState`: sealed; digest mismatch; revision mismatch; revoked with the changes listed after the last `"approved"`; `null` digest → `unverifiable`; never approved → `none`.
11. The existing `tests/transcription.test.ts` passes unchanged after task A.

Run `npm run build`, `npm run typecheck` and `npm test`. CI (`.github/workflows/ci.yml`) runs them on the PR.

## 7. Manual QA checklist

Use synthetic dictation and staged, non-patient images only.

- [ ] AssemblyAI encounter: clicking each spoken sentence plays the right words, karaoke stays in sync, and stop/start of another sentence works.
- [ ] Visual sentence opens the right photo and characteristic, and its context link is dashed.
- [ ] A manual clinician finding citing a photo shows the photo with no characteristic.
- [ ] Edit an accepted finding after approval: the seal turns to `revoked` and lists the change. Re-approve: it is `sealed` again with a new digest.
- [ ] Encounter with no audio: no waveform, and the view still works for photos.
- [ ] Encounter transcribed with the OpenAI provider: "timing unavailable", no playback attempt.
- [ ] Safari or iOS: falls back to `<audio>` playback without a waveform, with no console errors.
- [ ] Phone width: stacked layout, no SVG, no horizontal scroll.
- [ ] Keyboard only: tab through sentences, Enter plays, Escape stops.
- [ ] `prefers-reduced-motion`: no seal or line animation.
- [ ] DevTools network: media requests go only to `/api/media/*` with `no-store`. No new API calls, and nothing in `localStorage`.
- [ ] Signed-out or other-physician session: media requests 401/404 as today.

## 8. Demo script (about 90 seconds)

1. Open a completed, approved encounter (fictional patient, staged photo, scripted dictation recorded by a team member).
2. Turn on **Replay evidence**. Curves draw from the waveform and photo to the note.
3. Click a Subjective sentence. Judges hear the exact phrase while the words light up.
4. Click an Objective sentence. The photo opens with MedGemma's observation and the "verify against the photo" label.
5. Point at a low-confidence underlined word: "the transcription service flagged this word, so the reviewer knows to double-check it."
6. Edit one sentence. The seal breaks and lists the edit. Re-approve, and it re-seals with a new digest.
7. Closing line: "Every sentence in the note can be traced back to its source, down to the second of audio or the photo it came from — and any change after approval is visible."

Prepare the demo encounter in advance on the deployment you will present from. Analysis runs through the async queue and MedGemma latency varies.

## 9. Out of scope / later

- Clinician-drawn image regions (a reviewer marks a box during review). This would need a versioned `Evidence` schema change and migration plan, so it is a separate proposal.
- Any model-generated bounding box, saliency or heatmap. MedGemma doesn't provide it, and fabricating one violates AGENTS.md.
- Cross-encounter comparison, exporting the replay, or adding it to the simulated EHR payload.
- Range requests on `/api/media` for streaming. Not needed at the 20 MB audio limit.

## 10. Risks

| Risk | Mitigation |
|---|---|
| WebM decode unsupported (Safari) | `<audio>` fallback, waveform hidden (§4.4.1) |
| Link curves misaligned after layout changes | Recompute on `ResizeObserver` and scroll; hide below `lg` |
| Live demo depends on AssemblyAI/MedGemma availability | Pre-build the demo encounter; the replay itself needs no provider calls |
| Implementer reads the digest as authentication | Copy text says "typed signature"; seal is display-only (§4.3) |
| Overstating word confidence | Fixed provider label; no percentages next to findings (§2) |
