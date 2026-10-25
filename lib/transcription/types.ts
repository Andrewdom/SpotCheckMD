import { createHash, randomBytes } from "node:crypto";
import { transcriptText } from "./locate";

export { formatTimestamp, locateTranscriptEvidence, transcriptText } from "./locate";

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
