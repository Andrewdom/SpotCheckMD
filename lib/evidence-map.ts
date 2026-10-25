import type { Encounter, Finding, Quality, Section } from "./domain";
import { locateTranscriptEvidence } from "./transcription/locate";
import type { TranscriptArtifact, TranscriptWord } from "./transcription/types";

// Read-only view model for Evidence Replay. It only re-arranges data already stored on the
// encounter: it never invents timings, regions or confidence, and it never changes review state.

export type LinkKind = "spoken" | "visual" | "context" | "clinician";
export type ReviewTone = "accepted" | "edited" | "pending" | "rejected";

export type AudioSpan = {
  artifactId: string; audioMediaId: string; audioMime: string;
  utteranceId: string; startMs: number; endMs: number;
  wordStart: number | null; wordEnd: number | null;
};

export type ImageCharacteristic = { category: string; description: string; certainty: string; visibleRegion: string; limitations: string };

export type EvidenceLink = {
  id: string; findingId: string; sourceId: string; kind: LinkKind; quote: string;
  audio: AudioSpan | null;
  image: { mediaId: string; previewMediaId?: string; quality?: Quality; characteristic?: ImageCharacteristic } | null;
  valid: boolean;
};

export type NoteSentence = {
  findingId: string; section: Section; text: string;
  certainty: Finding["certainty"]; origin: Finding["origin"];
  tone: ReviewTone; links: EvidenceLink[];
};

export type EvidenceMap = {
  sentences: NoteSentence[];
  audio: { mediaId: string; mime: string; artifact: TranscriptArtifact | null; timed: boolean } | null;
  images: { sourceId: string; label: string; mediaId: string; previewMediaId?: string; quality?: Quality }[];
};

export type SealState =
  | { kind: "sealed"; revision: number; digest: string; physician: string; at: string }
  | { kind: "mismatch"; revision: number }
  | { kind: "revoked"; approvedRevision: number; currentRevision: number; changes: { action: string; revision: number; at: string }[] }
  | { kind: "unverifiable" }
  | { kind: "none" };

const SECTIONS: Section[] = ["S", "O", "A", "P"];

export function reviewTone(f: Finding): ReviewTone {
  if (f.review === "rejected") return "rejected";
  if (f.review === "pending") return "pending";
  return f.text !== f.originalText ? "edited" : "accepted";
}

// A zero-length span (e.g. the OpenAI provider's single untimed utterance) is not real timing.
const timedSpan = (startMs: number, endMs: number) => Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;

function audioSpanFor(e: Encounter, artifactId: string, locator: { utteranceId: string; startMs: number; endMs: number; wordStart: number | null; wordEnd: number | null }): AudioSpan | null {
  if (!timedSpan(locator.startMs, locator.endMs)) return null;
  const artifact = e.transcripts?.find(item => item.id === artifactId);
  const audio = artifact && e.sources.find(source => source.id === artifact.audioSourceId && source.kind === "audio" && source.mediaId);
  if (!artifact || !audio?.mediaId) return null;
  return { artifactId, audioMediaId: audio.mediaId, audioMime: audio.mime || "audio/webm", utteranceId: locator.utteranceId, startMs: locator.startMs, endMs: locator.endMs, wordStart: locator.wordStart, wordEnd: locator.wordEnd };
}

export function findCharacteristic(e: Encounter, f: Finding, imageSourceId: string): ImageCharacteristic | undefined {
  if (!f.analysisRunId) return;
  const visualEvidence = f.evidence.find(item => item.sourceId === imageSourceId && item.role !== "context");
  if (!visualEvidence?.quote) return;
  for (const run of e.imageAnalyses || []) {
    if (run.runId !== f.analysisRunId || run.analysis.imageSourceId !== imageSourceId) continue;
    // A run can contain several analysis results for the same image (one per transcript window),
    // and different results can use the same wording. Match every stored provenance field that the
    // finding retained so replay never attaches a same-worded characteristic from another region.
    const match = run.analysis.characteristics.find(item =>
      item.description === f.originalText
      && (!f.category || item.category === f.category)
      && item.evidence.visibleRegion === visualEvidence.quote
    );
    if (match) return { category: match.category, description: match.description, certainty: match.certainty, visibleRegion: match.evidence.visibleRegion, limitations: match.limitations };
  }
}

function linkKind(e: Encounter, f: Finding, evidence: Finding["evidence"][number]): LinkKind {
  if (evidence.role) return evidence.role;
  const kind = e.sources.find(source => source.id === evidence.sourceId)?.kind;
  return kind === "image" ? "visual" : kind === "transcript" ? "spoken" : "clinician";
}

function buildLink(e: Encounter, f: Finding, evidence: Finding["evidence"][number], index: number): EvidenceLink {
  const source = e.sources.find(item => item.id === evidence.sourceId);
  const kind = linkKind(e, f, evidence);
  let audio: AudioSpan | null = null;
  if (evidence.transcript) audio = audioSpanFor(e, evidence.transcript.artifactId, evidence.transcript);
  else if (source?.kind === "transcript" && source.transcriptArtifactId) {
    const artifact = e.transcripts?.find(item => item.id === source.transcriptArtifactId);
    const located = locateTranscriptEvidence(artifact, evidence.quote);
    if (located) audio = audioSpanFor(e, located.artifactId, located);
  }
  const image = source?.kind === "image" && source.mediaId
    ? { mediaId: source.mediaId, previewMediaId: source.previewMediaId, quality: source.quality, characteristic: kind === "visual" ? findCharacteristic(e, f, source.id) : undefined }
    : null;
  return { id: `${f.id}:${index}`, findingId: f.id, sourceId: evidence.sourceId, kind, quote: evidence.quote, audio, image, valid: Boolean(source) };
}

export function buildEvidenceMap(e: Encounter, opts: { approvedOnly: boolean; includeRejected?: boolean }): EvidenceMap {
  // Membership mirrors composeNote() so the lens never shows a sentence the note would omit.
  const included = (f: Finding) => (opts.approvedOnly ? f.review === "accepted" : f.review !== "rejected") || Boolean(opts.includeRejected && f.review === "rejected");
  const sentences = SECTIONS.flatMap(section => e.findings.filter(f => f.section === section && included(f)).map(f => ({
    findingId: f.id, section, text: f.text, certainty: f.certainty, origin: f.origin, tone: reviewTone(f),
    links: f.evidence.map((evidence, index) => buildLink(e, f, evidence, index)),
  })));
  const audioSource = e.sources.find(source => source.kind === "audio" && source.mediaId);
  const artifact = audioSource ? [...(e.transcripts || [])].reverse().find(item => item.audioSourceId === audioSource.id) || null : null;
  return {
    sentences,
    audio: audioSource?.mediaId ? { mediaId: audioSource.mediaId, mime: audioSource.mime || "audio/webm", artifact, timed: Boolean(artifact?.utterances.some(u => timedSpan(u.startMs, u.endMs))) } : null,
    images: e.sources.flatMap(source => source.kind === "image" && source.mediaId ? [{ sourceId: source.id, label: source.label, mediaId: source.mediaId, previewMediaId: source.previewMediaId, quality: source.quality }] : []),
  };
}

export function wordsInSpan(artifact: TranscriptArtifact, span: AudioSpan): TranscriptWord[] {
  const utterance = artifact.utterances.find(item => item.id === span.utteranceId);
  if (!utterance) return [];
  if (span.wordStart !== null && span.wordEnd !== null) return utterance.words.slice(span.wordStart, span.wordEnd + 1);
  return utterance.words.filter(word => word.startMs >= span.startMs && word.endMs <= span.endMs);
}

// The word being spoken at playheadMs, or -1. Start is inclusive and end exclusive so adjacent
// words never both claim the same instant.
export function activeWordIndex(words: TranscriptWord[], playheadMs: number): number {
  return words.findIndex(word => playheadMs >= word.startMs && playheadMs < word.endMs);
}

// Max absolute amplitude per bucket, clamped to 0..1. Always returns exactly `buckets` values.
export function computePeaks(samples: Float32Array, buckets: number): Float32Array {
  const count = Math.max(0, Math.floor(buckets));
  const peaks = new Float32Array(count);
  const n = samples.length;
  if (!n) return peaks;
  for (let bucket = 0; bucket < count; bucket++) {
    const start = Math.min(n - 1, Math.floor(bucket * n / count));
    const end = Math.max(start + 1, Math.floor((bucket + 1) * n / count));
    let max = 0;
    for (let i = start; i < end; i++) max = Math.max(max, Math.abs(samples[i]));
    peaks[bucket] = Math.min(1, max);
  }
  return peaks;
}

export function sealState(e: Encounter, recomputedDigest: string | null): SealState {
  if (e.approval) {
    if (recomputedDigest === null) return { kind: "unverifiable" };
    if (e.approval.revision !== e.revision || e.approval.digest !== recomputedDigest) return { kind: "mismatch", revision: e.approval.revision };
    return { kind: "sealed", revision: e.approval.revision, digest: e.approval.digest, physician: e.approval.physician, at: e.approval.at };
  }
  const lastApproved = e.audit.map(event => event.action).lastIndexOf("approved");
  if (lastApproved < 0) return { kind: "none" };
  return { kind: "revoked", approvedRevision: e.audit[lastApproved].revision, currentRevision: e.revision, changes: e.audit.slice(lastApproved + 1) };
}
