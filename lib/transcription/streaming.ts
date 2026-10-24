import { z } from "zod";
import { AppError } from "../store";

export async function assemblyAIStreamingSession(keyterms: string[], fetcher: typeof fetch = fetch) {
  if ((process.env.TRANSCRIPTION_PROVIDER || "openai").toLowerCase() !== "assemblyai") throw new AppError(409, "Live captions require the AssemblyAI transcription provider.");
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) throw new AppError(503, "AssemblyAI is selected but its API key is not configured.");
  const tokenResponse = await fetcher("https://streaming.assemblyai.com/v3/token?expires_in_seconds=60", {
    headers: { Authorization: key }, signal: AbortSignal.timeout(15000), cache: "no-store",
  });
  if (!tokenResponse.ok) throw new AppError(tokenResponse.status === 429 ? 503 : 502, "AssemblyAI could not start a live caption session.");
  const { token } = z.object({ token: z.string().min(10).max(4000) }).passthrough().parse(await tokenResponse.json());
  const url = new URL("wss://streaming.assemblyai.com/v3/ws");
  url.searchParams.set("token", token);
  url.searchParams.set("sample_rate", "16000");
  url.searchParams.set("speech_model", process.env.ASSEMBLYAI_STREAMING_MODEL || "u3-rt-pro");
  url.searchParams.set("domain", "medical-v1");
  url.searchParams.set("speaker_labels", "true");
  url.searchParams.set("max_speakers", "1");
  url.searchParams.set("min_turn_silence", "800");
  url.searchParams.set("max_turn_silence", "3600");
  if (keyterms.length) url.searchParams.set("keyterms_prompt", JSON.stringify(keyterms.slice(0, 100)));
  return { url: url.toString(), expiresInSeconds: 60 };
}
