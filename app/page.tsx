"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Activity, ArrowLeft, Camera, Check, ChevronRight, Clipboard, FileText, ImagePlus, Link2, LoaderCircle, Mic, ScanLine, ShieldCheck, Sparkles, Square, TriangleAlert, Upload, ZoomIn } from "lucide-react";
import { PATIENTS, composeNote, reviewBlockers, sectionLabels, type Encounter, type Finding } from "@/lib/domain";

import { ClinicalContextEditor, ImageAnalysisContext } from "@/components/clinical-context";

type Stage = "patients" | "capture" | "review";
const card = "rounded-2xl border border-slate-200 bg-white shadow-sm shadow-slate-200/40";
const button = "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40";

async function send(action: string, data: Record<string, unknown> | FormData) {
  const response = await fetch(`/api/demo?action=${action}`, { method: "POST", body: data instanceof FormData ? data : JSON.stringify(data), headers: data instanceof FormData ? undefined : { "Content-Type": "application/json" }, cache: "no-store" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed.");
  return result;
}

export default function Dashboard() {
  const [encounters, setEncounters] = useState<Encounter[]>([]);
  const [current, setCurrent] = useState<Encounter | null>(null);
  const [stage, setStage] = useState<Stage>("patients");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pairUrl, setPairUrl] = useState("");
  const [qr, setQr] = useState("");
  const [zoom, setZoom] = useState(1);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [clinician, setClinician] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const active = useRef<Encounter | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const patient = PATIENTS.find(p => p.id === current?.patientId);
  const blockers = current ? reviewBlockers(current) : [];
  const note = current ? composeNote(current, Boolean(current.approval)) : "";

  function update(e: Encounter) {
    active.current = e;
    setCurrent(e);
    setEncounters(prev => [e, ...prev.filter(v => v.id !== e.id)]);
  }
  const reload = useCallback(async () => {
    const pair = new URLSearchParams(location.search).get("pair");
    if (pair) {
      const response = await fetch(`/api/demo?pair=${encodeURIComponent(pair)}`, { cache: "no-store" });
      const result = await response.json();
      history.replaceState(null, "", location.pathname);
      if (!response.ok) throw new Error(result.error);
      update(result.encounter); setStage("capture");
    } else {
      let response = await fetch("/api/demo", { cache: "no-store" });
      if (response.status === 401) {
        await send("bootstrap", {});
        response = await fetch("/api/demo", { cache: "no-store" });
      }
      if (!response.ok) throw new Error("Could not load the demo workspace.");
      setEncounters((await response.json()).encounters);
    }
  }, []);
  useEffect(() => { void reload().catch(error => setMessage(error.message)); }, [reload]);
  useEffect(() => {
    if (!pairUrl) { setQr(""); return; }
    void QRCode.toDataURL(pairUrl, { width: 224, margin: 2, color: { dark: "#12383b", light: "#ffffff" } }).then(setQr);
  }, [pairUrl]);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setSeconds(n => n + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => () => { recorder.current?.stop(); stream.current?.getTracks().forEach(t => t.stop()); }, []);

  async function act(action: string, payload: Record<string, unknown> = {}, after?: Stage) {
    if (!active.current) return;
    setBusy(true); setMessage("");
    try {
      const result = await send(action, { encounterId: active.current.id, revision: active.current.revision, ...payload });
      update(result.encounter);
      if (after) setStage(after);
      if (action === "pair") setPairUrl(`${location.origin}/?pair=${encodeURIComponent(result.token)}`);
      if (action === "export") setMessage("Export simulated. No external EHR was contacted.");
      else if (action === "approve") setMessage("Approved demo draft. Any later edit revokes approval.");
    } catch (error) { setMessage((error as Error).message); if (action === "analyze") void refreshCurrent(); }
    finally { setBusy(false); }
  }
  async function refreshCurrent() {
    try {
      const response = await fetch("/api/demo", { cache: "no-store" });
      const data = await response.json();
      const match = data.encounters?.find((v: Encounter) => v.id === active.current?.id);
      if (match) update(match);
    } catch { /* keep current state */ }
  }
  async function create(patientId: string) {
    setBusy(true); setMessage("");
    try { const result = await send("create", { patientId }); update(result.encounter); setPairUrl(""); setStage("capture"); }
    catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }
  async function upload(file: File | undefined, kind: "image" | "audio") {
    if (!file || !active.current) return;
    setBusy(true); setMessage("");
    try {
      const form = new FormData();
      form.append("encounterId", active.current.id); form.append("revision", String(active.current.revision)); form.append("kind", kind); form.append("file", file);
      const result = await send("upload", form);
      update(result.encounter);
      setMessage(kind === "image" ? "Image saved to the fictional encounter. Review the quality check before analysis." : "Audio captured. Run analysis to create a transcript and suggested findings.");
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }
  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { setMessage("This browser does not support microphone capture. Use HTTPS or localhost."); return; }
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.current = media;
      const mime = ["audio/webm", "audio/mp4"].find(type => MediaRecorder.isTypeSupported(type)) || "";
      const rec = new MediaRecorder(media, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        media.getTracks().forEach(t => t.stop()); stream.current = null; setRecording(false);
        if (chunks.length) void upload(new File(chunks, mime.includes("mp4") ? "encounter.mp4" : "encounter.webm", { type: mime || rec.mimeType }), "audio");
      };
      recorder.current = rec; setSeconds(0); rec.start(); setRecording(true);
    } catch { setMessage("Microphone permission was declined or unavailable."); }
  }
  function stopRecording() { recorder.current?.stop(); }
  async function copyNote() { try { await navigator.clipboard.writeText(note); setMessage("Draft copied with source IDs."); } catch { setMessage("Clipboard unavailable. Select the note text to copy it."); } }

  return <div className="min-h-screen bg-[#f3f7f7] text-slate-800 selection:bg-teal-100">
    <header className="border-b border-slate-200 bg-white/90"><div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8"><div className="flex items-center gap-3"><span className="rounded-xl bg-[#11383c] p-2.5 text-teal-200"><Activity size={22} /></span><div><p className="text-lg font-bold tracking-[.14em]">AURA</p><p className="text-[10px] font-medium tracking-[.17em] text-teal-700">VISUAL SCRIBE</p></div></div><span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-800">Synthetic demo · no real patients</span></div></header>
    <main className="mx-auto max-w-7xl px-5 pb-16 pt-8 sm:px-8">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4"><div><p className="text-[10px] font-bold uppercase tracking-[.2em] text-teal-700">Patient-linked documentation</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">{stage === "patients" ? "Encounter workspace" : stage === "capture" ? "Capture an encounter" : "Review the evidence"}</h1><p className="mt-2 text-sm text-slate-500">Scan a link, gather context, inspect each claim, then approve the draft.</p></div>{current && <button className={`${button} border border-slate-200 bg-white text-slate-600`} onClick={() => { setCurrent(null); active.current = null; setStage("patients"); setPairUrl(""); }}><ArrowLeft size={15} /> Encounters</button>}</div>
      {message && <p role="alert" className="mb-5 rounded-xl border border-teal-200 bg-teal-50 p-3 text-sm text-teal-900">{message}</p>}
      {stage === "patients" && <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <section className={`${card} p-6`}><h2 className="flex items-center gap-2 text-lg font-semibold"><ScanLine size={19} className="text-teal-700" /> Start with a fictional patient</h2><p className="mt-2 text-xs text-slate-500">No identity check or clinical system is connected in this demo.</p><div className="mt-6 space-y-3">{PATIENTS.map(p => <button disabled={busy} key={p.id} onClick={() => void create(p.id)} className="flex w-full items-center gap-4 rounded-xl border border-slate-200 p-4 text-left transition hover:border-teal-400 hover:bg-teal-50"><span className="flex size-11 items-center justify-center rounded-xl bg-teal-100 text-sm font-bold text-teal-800">{p.initials}</span><span className="flex-1"><strong className="block text-sm">{p.name}</strong><small className="text-slate-500">{p.record} · {p.detail}</small></span><ChevronRight size={16} /></button>)}</div></section>
        <section className={`${card} p-6`}><h2 className="flex items-center gap-2 text-lg font-semibold"><FileText size={19} className="text-teal-700" /> Saved encounter drafts</h2><div className="mt-5 space-y-3">{encounters.length ? encounters.map(e => <button key={e.id} onClick={() => { update(e); setStage(e.findings.length ? "review" : "capture"); }} className="flex w-full items-center justify-between rounded-xl border border-slate-200 p-4 text-left hover:border-teal-400"><span><strong className="block text-sm">{PATIENTS.find(p => p.id === e.patientId)?.name}</strong><small className="text-slate-500">{new Date(e.createdAt).toLocaleString()} · {e.approval ? "Approved" : "Needs review"}</small></span><ChevronRight size={16} /></button>) : <p className="rounded-xl bg-slate-50 p-6 text-sm text-slate-500">No encounters yet. Choose a patient to begin.</p>}</div></section>
      </div>}
      {current && stage !== "patients" && <>
        <div className={`${card} mb-6 flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5`}><div className="flex items-center gap-3"><span className="flex size-11 items-center justify-center rounded-xl bg-teal-100 font-bold text-teal-800">{patient?.initials}</span><div><p className="text-sm font-semibold">{patient?.name} <span className="ml-1 rounded bg-amber-50 px-1.5 py-1 text-[9px] uppercase text-amber-800">Fictional</span></p><p className="text-xs text-slate-500">{patient?.record} · {patient?.detail} · Encounter {current.id.slice(0, 8)}</p></div></div><div className="flex gap-2 text-xs font-semibold"><button onClick={() => setStage("capture")} className={`rounded-lg px-3 py-2 ${stage === "capture" ? "bg-teal-800 text-white" : "bg-slate-100"}`}>1 · Capture</button><button onClick={() => setStage("review")} className={`rounded-lg px-3 py-2 ${stage === "review" ? "bg-teal-800 text-white" : "bg-slate-100"}`}>2 · Review</button></div></div>
        {stage === "capture" && <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,.95fr)]">
          <div className="space-y-6"><ClinicalContextEditor encounter={current} disabled={busy || recording} onSave={context => void act("context", { context })} /><section className={`${card} p-5 sm:p-6`}><h2 className="text-base font-semibold">Confirm before capture</h2><p className="mt-2 text-xs leading-5 text-slate-500">In a real deployment, QR pairing would require clinician authentication and an independently verified patient identity. This local demo uses fictional records only.</p><div className="mt-5 space-y-3"><label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={current.patientConfirmed} onChange={e => void act("confirm", { confirmed: e.target.checked, consent: current.consent })} className="size-4 accent-teal-700" /> Patient and encounter confirmed</label><label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={current.consent} onChange={e => void act("confirm", { confirmed: current.patientConfirmed, consent: e.target.checked })} className="size-4 accent-teal-700" /> All participants consented to recording and processing</label></div><button disabled={busy} onClick={() => void act("pair")} className={`${button} mt-5 border border-teal-200 bg-teal-50 text-teal-800`}><Link2 size={15} /> Create one-use QR link</button>{pairUrl && <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4"><p className="text-xs text-slate-600">Scan this QR on a phone within 5 minutes. Anyone holding it can open this fictional encounter.</p>{qr && <img src={qr} alt="One-use pairing QR code" className="my-3 h-48 w-48 rounded bg-white" />}<a className="break-all text-xs text-teal-700 underline" href={pairUrl}>{pairUrl}</a></div>}</section>
          <section className={`${card} p-5 sm:p-6`}><h2 className="flex items-center gap-2 text-base font-semibold"><Mic size={19} className="text-teal-700" /> Encounter audio</h2><div className="my-5 flex h-16 items-center justify-center gap-1 rounded-xl bg-teal-50" aria-hidden="true">{Array.from({ length: 33 }, (_, i) => <span key={i} className={`w-1.5 rounded-full bg-teal-500 ${recording ? "audio-bar-active" : ""}`} style={{ height: `${10 + (i * 13 + i * i * 3) % 42}px`, animationDelay: `${i * -42}ms` }} />)}</div><p className="mb-4 text-xs text-slate-500">{recording ? `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "Audio is captured only after you start recording."}</p><button disabled={busy || !current.consent || !current.patientConfirmed} onClick={() => recording ? stopRecording() : void startRecording()} className={`${button} w-full bg-teal-800 text-white hover:bg-teal-700`}>{recording ? <Square size={16} /> : <Mic size={16} />}{recording ? "Stop and save recording" : "Start recording"}</button><p className="mt-3 text-[11px] leading-5 text-slate-500">Use short fictional dialogue. Speaker identity and patient statements must be checked during review.</p></section></div>
          <section className={`${card} p-5 sm:p-6`}><h2 className="flex items-center gap-2 text-base font-semibold"><Camera size={19} className="text-teal-700" /> Visual evidence</h2><p className="mt-2 text-xs text-slate-500">Photograph or upload a staged, non-patient image. Automated quality guidance is only a heuristic.</p><div className="mt-5 grid grid-cols-2 gap-2"><input ref={cameraInput} type="file" accept="image/jpeg,image/png" capture="environment" className="hidden" onChange={e => { void upload(e.target.files?.[0], "image"); e.target.value = ""; }} /><input ref={fileInput} type="file" accept="image/jpeg,image/png" className="hidden" onChange={e => { void upload(e.target.files?.[0], "image"); e.target.value = ""; }} /><button disabled={busy || !current.consent || !current.patientConfirmed} className={`${button} border border-slate-200`} onClick={() => cameraInput.current?.click()}><Camera size={16} /> Camera</button><button disabled={busy || !current.consent || !current.patientConfirmed} className={`${button} border border-slate-200`} onClick={() => fileInput.current?.click()}><Upload size={16} /> Upload</button></div><div className="mt-5 space-y-4">{current.sources.filter(s => s.kind === "image").map(s => <article key={s.id} className="rounded-xl border border-slate-200 p-3"><div className="h-44 overflow-hidden rounded-lg bg-slate-100"><img alt={`${s.label}, source ${s.id.slice(0, 8)}`} src={`/api/media/${s.mediaId}`} style={{ transform: `scale(${zoom})` }} className="h-full w-full object-contain" /></div><p className="mt-3 text-sm font-semibold">{s.label} <span className={`ml-2 rounded px-2 py-1 text-[10px] uppercase ${s.quality?.status === "retake" ? "bg-red-50 text-red-700" : s.quality?.status === "limited" ? "bg-amber-50 text-amber-800" : "bg-teal-50 text-teal-700"}`}>{s.quality?.status || "pending"}</span></p><p className="mt-1 text-xs text-slate-500">{s.width} × {s.height} · source {s.id.slice(0, 8)}</p>{s.quality?.reasons.map((r, i) => <p key={r} className="mt-2 text-xs text-amber-800">{r}. {s.quality?.guidance[i]}</p>)}</article>)}{!current.sources.some(s => s.kind === "image") && <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 text-xs text-slate-400"><ImagePlus size={27} /> No image captured yet</div>}</div>{current.sources.some(s => s.kind === "image") && <label className="mt-4 flex items-center gap-2 text-xs text-slate-500"><ZoomIn size={15} /> Preview zoom <input aria-label="Preview zoom" type="range" min="1" max="3" step="0.1" value={zoom} onChange={e => setZoom(Number(e.target.value))} className="flex-1 accent-teal-700" /> {zoom}×</label>}</section>
          <div className="lg:col-span-2"><div className={`${card} flex flex-wrap items-center justify-between gap-4 p-5`}><div><p className="font-semibold">Ready to propose findings?</p><p className="mt-1 text-xs text-slate-500">AI suggestions stay pending until a clinician reviews each one. Retake warnings remain visible.</p></div><button disabled={busy || recording || !current.consent || !current.patientConfirmed || !current.sources.some(s => s.kind === "image" || s.kind === "audio")} onClick={() => void act("analyze", {}, "review")} className={`${button} bg-teal-800 text-white`}>{busy ? <LoaderCircle className="animate-spin" size={16} /> : <Sparkles size={16} />} {busy ? "Processing…" : "Analyze & review"}</button></div></div>
        </div>}
        {stage === "review" && <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,.9fr)]"><div className="space-y-6">
          <ImageAnalysisContext encounter={current} disabled={busy} onAcknowledge={() => void act("acknowledge-warnings")} /><section className={`${card} p-5 sm:p-6`}><h2 className="text-base font-semibold">Evidence-backed findings</h2><p className="mt-2 text-xs text-slate-500">Open the cited source for each claim. Accept, edit, or reject every suggestion.</p>{current.analysis === "failed" && <p className="mt-4 text-sm text-red-700">{current.analysisError}</p>}{!current.findings.length && <p className="mt-5 rounded-xl bg-slate-50 p-6 text-sm text-slate-500">No suggestions yet. Return to capture and run analysis.</p>}<div className="mt-5 space-y-4">{current.findings.map(f => <FindingCard key={f.id} finding={f} sources={current.sources} disabled={busy} onSave={(review, text, reviewNote) => void act("review", { findingId: f.id, review, text, reviewNote })} />)}</div></section>
          <ManualFinding sources={current.sources} disabled={busy} onSave={(section, sourceId, text, evidenceQuote) => void act("manual", { section, sourceId, text, evidenceQuote })} />
          <section className={`${card} p-5 sm:p-6`}><h2 className="flex items-center gap-2 text-base font-semibold"><TriangleAlert size={18} className="text-amber-600" /> Uncertainty and conflicts</h2>{current.conflicts.length ? current.conflicts.map(c => <div key={c.id} className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="text-sm text-amber-900">{c.description}</p><label className="mt-3 block text-xs font-semibold">Clinician resolution<textarea defaultValue={c.resolution} onBlur={e => { if (e.target.value !== c.resolution) void act("resolve", { conflictId: c.id, resolution: e.target.value }); }} className="mt-2 w-full rounded-lg border border-amber-200 p-2 text-sm" rows={2} /></label></div>) : <p className="mt-3 text-xs text-slate-500">No automated left/right discrepancy flagged. Absence of a flag does not rule out other contradictions.</p>}<p className="mt-4 text-xs text-slate-500">Uncertain or limited-image findings require a reviewer note before approval. Image quality is never a diagnosis.</p></section>
          <section className={`${card} p-5 sm:p-6`}><h2 className="text-base font-semibold">Original sources</h2><div className="mt-4 space-y-3">{current.sources.map(s => <div id={`source-${s.id}`} key={s.id} className="scroll-mt-6 rounded-xl border border-slate-200 bg-slate-50 p-3"><p className="text-xs font-bold">{s.label} <span className="font-normal text-slate-500">· {s.id.slice(0, 8)}</span></p>{s.kind === "image" && <img src={`/api/media/${s.mediaId}`} alt={s.label} className="mt-3 max-h-64 w-full rounded-lg bg-white object-contain" />}{s.kind === "audio" && <audio className="mt-3 w-full" controls src={`/api/media/${s.mediaId}`} />}{s.kind === "transcript" && <p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-slate-600">{s.text}</p>}</div>)}</div></section>
        </div><div className="space-y-6"><section className={`${card} p-5 sm:p-6`}><h2 className="flex items-center gap-2 text-base font-semibold"><FileText size={19} className="text-teal-700" /> SOAP draft</h2><p className="mt-2 text-xs text-slate-500">{current.approval ? "Approved snapshot" : "Pending suggestions shown; rejected items omitted"}</p><div className="mt-5 space-y-5">{(["S", "O", "A", "P"] as const).map(section => <div key={section}><h3 className="border-b border-slate-100 pb-2 text-xs font-bold uppercase tracking-[.15em] text-teal-800">{section} · {sectionLabels[section]}</h3><div className="mt-2 whitespace-pre-wrap text-sm leading-7 text-slate-600">{current.findings.filter(f => f.section === section && (current.approval ? f.review === "accepted" : f.review !== "rejected")).map(f => <p key={f.id} className="mb-2">{!current.approval && f.review === "pending" && <span className="mr-2 rounded bg-amber-50 px-2 py-1 text-[10px] text-amber-700">PENDING</span>}{f.certainty !== "observed" && <span>[{f.certainty.replaceAll("_", " ")}] </span>}{f.text}{f.limitation && <span> (Limitation: {f.limitation})</span>}{f.reviewNote && <span> Reviewer: {f.reviewNote}</span>} <a href={`#source-${f.evidence[0]?.sourceId}`} className="text-xs text-teal-700 underline">[{f.evidence.map(v => v.sourceId.slice(0, 8)).join(", ")}]</a></p>)}{!current.findings.some(f => f.section === section && (current.approval ? f.review === "accepted" : f.review !== "rejected")) && <p>Not documented.</p>}</div></div>)}</div><button onClick={() => void copyNote()} className={`${button} mt-5 border border-slate-200`}><Clipboard size={16} /> Copy {current.approval ? "approved note" : "draft"}</button></section>
          <section className={`${card} p-5 sm:p-6`}><h2 className="flex items-center gap-2 text-base font-semibold"><ShieldCheck size={19} className="text-teal-700" /> Physician approval</h2>{blockers.length ? <ul className="mt-4 list-inside list-disc space-y-2 text-xs text-amber-800">{blockers.map(v => <li key={v}>{v}</li>)}</ul> : <p className="mt-3 text-xs text-teal-700">All automated review checks passed. Verify clinical correctness yourself.</p>}<label className="mt-5 block text-xs font-semibold text-slate-600">Reviewing clinician<input value={clinician} onChange={e => setClinician(e.target.value)} placeholder="Demo clinician name" className="mt-2 w-full rounded-lg border border-slate-200 p-3 text-sm" /></label><button disabled={busy || blockers.length > 0 || Boolean(current.approval)} onClick={() => void act("approve", { physician: clinician })} className={`${button} mt-4 w-full bg-teal-800 text-white`}><Check size={16} /> {current.approval ? "Approved" : "Approve draft"}</button><button disabled={busy || !current.approval} onClick={() => void act("export")} className={`${button} mt-3 w-full border border-slate-200 bg-white text-slate-700`}><Upload size={16} /> {current.export ? "Simulated export complete" : "Simulate EHR export"}</button><p className="mt-3 text-[11px] leading-5 text-slate-500">No external EHR integration. A real EHR write would require authenticated clinician identity, patient match, FHIR mapping, and idempotency.</p></section></div></div>}
      </>}
      <footer className="mt-10 border-t border-slate-200 pt-5 text-xs text-slate-400">AURA · Research prototype. Use fictional audio and non-patient imagery only. Saved demo files reside on this server until manually deleted.</footer>
    </main>
  </div>;
}

function FindingCard({ finding: f, sources, disabled, onSave }: { finding: Finding; sources: Encounter["sources"]; disabled: boolean; onSave: (review: Finding["review"], text: string, note: string) => void }) {
  const [text, setText] = useState(f.text);
  const [note, setNote] = useState(f.reviewNote);
  useEffect(() => { setText(f.text); setNote(f.reviewNote); }, [f.id, f.text, f.reviewNote]);
  return <article className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap gap-2"><span className="rounded bg-teal-50 px-2 py-1 text-[10px] font-bold uppercase text-teal-800">{sectionLabels[f.section]} · {f.origin}</span><span className={`rounded px-2 py-1 text-[10px] font-semibold uppercase ${f.certainty === "observed" ? "bg-slate-100 text-slate-600" : "bg-amber-50 text-amber-800"}`}>{f.certainty.replaceAll("_", " ")}</span><span className="rounded bg-slate-100 px-2 py-1 text-[10px] text-slate-600">{f.review}</span></div><label className="mt-3 block text-xs font-semibold text-slate-600">Proposed wording<textarea value={text} onChange={e => setText(e.target.value)} maxLength={500} rows={2} className="mt-2 w-full rounded-lg border border-slate-200 p-3 text-sm leading-6" /></label>{f.limitation && <p className="mt-2 text-xs text-amber-800">Limit: {f.limitation}</p>}<p className="mt-2 text-xs text-slate-500">{f.category ? `${f.category} · ` : ""}{f.origin === "visual" ? "Candidate visual observation; any transcript citation provides context only." : f.origin === "spoken" ? "Reported in conversation; not independently visually verified." : "Clinician supplied"}{f.provider ? ` · ${f.provider}` : ""}</p><p className="mt-3 text-xs font-bold text-slate-600">Evidence</p><div className="mt-1 space-y-1">{f.evidence.map((ev, i) => <p key={i} className="text-xs leading-5 text-slate-500"><a className="font-semibold text-teal-700 underline" href={`#source-${ev.sourceId}`}>{sources.find(s => s.id === ev.sourceId)?.label || "Missing source"} [{ev.sourceId.slice(0, 8)}]</a> — {ev.role === "context" ? "Transcript context (not visual proof): " : ""}{ev.quote}</p>)}</div>{sources.filter(s => s.kind === "image" && f.evidence.some(e => e.sourceId === s.id)).map(s => <a key={s.id} href={`#source-${s.id}`}><img src={`/api/media/${s.mediaId}`} alt={`Evidence: ${s.label}`} className="mt-3 h-28 rounded object-contain" /></a>)}<label className="mt-3 block text-xs font-semibold text-slate-600">Reviewer note for edits or uncertainty<input value={note} onChange={e => setNote(e.target.value)} maxLength={500} placeholder="Explain corrections or limitations" className="mt-2 w-full rounded-lg border border-slate-200 p-2.5 text-sm" /></label><div className="mt-3 flex gap-2"><button disabled={disabled || !text.trim()} onClick={() => onSave("accepted", text, note)} className={`${button} bg-teal-800 text-white`}>Accept</button><button disabled={disabled} onClick={() => onSave("rejected", text, note)} className={`${button} border border-slate-200 text-slate-600`}>Reject</button></div></article>;
}

function ManualFinding({ sources, disabled, onSave }: { sources: Encounter["sources"]; disabled: boolean; onSave: (section: string, sourceId: string, text: string, evidenceQuote: string) => void }) {
  const [section, setSection] = useState("O");
  const [sourceId, setSourceId] = useState("");
  const [wording, setWording] = useState("");
  const [evidence, setEvidence] = useState("");
  return <section className={`${card} p-5 sm:p-6`}><h2 className="text-base font-semibold">Add a clinician observation</h2><p className="mt-2 text-xs text-slate-500">Use this if AI is unavailable or missed something. Your words are labeled clinician supplied and still require review.</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold">SOAP section<select value={section} onChange={e => setSection(e.target.value)} className="mt-2 w-full rounded-lg border border-slate-200 p-2.5 text-sm">{(["S","O","A","P"] as const).map(s => <option key={s} value={s}>{sectionLabels[s]}</option>)}</select></label><label className="text-xs font-semibold">Source<select value={sourceId} onChange={e => setSourceId(e.target.value)} className="mt-2 w-full rounded-lg border border-slate-200 p-2.5 text-sm"><option value="">Select source</option>{sources.map(s => <option key={s.id} value={s.id}>{s.label} · {s.id.slice(0,8)}</option>)}</select></label></div><label className="mt-3 block text-xs font-semibold">Observation<textarea value={wording} maxLength={500} onChange={e => setWording(e.target.value)} rows={2} className="mt-2 w-full rounded-lg border border-slate-200 p-3 text-sm" placeholder="What did you observe or hear?" /></label><label className="mt-3 block text-xs font-semibold">Evidence description or transcript quote<input value={evidence} maxLength={250} onChange={e => setEvidence(e.target.value)} className="mt-2 w-full rounded-lg border border-slate-200 p-3 text-sm" placeholder="Precise visible region or spoken words" /></label><button disabled={disabled || !sourceId || !wording.trim() || !evidence.trim()} onClick={() => { onSave(section, sourceId, wording, evidence); setWording(""); setEvidence(""); }} className={`${button} mt-3 border border-teal-200 bg-teal-50 text-teal-800`}>Add for review</button></section>;
}
