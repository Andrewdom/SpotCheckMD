import { z } from "zod";
import { transcribe as transcribeWithOpenAI } from "../analysis";
import { AppError } from "../store";
import { createTranscriptArtifact, type TranscriptArtifact, type TranscriptionProvider, type TranscriptionRequest, type TranscriptUtterance } from "./types";

const ASSEMBLYAI_BASE = "https://api.assemblyai.com";
const DEFAULT_ASSEMBLYAI_MODEL = "universal-3-5-pro";

const wordSchema = z.object({
  text: z.string().min(1).max(200),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  speaker: z.string().min(1).max(30).nullable().optional(),
}).passthrough();
const utteranceSchema = z.object({
  speaker: z.string().min(1).max(30),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  text: z.string().trim().min(1).max(10000),
  words: z.array(wordSchema).max(10000).default([]),
}).passthrough();
const transcriptSchema = z.object({
  id: z.string().min(1).max(200),
  status: z.enum(["queued", "processing", "completed", "error"]),
  text: z.string().max(100000).nullable().optional(),
  error: z.string().max(1000).nullable().optional(),
  speech_model_used: z.string().min(1).max(200).nullable().optional(),
  utterances: z.array(utteranceSchema).max(5000).nullable().optional(),
}).passthrough();

function providerTimeout() {
  const value = Number(process.env.ASSEMBLYAI_TIMEOUT_MS || 180000);
  if (!Number.isInteger(value) || value < 10000 || value > 600000) throw new AppError(503, "Invalid AssemblyAI timeout configuration.");
  return value;
}

async function assemblyRequest(fetcher: typeof fetch, path: string, key: string, init: RequestInit = {}) {
  const response = await fetcher(`${ASSEMBLYAI_BASE}${path}`, {
    ...init,
    headers: { Authorization: key, ...(init.headers || {}) },
    signal: AbortSignal.timeout(Math.min(providerTimeout(), 90000)),
  });
  if (!response.ok) throw new AppError(response.status === 429 ? 503 : 502, response.status === 429 ? "AssemblyAI rate limit or quota was reached." : `AssemblyAI request failed (${response.status}).`);
  return response.json();
}

function assemblyUtterances(data: z.infer<typeof transcriptSchema>): TranscriptUtterance[] {
  const utterances = data.utterances || [];
  if (!utterances.length && data.text?.trim()) throw new AppError(502, "AssemblyAI did not return timestamped doctor-dictation segments.");
  const speakers = new Set(utterances.flatMap(utterance => [
    utterance.speaker,
    ...utterance.words.map(word => word.speaker || utterance.speaker),
  ]));
  if (speakers.size > 1) throw new AppError(422, "Multiple voices were detected. This workflow supports doctor dictation only; record the doctor alone.");
  return utterances.map((utterance, index) => {
    if (utterance.end < utterance.start) throw new AppError(502, "AssemblyAI returned invalid transcript timing.");
    return {
      id: `utterance-${index + 1}`,
      speaker: "CLINICIAN",
      startMs: utterance.start,
      endMs: utterance.end,
      text: utterance.text,
      words: utterance.words.map(word => {
        if (word.end < word.start) throw new AppError(502, "AssemblyAI returned invalid word timing.");
        return { text: word.text, startMs: word.start, endMs: word.end, confidence: word.confidence ?? null, speaker: "CLINICIAN" };
      }),
    };
  });
}

export function assemblyAITranscriptionProvider(fetcher: typeof fetch = fetch): TranscriptionProvider {
  return { id: "assemblyai", async transcribe(request: TranscriptionRequest) {
    const key = process.env.ASSEMBLYAI_API_KEY;
    if (!key) throw new AppError(503, "AssemblyAI transcription is selected but its API key is not configured.");
    const uploaded = z.object({ upload_url: z.string().url() }).passthrough().parse(await assemblyRequest(fetcher, "/v2/upload", key, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(request.bytes),
    }));
    const model = process.env.ASSEMBLYAI_SPEECH_MODEL || DEFAULT_ASSEMBLYAI_MODEL;
    const submitted = transcriptSchema.parse(await assemblyRequest(fetcher, "/v2/transcript", key, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        audio_url: uploaded.upload_url,
        speech_models: [model],
        domain: "medical-v1",
        speaker_labels: true,
        speakers_expected: 1,
        keyterms_prompt: request.keyterms,
      }),
    }));
    const started = Date.now();
    let result = submitted;
    while (result.status === "queued" || result.status === "processing") {
      if (Date.now() - started >= providerTimeout()) throw new AppError(504, "AssemblyAI transcription timed out; no partial transcript was saved.");
      await new Promise(resolve => setTimeout(resolve, 750));
      result = transcriptSchema.parse(await assemblyRequest(fetcher, `/v2/transcript/${encodeURIComponent(submitted.id)}`, key));
    }
    if (result.status !== "completed") throw new AppError(502, "AssemblyAI could not complete the transcript; no partial transcript was saved.");
    const utterances = assemblyUtterances(result);
    if (!utterances.length) throw new AppError(502, "AssemblyAI returned an empty transcript.");
    return createTranscriptArtifact({
      bytes: request.bytes,
      transcriptSourceId: request.transcriptSourceId,
      audioSourceId: request.audioSourceId,
      provider: "assemblyai",
      model: result.speech_model_used || model,
      providerTranscriptId: result.id,
      finalizedAt: new Date().toISOString(),
      settings: { medicalMode: true, speakerLabels: true, keyterms: request.keyterms },
      utterances,
      supersedesId: request.supersedesId,
    });
  } };
}

export function openAITranscriptionProvider(): TranscriptionProvider {
  return { id: "openai", async transcribe(request) {
    const text = await transcribeWithOpenAI(request.bytes, request.mime);
    return createTranscriptArtifact({
      bytes: request.bytes,
      transcriptSourceId: request.transcriptSourceId,
      audioSourceId: request.audioSourceId,
      provider: "openai",
      model: "gpt-transcribe",
      finalizedAt: new Date().toISOString(),
      settings: { medicalMode: false, speakerLabels: false, keyterms: [] },
      utterances: [{ id: "utterance-1", speaker: "CLINICIAN", startMs: 0, endMs: 0, text, words: [] }],
      supersedesId: request.supersedesId,
    });
  } };
}

export function configuredTranscriptionProvider(fetcher: typeof fetch = fetch): TranscriptionProvider {
  const provider = (process.env.TRANSCRIPTION_PROVIDER || "openai").toLowerCase();
  if (provider === "openai") return openAITranscriptionProvider();
  if (provider === "assemblyai") return assemblyAITranscriptionProvider(fetcher);
  throw new AppError(503, "Unknown TRANSCRIPTION_PROVIDER. Choose openai or assemblyai explicitly.");
}

export function transcriptionModel(artifact: TranscriptArtifact | undefined) {
  return artifact ? `${artifact.provider}:${artifact.model}` : "";
}
