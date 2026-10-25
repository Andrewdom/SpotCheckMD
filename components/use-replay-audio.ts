"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { computePeaks } from "@/lib/evidence-map";

const PAD_MS = 150;
const PEAK_BUCKETS = 480;
export type ReplayStatus = "idle" | "loading" | "ready" | "fallback" | "error";

// Plays stored spans of the encounter recording. Audio is fetched only through the session-scoped
// /api/media route with no-store, kept in memory, and released on unmount. If the browser cannot
// decode the container (e.g. WebM on Safari) it falls back to an <audio> element without a waveform.
export function useReplayAudio(audio: { mediaId: string; mime: string } | null) {
  const [status, setStatus] = useState<ReplayStatus>("idle");
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const elementRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const nodeRef = useRef<AudioBufferSourceNode | null>(null);
  const frameRef = useRef(0);
  const loadRef = useRef<Promise<void> | null>(null);
  const runRef = useRef(0);
  const generationRef = useRef(0);
  const mediaId = audio?.mediaId;
  const mime = audio?.mime;

  const load = useCallback((): Promise<void> => {
    if (!mediaId) return Promise.resolve();
    if (loadRef.current) return loadRef.current;
    const generation = generationRef.current;
    setStatus("loading");
    loadRef.current = (async () => {
      try {
        const response = await fetch(`/api/media/${mediaId}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Recording unavailable");
        const bytes = await response.arrayBuffer();
        if (generation !== generationRef.current) return;
        try {
          const Context = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (!Context) throw new Error("Web Audio unavailable");
          const ctx = ctxRef.current ?? new Context();
          ctxRef.current = ctx;
          const buffer = await ctx.decodeAudioData(bytes.slice(0));
          if (generation !== generationRef.current) return;
          bufferRef.current = buffer;
          setPeaks(computePeaks(buffer.getChannelData(0), PEAK_BUCKETS));
          setDurationMs(buffer.duration * 1000);
          setStatus("ready");
        } catch {
          if (generation !== generationRef.current) return;
          const url = URL.createObjectURL(new Blob([bytes], { type: mime || "audio/webm" }));
          urlRef.current = url;
          elementRef.current = new Audio(url);
          setStatus("fallback");
        }
      } catch {
        if (generation === generationRef.current) setStatus("error");
      }
    })();
    return loadRef.current;
  }, [mediaId, mime]);

  const stop = useCallback(() => {
    runRef.current++;
    cancelAnimationFrame(frameRef.current);
    try { nodeRef.current?.stop(); } catch { /* already stopped */ }
    nodeRef.current = null;
    elementRef.current?.pause();
    setPlayheadMs(null);
  }, []);

  const playSpan = useCallback(async (startMs: number, endMs: number) => {
    // Resume synchronously inside the click so Safari keeps the user-activation grant.
    void ctxRef.current?.resume();
    stop();
    const run = runRef.current;
    await load();
    if (run !== runRef.current) return;
    const ctx = ctxRef.current;
    const buffer = bufferRef.current;
    const element = elementRef.current;
    if (buffer && ctx) {
      await ctx.resume().catch(() => {});
      if (run !== runRef.current) return;
      const from = Math.max(0, startMs - PAD_MS);
      const to = Math.min(buffer.duration * 1000, endMs + PAD_MS);
      if (to <= from) return;
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      const startedAt = ctx.currentTime;
      node.onended = () => {
        if (run !== runRef.current) return;
        cancelAnimationFrame(frameRef.current);
        setPlayheadMs(null);
      };
      node.start(0, from / 1000, (to - from) / 1000);
      nodeRef.current = node;
      const tick = () => {
        if (run !== runRef.current) return;
        setPlayheadMs(Math.min(to, from + (ctx.currentTime - startedAt) * 1000));
        frameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } else if (element) {
      const from = Math.max(0, startMs - PAD_MS);
      const to = endMs + PAD_MS;
      element.currentTime = from / 1000;
      await element.play().catch(() => {});
      if (run !== runRef.current) { element.pause(); return; }
      const tick = () => {
        if (run !== runRef.current) return;
        const now = element.currentTime * 1000;
        if (now >= to || element.ended) { stop(); return; }
        setPlayheadMs(now);
        frameRef.current = requestAnimationFrame(tick);
      };
      tick();
    }
  }, [load, stop]);

  useEffect(() => {
    void load();
    return () => {
      generationRef.current++;
      runRef.current++;
      cancelAnimationFrame(frameRef.current);
      try { nodeRef.current?.stop(); } catch { /* already stopped */ }
      nodeRef.current = null;
      elementRef.current?.pause();
      elementRef.current = null;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
      void ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
      bufferRef.current = null;
      loadRef.current = null;
    };
  }, [load]);

  return { status, peaks, durationMs, playheadMs, playing: playheadMs !== null, playSpan, stop };
}
