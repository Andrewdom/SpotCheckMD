"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AudioWaveform, Image as ImageIcon, Pause, Play, ShieldAlert, ShieldCheck } from "lucide-react";
import { composeNote, sectionLabels, type Encounter } from "@/lib/domain";
import { activeWordIndex, buildEvidenceMap, sealState, type AudioSpan, type EvidenceLink, type NoteSentence, type ReviewTone, type SealState } from "@/lib/evidence-map";
import { formatTimestamp } from "@/lib/transcription/locate";
import { useReplayAudio } from "@/components/use-replay-audio";

const card = "rounded-2xl border border-slate-200 bg-white shadow-sm shadow-slate-200/40";
const WAVE_W = 480;
const WAVE_H = 72;
const LOW_CONFIDENCE = 0.6;

const TONE: Record<ReviewTone, { stroke: string; label: string; chip: string; bar: string }> = {
  accepted: { stroke: "#0d9488", label: "Accepted", chip: "bg-teal-50 text-teal-800", bar: "bg-teal-600" },
  edited: { stroke: "#d97706", label: "Edited by reviewer", chip: "bg-amber-50 text-amber-800", bar: "bg-amber-500" },
  pending: { stroke: "#64748b", label: "Pending review", chip: "bg-slate-100 text-slate-600", bar: "bg-slate-400" },
  rejected: { stroke: "#94a3b8", label: "Rejected", chip: "bg-red-50 text-red-700", bar: "bg-slate-300" },
};
const KIND_LABEL: Record<EvidenceLink["kind"], string> = {
  spoken: "Spoken in the transcript",
  visual: "Visible in the photo",
  context: "Transcript context — not visual proof",
  clinician: "Clinician entry",
};
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, "0")).join("");
const span = (audio: AudioSpan) => `${formatTimestamp(audio.startMs)}–${formatTimestamp(audio.endMs)}`;

type Curve = { id: string; findingId: string; d: string; tone: ReviewTone; dashed: boolean; invalid: boolean; x1: number; y1: number; x2: number; y2: number };

// SHA-256 of the exact approved-note text, computed in the browser. undefined = still computing,
// null = unavailable (crypto.subtle needs HTTPS or localhost).
function useNoteDigest(note: string, enabled: boolean) {
  const [state, setState] = useState<{ note: string; digest: string | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) { setState({ note, digest: null }); return; }
    subtle.digest("SHA-256", new TextEncoder().encode(note))
      .then(buffer => { if (!cancelled) setState({ note, digest: hex(buffer) }); })
      .catch(() => { if (!cancelled) setState({ note, digest: null }); });
    return () => { cancelled = true; };
  }, [note, enabled]);
  return state?.note === note ? state.digest : undefined;
}

export function EvidenceReplay({ encounter, approvedOnly, onOpenSource }: { encounter: Encounter; approvedOnly: boolean; onOpenSource?: (sourceId: string) => void }) {
  const [showRejected, setShowRejected] = useState(false);
  const map = useMemo(() => buildEvidenceMap(encounter, { approvedOnly, includeRejected: showRejected }), [encounter, approvedOnly, showRejected]);
  const replay = useReplayAudio(map.audio ? { mediaId: map.audio.mediaId, mime: map.audio.mime } : null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeLinkId, setActiveLinkId] = useState<string | null>(null);
  const [curves, setCurves] = useState<Curve[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const transcriptBoxRef = useRef<HTMLDivElement>(null);
  const bandEls = useRef(new Map<string, SVGRectElement>());
  const thumbEls = useRef(new Map<string, HTMLElement>());
  const sentenceEls = useRef(new Map<string, HTMLElement>());
  const wordEls = useRef(new Map<string, HTMLElement>());
  const lastCurves = useRef("");

  const artifact = map.audio?.artifact || null;
  const fallbackDuration = artifact ? Math.max(0, ...artifact.utterances.map(u => u.endMs)) : 0;
  const duration = replay.durationMs || fallbackDuration;
  const active = map.sentences.find(sentence => sentence.findingId === activeId) || null;
  const activeFinding = encounter.findings.find(finding => finding.id === activeId);
  const activeSpans = useMemo(() => active?.links.flatMap(link => link.audio ? [link.audio] : []) || [], [active]);

  const approvedNote = useMemo(() => composeNote(encounter), [encounter]);
  const digest = useNoteDigest(approvedNote, Boolean(encounter.approval));
  const seal: SealState | "verifying" = encounter.approval && digest === undefined ? "verifying" : sealState(encounter, digest ?? null);

  const select = useCallback((sentence: NoteSentence) => {
    setActiveId(sentence.findingId);
    const first = sentence.links.find(link => link.audio);
    setActiveLinkId(first?.id || null);
    if (first?.audio) void replay.playSpan(first.audio.startMs, first.audio.endMs); else replay.stop();
  }, [replay]);

  const playLink = useCallback((sentence: NoteSentence, link: EvidenceLink) => {
    setActiveId(sentence.findingId);
    setActiveLinkId(link.id);
    if (link.audio) void replay.playSpan(link.audio.startMs, link.audio.endMs);
  }, [replay]);

  // Curves run from each source anchor (the band's real position on the timeline, or a photo
  // thumbnail) down to the sentence that cites it. Only drawn on wide screens.
  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const set = (next: Curve[]) => {
      const key = JSON.stringify(next);
      if (key === lastCurves.current) return;
      lastCurves.current = key;
      setCurves(next);
    };
    if (window.innerWidth < 1024) { set([]); return; }
    const box = container.getBoundingClientRect();
    const wave = waveRef.current?.getBoundingClientRect();
    const rail = railRef.current?.getBoundingClientRect();
    if (!rail) { set([]); return; }
    const railBottom = rail.bottom - box.top;
    const next: Curve[] = [];
    for (const sentence of map.sentences) {
      const target = sentenceEls.current.get(sentence.findingId)?.getBoundingClientRect();
      if (!target) continue;
      const x2 = target.left - box.left;
      const y2 = target.top - box.top + Math.min(target.height / 2, 24);
      for (const link of sentence.links) {
        let x1: number | null = null, y1 = 0;
        const band = link.audio && bandEls.current.get(link.id)?.getBoundingClientRect();
        const thumb = link.image && thumbEls.current.get(link.sourceId)?.getBoundingClientRect();
        if (band && wave) { x1 = band.left + band.width / 2 - box.left; y1 = wave.bottom - box.top; }
        else if (thumb) { x1 = thumb.left + thumb.width / 2 - box.left; y1 = thumb.bottom - box.top; }
        if (x1 === null) continue;
        // Drop out of the source panel, sweep along a private lane in the gap below it, then run down
        // the empty left gutter into the sentence, so lines never cross sentence text.
        const lane = next.length % 8;
        const gx = x2 - 50 + lane * 5;
        const laneY = railBottom + 8 + lane * 3;
        const r = 8, dir = x1 > gx ? -1 : 1;
        const turn = Math.max(laneY + r, y2 - r);
        const f = (n: number) => n.toFixed(1);
        const d = Math.abs(x1 - gx) > 2 * r + 2
          ? `M${f(x1)} ${f(y1)} L${f(x1)} ${f(laneY - r)} Q${f(x1)} ${f(laneY)} ${f(x1 + dir * r)} ${f(laneY)} L${f(gx - dir * r)} ${f(laneY)} Q${f(gx)} ${f(laneY)} ${f(gx)} ${f(laneY + r)} L${f(gx)} ${f(turn)} Q${f(gx)} ${f(y2)} ${f(gx + r)} ${f(y2)} L${f(x2)} ${f(y2)}`
          : `M${f(x1)} ${f(y1)} L${f(x1)} ${f(laneY)} L${f(gx)} ${f(laneY)} L${f(gx)} ${f(turn)} Q${f(gx)} ${f(y2)} ${f(gx + r)} ${f(y2)} L${f(x2)} ${f(y2)}`;
        next.push({ id: link.id, findingId: sentence.findingId, d, tone: sentence.tone, dashed: link.kind === "context", invalid: !link.valid, x1, y1, x2, y2 });
      }
    }
    set(next);
  }, [map]);

  useLayoutEffect(() => { measure(); }, [measure, replay.peaks, duration, activeId]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    observer?.observe(container);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [measure]);

  // Keep the first highlighted word in view inside the transcript box without moving the page.
  useEffect(() => {
    const span = activeSpans[0];
    const box = transcriptBoxRef.current;
    if (!span || !box) return;
    const key = `${span.utteranceId}:${span.wordStart ?? 0}`;
    const el = wordEls.current.get(key) || wordEls.current.get(`${span.utteranceId}:0`);
    if (el) box.scrollTo({ top: Math.max(0, el.offsetTop - box.clientHeight / 3), behavior: "smooth" });
  }, [activeSpans]);

  const wordsInActive = useMemo(() => {
    const keys = new Set<string>();
    if (!artifact) return keys;
    for (const s of activeSpans) {
      const utterance = artifact.utterances.find(u => u.id === s.utteranceId);
      utterance?.words.forEach((word, index) => {
        const inside = s.wordStart !== null && s.wordEnd !== null ? index >= s.wordStart && index <= s.wordEnd : word.startMs >= s.startMs && word.endMs <= s.endMs;
        if (inside) keys.add(`${utterance.id}:${index}`);
      });
    }
    return keys;
  }, [artifact, activeSpans]);

  const playingKey = useMemo(() => {
    if (!artifact || replay.playheadMs === null) return null;
    for (const utterance of artifact.utterances) {
      const index = activeWordIndex(utterance.words, replay.playheadMs);
      if (index >= 0) return `${utterance.id}:${index}`;
    }
    return null;
  }, [artifact, replay.playheadMs]);

  const bands = map.sentences.flatMap(sentence => sentence.links.flatMap(link => link.audio ? [{ sentence, link, audio: link.audio }] : []));
  const total = duration || 1;
  const x = (ms: number) => Math.min(WAVE_W, Math.max(0, ms / total * WAVE_W));
  const hasSentences = map.sentences.length > 0;

  return <section className={`${card} p-5 sm:p-6`} onKeyDown={event => { if (event.key === "Escape") replay.stop(); }} aria-label="Evidence Replay">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold"><AudioWaveform size={19} className="text-teal-700" /> Evidence Replay</h2>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">Select a sentence to see and hear the stored evidence behind it. This view only shows where each statement came from; it does not show that a statement is true. Review every source before approval.</p>
      </div>
      <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={showRejected} onChange={event => setShowRejected(event.target.checked)} /> Show rejected</label>
    </div>

    <div ref={containerRef} className="relative mt-5">
      {curves.length > 0 && <svg className="pointer-events-none absolute inset-0 z-20 hidden h-full w-full overflow-visible lg:block" aria-hidden="true">
        {curves.map(curve => {
          const on = curve.findingId === activeId;
          const dim = activeId !== null && !on;
          return <g key={`${curve.id}-${on ? "on" : "off"}`} opacity={dim ? 0.12 : on ? 0.95 : 0.3}>
            <path d={curve.d} pathLength={1} fill="none" stroke={curve.invalid ? "#dc2626" : TONE[curve.tone].stroke} strokeWidth={on ? 2.5 : 1.5} strokeLinecap="round" strokeDasharray={curve.dashed ? "5 5" : undefined} className={on && !curve.dashed ? "link-draw" : undefined} />
            <circle cx={curve.x1} cy={curve.y1} r={3} fill={curve.invalid ? "#dc2626" : TONE[curve.tone].stroke} />
            <circle cx={curve.x2} cy={curve.y2} r={3} fill={curve.invalid ? "#dc2626" : TONE[curve.tone].stroke} />
          </g>;
        })}
      </svg>}

      <div ref={railRef} className="relative z-10 rounded-xl bg-slate-50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[.15em] text-slate-600">Recording and photos</p>
          {map.audio && <button type="button" disabled={replay.status === "loading" || replay.status === "error" || !total} onClick={() => replay.playing ? replay.stop() : void replay.playSpan(0, total)} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold disabled:opacity-40">{replay.playing ? <><Pause size={14} /> Stop</> : <><Play size={14} /> Play recording</>}</button>}
        </div>
        {map.audio ? <div ref={waveRef} className="mt-3">
          <svg viewBox={`0 0 ${WAVE_W} ${WAVE_H}`} preserveAspectRatio="none" className="h-[72px] w-full rounded-lg bg-white" role="img" aria-label="Recording waveform with the spans cited by the note">
            {replay.peaks
              ? Array.from(replay.peaks, (peak, index) => <rect key={index} x={index} y={WAVE_H / 2 - Math.max(1, peak * (WAVE_H - 8)) / 2} width={0.7} height={Math.max(1, peak * (WAVE_H - 8))} fill="#cbd5e1" />)
              : <line x1={0} x2={WAVE_W} y1={WAVE_H / 2} y2={WAVE_H / 2} stroke="#cbd5e1" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
            {bands.map(({ sentence, link, audio }) => {
              const isActive = sentence.findingId === activeId;
              return <rect key={link.id} ref={el => { if (el) bandEls.current.set(link.id, el); else bandEls.current.delete(link.id); }} x={x(audio.startMs)} y={0} width={Math.max(2, x(audio.endMs) - x(audio.startMs))} height={WAVE_H} fill={TONE[sentence.tone].stroke} fillOpacity={isActive ? 0.4 : 0.16} stroke={TONE[sentence.tone].stroke} strokeWidth={isActive ? 1.5 : 0.75} vectorEffect="non-scaling-stroke" className="cursor-pointer" onClick={() => playLink(sentence, link)}><title>{`${sentence.text} (${span(audio)})`}</title></rect>;
            })}
            {replay.playheadMs !== null && <line x1={x(replay.playheadMs)} x2={x(replay.playheadMs)} y1={0} y2={WAVE_H} stroke="#0f172a" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
          </svg>
          <p className="mt-2 text-[11px] text-slate-500" aria-live="polite">
            {replay.status === "loading" ? "Decoding recording…" : replay.status === "error" ? "The recording could not be loaded." : replay.status === "fallback" ? "Waveform unavailable in this browser; playback still works." : !map.audio.timed ? "This transcript has no word-level timing, so spoken quotes cannot be replayed." : `${formatTimestamp(total)} recording · shaded spans are the quotes cited by the note`}
          </p>
        </div> : <p className="mt-3 text-xs text-slate-500">No recording is attached to this encounter.</p>}
        {map.images.length > 0 && <div className="mt-4 flex flex-wrap gap-3">
          {map.images.map(image => {
            const cited = map.sentences.some(sentence => sentence.findingId === activeId && sentence.links.some(link => link.sourceId === image.sourceId));
            return <button type="button" key={image.sourceId} ref={el => { if (el) thumbEls.current.set(image.sourceId, el); else thumbEls.current.delete(image.sourceId); }} onClick={() => { const sentence = map.sentences.find(item => item.links.some(link => link.sourceId === image.sourceId)); if (sentence) select(sentence); }} className={`w-28 overflow-hidden rounded-lg border bg-white text-left ${cited ? "border-teal-600 ring-2 ring-teal-100" : "border-slate-200"}`} aria-label={`${image.label}${image.quality ? `, quality ${image.quality.status}` : ""}`}>
              <img src={`/api/media/${image.previewMediaId || image.mediaId}`} alt={image.label} className="h-16 w-full object-cover" />
              <span className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold text-slate-600"><ImageIcon size={11} /> {image.label}{image.quality && image.quality.status !== "usable" ? ` · ${image.quality.status}` : ""}</span>
            </button>;
          })}
        </div>}
      </div>

      <div className="relative z-10 mt-6 lg:mt-12 lg:pl-16">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-xs font-bold uppercase tracking-[.15em] text-slate-600">Note sentences</h3>
          <ul className="flex flex-wrap gap-2 text-[10px] font-semibold">{(Object.keys(TONE) as ReviewTone[]).map(tone => <li key={tone} className={`flex items-center gap-1 rounded px-2 py-1 ${TONE[tone].chip}`}><span className={`size-2 rounded-full ${TONE[tone].bar}`} />{TONE[tone].label}</li>)}</ul>
        </div>
        <SealBadge seal={seal} />
        {!hasSentences && <p className="mt-4 rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">No note sentences to replay yet. Accept or review at least one finding first.</p>}
        <div className="mt-3 space-y-5">
          {(["S", "O", "A", "P"] as const).map(section => {
            const sentences = map.sentences.filter(sentence => sentence.section === section);
            if (!sentences.length) return null;
            return <div key={section}>
              <h4 className="border-b border-slate-100 pb-1 text-xs font-bold uppercase tracking-[.15em] text-teal-800">{section} · {sectionLabels[section]}</h4>
              <ul className="mt-2 space-y-2">{sentences.map(sentence => <li key={sentence.findingId}>
                <button type="button" aria-pressed={sentence.findingId === activeId} ref={el => { if (el) sentenceEls.current.set(sentence.findingId, el); else sentenceEls.current.delete(sentence.findingId); }} onClick={() => select(sentence)} className={`relative w-full rounded-xl border bg-white/95 p-3 pl-5 text-left text-sm leading-6 transition ${sentence.findingId === activeId ? "border-teal-600 ring-2 ring-teal-100" : "border-slate-200 hover:border-slate-300"} ${sentence.tone === "rejected" ? "text-slate-400" : "text-slate-700"}`}>
                  <span className={`absolute inset-y-2 left-1.5 w-1 rounded-full ${TONE[sentence.tone].bar}`} aria-hidden="true" />
                  <span className={sentence.tone === "rejected" ? "line-through" : undefined}>{sentence.certainty !== "observed" && <span className="mr-1 text-slate-500">[{sentence.certainty.replaceAll("_", " ")}]</span>}{sentence.text}</span>
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${TONE[sentence.tone].chip}`}>{TONE[sentence.tone].label}</span>
                    {sentence.links.map(link => <span key={link.id} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${link.valid ? "bg-slate-100 text-slate-600" : "bg-red-50 text-red-700"}`}>{chipText(link, map.images)}</span>)}
                  </span>
                </button>
              </li>)}</ul>
            </div>;
          })}
        </div>
      </div>
    </div>

    <div className="mt-6 grid gap-6 lg:grid-cols-2">
      <div>
        <h3 className="text-xs font-bold uppercase tracking-[.15em] text-slate-600">Transcript</h3>
        {artifact ? <>
          <p className="mt-1 text-[11px] leading-4 text-slate-500">Dotted underline: speech-recognition word confidence reported by the provider, not clinical confidence. Review those words against the audio.</p>
          <div ref={transcriptBoxRef} className="relative mt-2 max-h-64 overflow-auto rounded-xl bg-slate-50 p-3 text-sm leading-7 text-slate-700">
            {artifact.utterances.map(utterance => <p key={utterance.id} className="mb-2">
              <span className="mr-2 text-[10px] font-bold text-teal-800">{formatTimestamp(utterance.startMs)}</span>
              {utterance.words.length ? utterance.words.map((word, index) => {
                const key = `${utterance.id}:${index}`;
                const low = word.confidence !== null && word.confidence < LOW_CONFIDENCE;
                const cls = key === playingKey ? "rounded bg-teal-700 px-0.5 text-white" : wordsInActive.has(key) ? "rounded bg-teal-100 px-0.5" : "";
                return <span key={key}><span ref={el => { if (el) wordEls.current.set(key, el); else wordEls.current.delete(key); }} title={low ? `Provider-reported word confidence ${word.confidence!.toFixed(2)} (speech recognition only; not clinical confidence)` : undefined} className={`${cls} ${low ? "underline decoration-amber-500 decoration-dotted decoration-2 underline-offset-4" : ""}`}>{word.text}</span>{" "}</span>;
              }) : utterance.text}
            </p>)}
          </div>
        </> : <p className="mt-2 text-xs text-slate-500">No transcript is stored for this encounter.</p>}
      </div>

      <div>
        <h3 className="text-xs font-bold uppercase tracking-[.15em] text-slate-600">Selected evidence</h3>
        {!active ? <p className="mt-2 rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">Select a sentence to inspect its sources.</p> : <div className="mt-2 space-y-3">
          {activeFinding && activeFinding.text !== activeFinding.originalText && <p className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900"><span className="font-bold">Original generated wording:</span> {activeFinding.originalText}</p>}
          {active.links.map(link => <div key={link.id} className={`rounded-xl border p-3 ${link.id === activeLinkId ? "border-teal-600" : "border-slate-200"}`}>
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{KIND_LABEL[link.kind]} · source {link.sourceId.slice(0, 8)}</p>
            <blockquote className="mt-1 border-l-2 border-slate-300 pl-3 text-sm leading-6 text-slate-700">“{link.quote}”</blockquote>
            {!link.valid && <p className="mt-2 text-xs font-semibold text-red-700">This source is not part of the encounter. The finding cannot be approved without valid evidence.</p>}
            {!link.audio && link.kind !== "visual" && link.image === null && link.valid && <p className="mt-2 text-xs text-slate-500">Timing unavailable for this quote. Verify it in the transcript.</p>}
            {link.audio && <button type="button" onClick={() => playLink(active, link)} className="mt-2 mr-3 inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold"><Play size={13} /> Play {span(link.audio)}</button>}
            {link.image && <div className="mt-3">
              <img src={`/api/media/${link.image.previewMediaId || link.image.mediaId}`} alt="Photo cited by this sentence" className="max-h-64 w-full rounded-lg bg-slate-100 object-contain" />
              {link.image.quality && link.image.quality.status !== "usable" && <p className="mt-2 text-xs text-amber-800">Image quality: {link.image.quality.status}. {link.image.quality.reasons.join(" ")}</p>}
              {link.image.characteristic ? <div className="mt-2 rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-600">
                <p className="font-bold text-slate-700">Model-written region description — verify against the photo.</p>
                <p className="mt-1">“{link.image.characteristic.visibleRegion}”</p>
                <p className="mt-1">{link.image.characteristic.category} · {link.image.characteristic.certainty.replaceAll("_", " ")}</p>
                {link.image.characteristic.limitations && <p className="mt-1">Limitations: {link.image.characteristic.limitations}</p>}
              </div> : <p className="mt-2 text-xs text-slate-500">No model description is stored for this link.</p>}
            </div>}
            {onOpenSource && link.valid && <button type="button" onClick={() => onOpenSource(link.sourceId)} className="mt-2 inline-block text-xs font-semibold text-teal-800 underline">Open in original sources</button>}
          </div>)}
          {active.links.length === 0 && <p className="text-xs text-red-700">This sentence has no source evidence.</p>}
          {activeFinding?.limitation && <p className="text-xs leading-5 text-slate-500">Limitation: {activeFinding.limitation}</p>}
          {activeFinding?.reviewNote && <p className="text-xs leading-5 text-slate-500">Reviewer note: {activeFinding.reviewNote}</p>}
        </div>}
      </div>
    </div>
  </section>;
}

function chipText(link: EvidenceLink, images: { sourceId: string; label: string }[]) {
  if (!link.valid) return "Missing source";
  if (link.audio) return `${link.kind === "context" ? "Context · " : ""}Audio ${span(link.audio)}`;
  if (link.image) return `${link.kind === "context" ? "Context · " : ""}${images.find(image => image.sourceId === link.sourceId)?.label || "Photo"}`;
  if (link.kind === "context") return "Transcript context";
  if (link.kind === "spoken") return "Transcript · timing unavailable";
  return "Clinician entry";
}

function SealBadge({ seal }: { seal: SealState | "verifying" }) {
  if (seal === "verifying") return <p className="mt-3 text-xs text-slate-500" aria-live="polite">Verifying the approved note digest…</p>;
  if (seal.kind === "none") return null;
  if (seal.kind === "sealed") return <div className="seal-in mt-3 flex items-start gap-3 rounded-xl border border-teal-600 bg-teal-50 p-3 text-xs leading-5 text-teal-900" role="status">
    <ShieldCheck size={22} className="mt-0.5 shrink-0 text-teal-700" />
    <div><p className="font-bold">Sealed at revision {seal.revision} · SHA-256 {seal.digest.slice(0, 12)}…</p><p>This browser recomputed the digest from the approved note and it matches the server record. Typed signature (not authenticated): {seal.physician} · {new Date(seal.at).toLocaleString()}</p></div>
  </div>;
  if (seal.kind === "revoked") return <div className="mt-3 flex items-start gap-3 rounded-xl border border-amber-500 bg-amber-50 p-3 text-xs leading-5 text-amber-900" role="status">
    <ShieldAlert size={22} className="mt-0.5 shrink-0 text-amber-700" />
    <div><p className="font-bold">Approval revoked · approved at revision {seal.approvedRevision}, now revision {seal.currentRevision}</p><p>Changes since approval:</p><ul className="list-disc pl-5">{seal.changes.map((change, index) => <li key={index}>{change.action} · {new Date(change.at).toLocaleString()}</li>)}</ul></div>
  </div>;
  if (seal.kind === "mismatch") return <div className="mt-3 flex items-start gap-3 rounded-xl border border-red-600 bg-red-50 p-3 text-xs leading-5 text-red-900" role="alert">
    <ShieldAlert size={22} className="mt-0.5 shrink-0 text-red-700" />
    <div><p className="font-bold">Digest mismatch at revision {seal.revision}</p><p>The note this browser composes differs from the server-approved digest. Do not rely on this approval; report it.</p></div>
  </div>;
  return <p className="mt-3 text-xs text-slate-500" role="status">The approval digest cannot be verified in this browser (it needs HTTPS or localhost). The server-side approval remains authoritative.</p>;
}
