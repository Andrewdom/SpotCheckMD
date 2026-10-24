import { createHash, randomBytes } from "node:crypto";

export type TranscriptWord = {
  text: string;
  startMs: number;
  endMs: number;
  confidence: number | null;
  speaker: string;
};

export type TranscriptUtterance = {
  id: string;
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
  words: TranscriptWord[];
};

export type TranscriptArtifact = {
  version: 1;
  id: string;
  transcriptSourceId: string;
  audioSourceId: string;
  audioSha256: string;
  provider: "openai" | "assemblyai";
  model: string;
  providerTranscriptId?: string;
  createdAt: string;
  finalizedAt: string;
  settings: {
    medicalMode: boolean;
    speakerLabels: boolean;
    keyterms: string[];
  };
  text: string;
  utterances: TranscriptUtterance[];
  digest: string;
  supersedesId?: string;
};

export type TranscriptRoles = {
  artifactId: string;
  patientSpeaker: string;
  clinicianSpeaker: string;
  confirmedAt: string;
};

export type TranscriptEvidence = {
  artifactId: string;
  utteranceId: string;
  speaker: string;
  startMs: number;
  endMs: number;
  wordStart: number | null;
  wordEnd: number | null;
};

export type TranscriptionRequest = {
  bytes: Buffer;
  mime: string;
  audioSourceId: string;
  transcriptSourceId: string;
  keyterms: string[];
  supersedesId?: string;
};

export interface TranscriptionProvider {
  id: TranscriptArtifact["provider"];
  transcribe(request: TranscriptionRequest): Promise<TranscriptArtifact>;
}

export function formatTimestamp(milliseconds: number) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function transcriptText(utterances: TranscriptUtterance[]) {
  return utterances.map(utterance => `${utterance.speaker} [${formatTimestamp(utterance.startMs)}]: ${utterance.text}`).join("\n");
}

export function createTranscriptArtifact(input: Omit<TranscriptArtifact, "version" | "id" | "audioSha256" | "text" | "digest" | "createdAt"> & { bytes: Buffer; createdAt?: string }) {
  const createdAt = input.createdAt || new Date().toISOString();
  const artifactWithoutDigest = {
    version: 1 as const,
    id: randomBytes(16).toString("hex"),
    transcriptSourceId: input.transcriptSourceId,
    audioSourceId: input.audioSourceId,
    audioSha256: createHash("sha256").update(input.bytes).digest("hex"),
    provider: input.provider,
    model: input.model,
    providerTranscriptId: input.providerTranscriptId,
    createdAt,
    finalizedAt: input.finalizedAt,
    settings: input.settings,
    text: transcriptText(input.utterances),
    utterances: input.utterances,
    supersedesId: input.supersedesId,
  };
  const digest = createHash("sha256").update(JSON.stringify(artifactWithoutDigest)).digest("hex");
  return { ...artifactWithoutDigest, digest } satisfies TranscriptArtifact;
}

export function locateTranscriptEvidence(artifact: TranscriptArtifact | undefined, quote: string): TranscriptEvidence | undefined {
  if (!artifact || !quote.trim()) return;
  for (const utterance of artifact.utterances) {
    const quoteStart = utterance.text.indexOf(quote);
    if (quoteStart < 0) continue;
    const quoteEnd = quoteStart + quote.length;
    let cursor = 0;
    const positions = utterance.words.map(word => {
      const start = utterance.text.indexOf(word.text, cursor);
      if (start < 0) return null;
      cursor = start + word.text.length;
      return { start, end: cursor };
    });
    const selected = positions.flatMap((position, index) => position && position.end > quoteStart && position.start < quoteEnd ? [index] : []);
    const first = selected.length ? utterance.words[selected[0]] : undefined;
    const last = selected.length ? utterance.words[selected[selected.length - 1]] : undefined;
    return {
      artifactId: artifact.id,
      utteranceId: utterance.id,
      speaker: utterance.speaker,
      startMs: first?.startMs ?? utterance.startMs,
      endMs: last?.endMs ?? utterance.endMs,
      wordStart: selected.length ? selected[0] : null,
      wordEnd: selected.length ? selected[selected.length - 1] : null,
    };
  }
}
