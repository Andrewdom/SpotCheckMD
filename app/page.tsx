"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Activity, ArrowLeft, Camera, ChevronRight, Clipboard, FileText, ImagePlus, Link2, LoaderCircle, Mic, ScanLine, Sparkles, Square, TriangleAlert, Upload, ZoomIn } from "lucide-react";
import { PATIENTS, composeNote, reviewBlockers, sectionLabels, type Encounter, type Finding } from "@/lib/domain";

import { ClinicalContextEditor, ImageAnalysisContext } from "@/components/clinical-context";
import { PatientChartPanel } from "@/components/patient-chart";
import { EhrSubmission } from "@/components/ehr-submission";
import { formatChartContext } from "@/lib/ehr/types";
import { downsampleToPCM16 } from "@/lib/transcription/pcm";

type Stage = "patients" | "chart" | "capture" | "review";
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
  const [liveCaption, setLiveCaption] = useState("");
  const [liveCaptionState, setLiveCaptionState] = useState<"off" | "connecting" | "live" | "unavailable">("off");
  const [clinician, setClinician] = useState("");
  const [chartPatientId, setChartPatientId] = useState("");
  const [chartDirty, setChartDirty] = useState(false);
  const [focusNoteId, setFocusNoteId] = useState<string>();
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const liveSocket = useRef<WebSocket | null>(null);
  const liveAudioContext = useRef<AudioContext | null>(null);
  const liveProcessor = useRef<ScriptProcessorNode | null>(null);
  const liveSource = useRef<MediaStreamAudioSourceNode | null>(null);
  const liveGain = useRef<GainNode | null>(null);
  const liveTurns = useRef(new Map<string, string>());
  const liveSession = useRef(0);
  const active = useRef<Encounter | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const cameraStream = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
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
    const video = videoRef.current;
    const camera = cameraStream.current;
    if (!cameraOpen || !video || !camera) return;
    video.srcObject = camera;
    void video.play().catch(() => {
      setMessage("The camera preview could not start.");
      camera.getTracks().forEach(track => track.stop());
      cameraStream.current = null;
      setCameraOpen(false);
    });
  }, [cameraOpen]);
  useEffect(() => {
    if (stage === "capture" || !cameraStream.current) return;
    cameraStream.current.getTracks().forEach(track => track.stop());
    cameraStream.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOpen(false);
  }, [stage]);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setSeconds(n => n + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => () => {
    recorder.current?.stop();
    stopLiveTranscription(false);
    stream.current?.getTracks().forEach(track => track.stop());
    cameraStream.current?.getTracks().forEach(track => track.stop());
  }, []);

  function stopLiveTranscription(terminate = true) {
    liveSession.current++;
    const socket = liveSocket.current;
    if (terminate && socket?.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify({ type: "Terminate" })); } catch { /* socket already closing */ }
    }
    socket?.close(); liveSocket.current = null;
    liveProcessor.current?.disconnect(); liveProcessor.current = null;
    liveSource.current?.disconnect(); liveSource.current = null;
    liveGain.current?.disconnect(); liveGain.current = null;
    void liveAudioContext.current?.close(); liveAudioContext.current = null;
    setLiveCaptionState("off");
  }

  async function startLiveTranscription(media: MediaStream) {
    if (!active.current) return;
    const sessionId = ++liveSession.current;
    liveTurns.current.clear(); setLiveCaption(""); setLiveCaptionState("connecting");
    try {
      const response = await fetch("/api/transcription-token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ encounterId: active.current.id, revision: active.current.revision }), cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Live captions unavailable.");
      if (sessionId !== liveSession.current) return;
      const socket = new WebSocket(result.url);
      socket.binaryType = "arraybuffer"; liveSocket.current = socket;
      socket.onmessage = event => {
        try {
          const data = JSON.parse(String(event.data));
          if (data.type !== "Turn" || typeof data.transcript !== "string" || !data.transcript.trim()) return;
          const speaker = typeof data.speaker_label === "string" ? data.speaker_label : Array.isArray(data.words) && typeof data.words[0]?.speaker === "string" ? data.words[0].speaker : "Speaker";
          liveTurns.current.set(String(data.turn_order ?? liveTurns.current.size), `${speaker}: ${data.transcript}${data.end_of_turn ? "" : " …"}`);
          setLiveCaption([...liveTurns.current.values()].join("\n"));
        } catch { /* ignore non-transcript provider events */ }
      };
      socket.onopen = () => {
        if (sessionId !== liveSession.current) { socket.close(); return; }
        const context = new AudioContext();
        const source = context.createMediaStreamSource(media);
        const processor = context.createScriptProcessor(4096, 1, 1);
        const gain = context.createGain(); gain.gain.value = 0;
        processor.onaudioprocess = event => {
          if (socket.readyState !== WebSocket.OPEN) return;
          try { socket.send(downsampleToPCM16(event.inputBuffer.getChannelData(0), context.sampleRate)); }
          catch { setLiveCaptionState("unavailable"); }
        };
        source.connect(processor); processor.connect(gain); gain.connect(context.destination);
        liveAudioContext.current = context; liveSource.current = source; liveProcessor.current = processor; liveGain.current = gain;
        setLiveCaptionState("live");
      };
      socket.onerror = () => { if (sessionId === liveSession.current) setLiveCaptionState("unavailable"); };
      socket.onclose = () => { if (sessionId === liveSession.current && recording) setLiveCaptionState("unavailable"); };
    } catch {
      if (sessionId === liveSession.current) setLiveCaptionState("unavailable");
    }
  }

  async function act(action: string, payload: Record<string, unknown> = {}, after?: Stage) {
    if (!active.current) return false;
    setBusy(true); setMessage("");
    try {
      const result = await send(action, { encounterId: active.current.id, revision: active.current.revision, ...payload });
      update(result.encounter);
      if (after) setStage(after);
      if (action === "pair") setPairUrl(`${location.origin}/?pair=${encodeURIComponent(result.token)}`);
      if (action === "export" || action === "approve-send") setMessage("Approved note saved to this patient’s Demo EHR chart.");
      else if (action === "approve") setMessage("Approved demo draft. Any later edit revokes approval.");
      return true;
    } catch (error) { setMessage((error as Error).message); await refreshCurrent(); return false; }
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
  async function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMessage("Camera access is unavailable. Use HTTPS or localhost in a supported browser.");
      return;
    }
    try {
      const camera = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      cameraStream.current = camera;
      setCameraOpen(true);
    } catch {
      setMessage("Could not access the camera. Check browser permissions and use HTTPS.");
    }
  }

  function closeCamera() {
    cameraStream.current?.getTracks().forEach(track => track.stop());
    cameraStream.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOpen(false);
  }

  async function capturePhoto() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      setMessage("Wait for the camera preview, then try again.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      setMessage("Could not capture the image.");
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const photo = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, "image/jpeg", 0.92);
    });
    if (!photo) {
      setMessage("Could not create the image file.");
      return;
    }
    closeCamera();
    await upload(
      new File([photo], "camera-" + Date.now() + ".jpg", { type: "image/jpeg" }),
      "image",
    );
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
      void startLiveTranscription(media);
    } catch { setMessage("Microphone permission was declined or unavailable."); }
  }
  function stopRecording() { stopLiveTranscription(); recorder.current?.stop(); }
  async function copyNote() { try { await navigator.clipboard.writeText(note); setMessage("Draft copied with source IDs."); } catch { setMessage("Clipboard unavailable. Select the note text to copy it."); } }

  return <div className="min-h-screen bg-[#f3f7f7] text-slate-800 selection:bg-teal-100">
    <header className="border-b border-slate-200 bg-white/90"><div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8"><div className="flex items-center gap-3"><span className="rounded-xl bg-[#11383c] p-2.5 text-teal-200"><Activity size={22} /></span><div><p className="text-lg font-bold tracking-[.14em]">AURA</p><p className="text-[10px] font-medium tracking-[.17em] text-teal-700">VISUAL SCRIBE</p></div></div><span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-800">Synthetic demo · no real patients</span></div></header>
    <main className="mx-auto max-w-7xl px-5 pb-16 pt-8 sm:px-8">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4"><div><p className="text-[10px] font-bold uppercase tracking-[.2em] text-teal-700">Patient-linked documentation</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">{stage === "patients" ? "Encounter workspace" : stage === "chart" ? "Patient chart" : stage === "capture" ? "Capture an encounter" : "Review the evidence"}</h1><p className="mt-2 text-sm text-slate-500">Review the chart, capture the visit, and send the approved note to Demo EHR.</p></div>{(current || stage === "chart") && <button disabled={busy || recording} className={`${button} border border-slate-200 bg-white text-slate-600`} onClick={() => { setCurrent(null); active.current = null; setChartPatientId(""); setChartDirty(false); setFocusNoteId(undefined); setStage("patients"); setPairUrl(""); }}><ArrowLeft size={15} /> Encounters</button>}</div>
      {message && <p role="alert" className="mb-5 rounded-xl border border-teal-200 bg-teal-50 p-3 text-sm text-teal-900">{message}</p>}
      {stage === "patients" && <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <section className={`${card} p-6`}><h2 className="flex items-center gap-2 text-lg font-semibold"><ScanLine size={19} className="text-teal-700" /> Start with a fictional patient</h2><p className="mt-2 text-xs text-slate-500">Open a fictional patient chart from Demo EHR, then start a visit.</p><div className="mt-6 space-y-3">{PATIENTS.map(p => <button disabled={busy} key={p.id} onClick={() => { setCurrent(null); active.current = null; setChartPatientId(p.id); setFocusNoteId(undefined); setStage("chart"); }} className="flex w-full items-center gap-4 rounded-xl border border-slate-200 p-4 text-left transition hover:border-teal-400 hover:bg-teal-50"><span className="flex size-11 items-center justify-center rounded-xl bg-teal-100 text-sm font-bold text-teal-800">{p.initials}</span><span className="flex-1"><strong className="block text-sm">{p.name}</strong><small className="text-slate-500">{p.record} · {p.detail}</small></span><ChevronRight size={16} /></button>)}</div></section>
        <section className={`${card} p-6`}><h2 className="flex items-center gap-2 text-lg font-semibold"><FileText size={19} className="text-teal-700" /> Saved encounter drafts</h2><div className="mt-5 space-y-3">{encounters.length ? encounters.map(e => <button key={e.id} disabled={busy} onClick={() => { update(e); setFocusNoteId(undefined); setStage(e.findings.length ? "review" : "capture"); }} className="flex w-full items-center justify-between rounded-xl border border-slate-200 p-4 text-left hover:border-teal-400"><span><strong className="block text-sm">{PATIENTS.find(p => p.id === e.patientId)?.name}</strong><small className="text-slate-500">{new Date(e.createdAt).toLocaleString()} · {e.ehrReceipts?.some(receipt => receipt.id === e.export?.id) ? "Saved to Demo EHR" : e.approval ? "Approved" : "Needs review"}</small></span><ChevronRight size={16} /></button>) : <p className="rounded-xl bg-slate-50 p-6 text-sm text-slate-500">No encounters yet. Choose a patient to begin.</p>}</div></section>
      </div>}
      {stage !== "patients" && (current?.patientId || chartPatientId) && <>
        <PatientChartPanel key={`${current?.patientId || chartPatientId}-${current?.id || "profile"}`} patientId={current?.patientId || chartPatientId} encounter={current} full={stage === "chart"} disabled={busy || recording} focusNoteId={focusNoteId} onDirtyChange={setChartDirty} onSave={selection => act("chart-context", { selection })} />
        {stage === "chart" && !current && <div className="mb-6 flex justify-end"><button disabled={busy} onClick={() => void create(chartPatientId)} className={`${button} bg-teal-800 text-white`}>Start a new visit <ChevronRight size={16} /></button></div>}
      </>}
      {current && stage !== "patients" && <>
        <div className={`${card} mb-6 flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5`}><div className="flex items-center gap-3"><span className="flex size-11 items-center justify-center rounded-xl bg-teal-100 font-bold text-teal-800">{patient?.initials}</span><div><p className="text-sm font-semibold">{patient?.name} <span className="ml-1 rounded bg-amber-50 px-1.5 py-1 text-[9px] uppercase text-amber-800">Fictional</span></p><p className="text-xs text-slate-500">{patient?.record} · {patient?.detail} · Encounter {current.id.slice(0, 8)}</p></div></div><div className="flex gap-2 text-xs font-semibold"><button disabled={busy || recording} onClick={() => { setFocusNoteId(undefined); setStage("chart"); }} className={`rounded-lg px-3 py-2 ${stage === "chart" ? "bg-teal-800 text-white" : "bg-slate-100"}`}>Chart</button><button disabled={busy || recording} onClick={() => setStage("capture")} className={`rounded-lg px-3 py-2 ${stage === "capture" ? "bg-teal-800 text-white" : "bg-slate-100"}`}>1 · Capture</button><button disabled={busy || recording} onClick={() => setStage("review")} className={`rounded-lg px-3 py-2 ${stage === "review" ? "bg-teal-800 text-white" : "bg-slate-100"}`}>2 · Review</button></div></div>
        {stage === "capture" && <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,.95fr)]">
          <div className="space-y-6"><ClinicalContextEditor encounter={current} disabled={busy || recording} onSave={context => void act("context", { context })} /><section className={`${card} p-5 sm:p-6`}><h2 className="text-base font-semibold">Confirm before capture</h2><p className="mt-2 text-xs leading-5 text-slate-500">In a real deployment, QR pairing would require clinician authentication and an independently verified patient identity. This local demo uses fictional records only.</p><div className="mt-5 space-y-3"><label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={current.patientConfirmed} onChange={e => void act("confirm", { confirmed: e.target.checked, consent: current.consent })} className="size-4 accent-teal-700" /> Patient and encounter confirmed</label><label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={current.consent} onChange={e => void act("confirm", { confirmed: current.patientConfirmed, consent: e.target.checked })} className="size-4 accent-teal-700" /> All participants consented to recording and processing</label></div><button disabled={busy} onClick={() => void act("pair")} className={`${button} mt-5 border border-teal-200 bg-teal-50 text-teal-800`}><Link2 size={15} /> Create one-use QR link</button>{pairUrl && <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4"><p className="text-xs text-slate-600">Scan this QR on a phone within 5 minutes. Anyone holding it can open this fictional encounter.</p>{qr && <img src={qr} alt="One-use pairing QR code" className="my-3 h-48 w-48 rounded bg-white" />}<a className="break-all text-xs text-teal-700 underline" href={pairUrl}>{pairUrl}</a></div>}</section>
          <section className={`${card} p-5 sm:p-6`}><h2 className="flex items-center gap-2 text-base font-semibold"><Mic size={19} className="text-teal-700" /> Encounter audio</h2><div className="my-5 flex h-16 items-center justify-center gap-1 rounded-xl bg-teal-50" aria-hidden="true">{Array.from({ length: 33 }, (_, i) => <span key={i} className={`w-1.5 rounded-full bg-teal-500 ${recording ? "audio-bar-active" : ""}`} style={{ height: `${10 + (i * 13 + i * i * 3) % 42}px`, animationDelay: `${i * -42}ms` }} />)}</div><p className="mb-4 text-xs text-slate-500">{recording ? `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "Audio is captured only after you start recording."}</p><button disabled={busy || !current.consent || !current.patientConfirmed} onClick={() => recording ? stopRecording() : void startRecording()} className={`${button} w-full bg-teal-800 text-white hover:bg-teal-700`}>{recording ? <Square size={16} /> : <Mic size={16} />}{recording ? "Stop and save recording" : "Start recording"}</button>{recording && <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3"><p className="text-[10px] font-bold uppercase tracking-wider text-teal-800">{liveCaptionState === "live" ? "Live provisional transcript" : liveCaptionState === "connecting" ? "Connecting live captions" : liveCaptionState === "unavailable" ? "Live captions unavailable; recording continues" : "Recording"}</p><p className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs leading-5 text-slate-600">{liveCaption || "Waiting for speech…"}</p><p className="mt-2 text-[10px] text-slate-500">Provisional captions are never used as note evidence. The completed recording is transcribed again after the visit.</p></div>}<p className="mt-3 text-[11px] leading-5 text-slate-500">Use short fictional dialogue. Speaker identity and patient statements must be checked during review.</p></section></div>
          <section className={card + " p-5 sm:p-6"}>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Camera size={19} className="text-teal-700" />
              Visual evidence
            </h2>
            <p className="mt-2 text-xs text-slate-500">
              Photograph or upload a staged, non-patient image. Automated quality guidance is only a heuristic.
            </p>

            <div className="mt-5 grid grid-cols-2 gap-2">
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png"
                className="hidden"
                onChange={event => {
                  void upload(event.target.files?.[0], "image");
                  event.target.value = "";
                }}
              />
              <button
                disabled={busy || cameraOpen || !current.consent || !current.patientConfirmed}
                className={button + " border border-slate-200"}
                onClick={() => void openCamera()}
              >
                <Camera size={16} />
                Camera
              </button>
              <button
                disabled={busy || !current.consent || !current.patientConfirmed}
                className={button + " border border-slate-200"}
                onClick={() => fileInput.current?.click()}
              >
                <Upload size={16} />
                Upload
              </button>
            </div>

            {cameraOpen && (
              <div className="mt-4 space-y-3">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  aria-label="Live camera preview"
                  className="max-h-[28rem] w-full rounded-xl bg-black object-contain"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    className={button + " bg-teal-800 text-white"}
                    onClick={() => void capturePhoto()}
                  >
                    <Camera size={16} />
                    Capture photo
                  </button>
                  <button
                    type="button"
                    className={button + " border border-slate-200"}
                    onClick={closeCamera}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <div className="mt-5 space-y-4">
              {current.sources
                .filter(source => source.kind === "image")
                .map(source => (
                  <article key={source.id} className="rounded-xl border border-slate-200 p-3">
                    <div className="h-44 overflow-hidden rounded-lg bg-slate-100">
                      <img
                        alt={source.label + ", source " + source.id.slice(0, 8)}
                        src={"/api/media/" + source.mediaId}
                        style={{ transform: "scale(" + zoom + ")" }}
                        className="h-full w-full object-contain"
                      />
                    </div>
                    <p className="mt-3 text-sm font-semibold">
                      {source.label}
                      <span className={
                        "ml-2 rounded px-2 py-1 text-[10px] uppercase " +
                        (source.quality?.status === "retake"
                          ? "bg-red-50 text-red-700"
                          : source.quality?.status === "limited"
                            ? "bg-amber-50 text-amber-800"
                            : "bg-teal-50 text-teal-700")
                      }>
                        {source.quality?.status || "pending"}
                      </span>
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {source.width} × {source.height} · source {source.id.slice(0, 8)}
                    </p>
                    {source.quality?.reasons.map((reason, index) => (
                      <p key={reason} className="mt-2 text-xs text-amber-800">
                        {reason}. {source.quality?.guidance[index]}
                      </p>
                    ))}
                  </article>
                ))}

              {!current.sources.some(source => source.kind === "image") && (
                <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 text-xs text-slate-400">
                  <ImagePlus size={27} />
                  No image captured yet
                </div>
              )}
            </div>

            {current.sources.some(source => source.kind === "image") && (
              <label className="mt-4 flex items-center gap-2 text-xs text-slate-500">
                <ZoomIn size={15} />
                Preview zoom
                <input
                  aria-label="Preview zoom"
                  type="range"
                  min="1"
                  max="3"
                  step="0.1"
                  value={zoom}
                  onChange={event => setZoom(Number(event.target.value))}
                  className="flex-1 accent-teal-700"
                />
                {zoom}×
              </label>
            )}
          </section>
          <div className="lg:col-span-2"><div className={`${card} flex flex-wrap items-center justify-between gap-4 p-5`}><div><p className="font-semibold">Ready to propose findings?</p><p className="mt-1 text-xs text-slate-500">AI suggestions stay pending until a clinician reviews each one. Retake warnings remain visible.</p></div><button disabled={busy || recording || !current.consent || !current.patientConfirmed || !current.sources.some(s => s.kind === "image" || s.kind === "audio")} onClick={() => void act("analyze", {}, "review")} className={`${button} bg-teal-800 text-white`}>{busy ? <LoaderCircle className="animate-spin" size={16} /> : <Sparkles size={16} />} {busy ? "Processing…" : "Analyze & review"}</button></div></div>
        </div>}
        {stage === "review" && <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,.9fr)]"><div className="space-y-6">
          <TranscriptReview encounter={current} disabled={busy} onConfirm={(artifactId, patientSpeaker, clinicianSpeaker) => void act("transcript-roles", { artifactId, patientSpeaker, clinicianSpeaker })} onExtract={(artifactId, patientSpeaker) => void act("transcript-extractive", { artifactId, patientSpeaker })} />
          <ImageAnalysisContext encounter={current} disabled={busy} onAcknowledge={() => void act("acknowledge-warnings")} /><section className={`${card} p-5 sm:p-6`}><h2 className="text-base font-semibold">Evidence-backed findings</h2><p className="mt-2 text-xs text-slate-500">Open the cited source for each claim. Accept, edit, or reject every suggestion.</p>{current.analysis === "failed" && <p className="mt-4 text-sm text-red-700">{current.analysisError}</p>}{!current.findings.length && <p className="mt-5 rounded-xl bg-slate-50 p-6 text-sm text-slate-500">No suggestions yet. Return to capture and run analysis.</p>}<div className="mt-5 space-y-4">{current.findings.map(f => <FindingCard key={f.id} finding={f} sources={current.sources} disabled={busy} onSave={(review, text, reviewNote) => void act("review", { findingId: f.id, review, text, reviewNote })} />)}</div></section>
          <ManualFinding sources={current.sources} disabled={busy} onSave={(section, sourceId, text, evidenceQuote) => void act("manual", { section, sourceId, text, evidenceQuote })} />
          <section className={`${card} p-5 sm:p-6`}><h2 className="flex items-center gap-2 text-base font-semibold"><TriangleAlert size={18} className="text-amber-600" /> Uncertainty and conflicts</h2>{current.conflicts.length ? current.conflicts.map(c => <div key={c.id} className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="text-sm text-amber-900">{c.description}</p><label className="mt-3 block text-xs font-semibold">Clinician resolution<textarea defaultValue={c.resolution} onBlur={e => { if (e.target.value !== c.resolution) void act("resolve", { conflictId: c.id, resolution: e.target.value }); }} className="mt-2 w-full rounded-lg border border-amber-200 p-2 text-sm" rows={2} /></label></div>) : <p className="mt-3 text-xs text-slate-500">No automated left/right discrepancy flagged. Absence of a flag does not rule out other contradictions.</p>}<p className="mt-4 text-xs text-slate-500">Uncertain or limited-image findings require a reviewer note before approval. Image quality is never a diagnosis.</p></section>
          <section className={`${card} p-5 sm:p-6`}><h2 className="text-base font-semibold">Original sources</h2><div className="mt-4 space-y-3">{current.sources.map(s => <div id={`source-${s.id}`} key={s.id} className="scroll-mt-6 rounded-xl border border-slate-200 bg-slate-50 p-3"><p className="text-xs font-bold">{s.label} <span className="font-normal text-slate-500">· {s.id.slice(0, 8)}</span></p>{s.kind === "image" && <img src={`/api/media/${s.mediaId}`} alt={s.label} className="mt-3 max-h-64 w-full rounded-lg bg-white object-contain" />}{s.kind === "audio" && <audio className="mt-3 w-full" controls src={`/api/media/${s.mediaId}`} />}{s.kind === "transcript" && <p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-slate-600">{s.text}</p>}</div>)}</div></section>
        </div><div className="space-y-6"><section className={`${card} p-5 sm:p-6`}><h2 className="flex items-center gap-2 text-base font-semibold"><FileText size={19} className="text-teal-700" /> SOAP draft</h2><p className="mt-2 text-xs text-slate-500">{current.approval ? "Approved snapshot" : "Pending suggestions shown; rejected items omitted"}</p>{current.chartContext?.items.length ? <details className="mt-4 rounded-lg bg-slate-50 p-3"><summary className="cursor-pointer text-xs font-semibold text-teal-800">Reviewed chart background · {current.chartContext.items.length} records</summary><p className="mt-3 whitespace-pre-wrap text-xs leading-6 text-slate-600">{formatChartContext(current.chartContext)}</p><div className="mt-3 flex flex-wrap gap-2">{current.chartContext.items.map(item => <button key={item.id} type="button" onClick={() => { setFocusNoteId(item.id); setStage("chart"); window.scrollTo({ top: 0, behavior: "smooth" }); }} className="text-xs font-semibold text-teal-800 underline">Open source: {item.title}</button>)}</div></details> : null}<div className="mt-5 space-y-5">{(["S", "O", "A", "P"] as const).map(section => <div key={section}><h3 className="border-b border-slate-100 pb-2 text-xs font-bold uppercase tracking-[.15em] text-teal-800">{section} · {sectionLabels[section]}</h3><div className="mt-2 whitespace-pre-wrap text-sm leading-7 text-slate-600">{current.findings.filter(f => f.section === section && (current.approval ? f.review === "accepted" : f.review !== "rejected")).map(f => <p key={f.id} className="mb-2">{!current.approval && f.review === "pending" && <span className="mr-2 rounded bg-amber-50 px-2 py-1 text-[10px] text-amber-700">PENDING</span>}{f.certainty !== "observed" && <span>[{f.certainty.replaceAll("_", " ")}] </span>}{f.text}{f.limitation && <span> (Limitation: {f.limitation})</span>}{f.reviewNote && <span> Reviewer: {f.reviewNote}</span>} <a href={`#source-${f.evidence[0]?.sourceId}`} className="text-xs text-teal-700 underline">[{f.evidence.map(v => v.sourceId.slice(0, 8)).join(", ")}]</a></p>)}{!current.findings.some(f => f.section === section && (current.approval ? f.review === "accepted" : f.review !== "rejected")) && <p>Not documented.</p>}</div></div>)}</div><button onClick={() => void copyNote()} className={`${button} mt-5 border border-slate-200`}><Clipboard size={16} /> Copy {current.approval ? "approved note" : "draft"}</button></section>
          <EhrSubmission key={current.id} encounter={current} blockers={blockers} disabled={busy || recording} chartDirty={chartDirty} clinician={clinician} setClinician={setClinician} onSubmit={() => act(current.approval ? "export" : "approve-send", { physician: clinician })} onOpenNote={id => { setFocusNoteId(id); setStage("chart"); window.scrollTo({ top: 0, behavior: "smooth" }); }} /></div></div>}
      </>}
      <footer className="mt-10 border-t border-slate-200 pt-5 text-xs text-slate-400">AURA · Research prototype. Use fictional audio and non-patient imagery only. Saved demo files reside on this server until manually deleted.</footer>
    </main>
  </div>;
}

function displayTimestamp(milliseconds: number) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function TranscriptReview({ encounter, disabled, onConfirm, onExtract }: { encounter: Encounter; disabled: boolean; onConfirm: (artifactId: string, patientSpeaker: string, clinicianSpeaker: string) => void; onExtract: (artifactId: string, patientSpeaker: string) => void }) {
  const artifact = encounter.transcripts?.at(-1);
  const speakers = artifact ? [...new Set(artifact.utterances.map(utterance => utterance.speaker).filter(speaker => speaker !== "UNKNOWN"))] : [];
  const [patientSpeaker, setPatientSpeaker] = useState("");
  const [clinicianSpeaker, setClinicianSpeaker] = useState("");
  useEffect(() => {
    const roles = encounter.transcriptRoles?.artifactId === artifact?.id ? encounter.transcriptRoles : undefined;
    setPatientSpeaker(roles?.patientSpeaker || speakers[0] || "");
    setClinicianSpeaker(roles?.clinicianSpeaker || speakers.find(speaker => speaker !== (roles?.patientSpeaker || speakers[0])) || "");
  }, [artifact?.id, encounter.transcriptRoles?.confirmedAt]);
  if (!artifact) return null;
  return <section className={`${card} p-5 sm:p-6`}><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-semibold">Finalized encounter transcript</h2><p className="mt-1 text-xs text-slate-500">{artifact.provider} · {artifact.model} · immutable digest {artifact.digest.slice(0, 12)}</p></div><span className="rounded bg-teal-50 px-2 py-1 text-[10px] font-bold uppercase text-teal-800">{artifact.settings.medicalMode ? "Medical Mode" : "General transcription"}</span></div><p className="mt-3 text-xs leading-5 text-slate-500">This finalized post-visit transcript is the evidence source. Live captions were provisional and were not saved into the note.</p>{artifact.settings.keyterms.length > 0 && <p className="mt-2 text-xs text-slate-500">Key terms: {artifact.settings.keyterms.join(", ")}</p>}<div className="mt-4 max-h-80 space-y-2 overflow-auto rounded-xl bg-slate-50 p-3">{artifact.utterances.map(utterance => <div key={utterance.id} className="rounded-lg bg-white p-3 text-xs leading-5"><p className="font-bold text-teal-800">{utterance.speaker} · {displayTimestamp(utterance.startMs)}–{displayTimestamp(utterance.endMs)}</p><p className="mt-1 text-slate-700">{utterance.text}</p>{utterance.words.length > 0 && <p className="mt-1 text-[10px] text-slate-400">{utterance.words.length} timestamped words</p>}</div>)}</div>{speakers.length > 1 ? <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="text-xs font-semibold text-amber-900">Confirm the roles after listening to the recording. Diarization labels are not identities. In free local mode, the confirmed patient turns become pending Subjective findings.</p><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold">Patient speaker<select value={patientSpeaker} onChange={event => setPatientSpeaker(event.target.value)} className="mt-2 w-full rounded-lg border border-amber-200 bg-white p-2.5 text-sm">{speakers.map(speaker => <option key={speaker}>{speaker}</option>)}</select></label><label className="text-xs font-semibold">Clinician speaker<select value={clinicianSpeaker} onChange={event => setClinicianSpeaker(event.target.value)} className="mt-2 w-full rounded-lg border border-amber-200 bg-white p-2.5 text-sm">{speakers.map(speaker => <option key={speaker}>{speaker}</option>)}</select></label></div><button type="button" disabled={disabled || !patientSpeaker || !clinicianSpeaker || patientSpeaker === clinicianSpeaker} onClick={() => onConfirm(artifact.id, patientSpeaker, clinicianSpeaker)} className={`${button} mt-3 bg-teal-800 text-white`}>{encounter.transcriptRoles?.artifactId === artifact.id ? "Update speaker roles" : "Confirm speaker roles"}</button></div> : <div className="mt-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-900"><p>Two distinct speakers were not reliably identified. You can create exact extractive Subjective findings from this voice, but attribution remains unconfirmed until clinician review.</p><button type="button" disabled={disabled || !speakers[0]} onClick={() => onExtract(artifact.id, speakers[0])} className={`${button} mt-3 border border-amber-300 bg-white`}>Create local extractive findings</button></div>}</section>;
}

function FindingCard({ finding: f, sources, disabled, onSave }: { finding: Finding; sources: Encounter["sources"]; disabled: boolean; onSave: (review: Finding["review"], text: string, note: string) => void }) {
  const [text, setText] = useState(f.text);
  const [note, setNote] = useState(f.reviewNote);
  useEffect(() => { setText(f.text); setNote(f.reviewNote); }, [f.id, f.text, f.reviewNote]);
  return <article className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap gap-2"><span className="rounded bg-teal-50 px-2 py-1 text-[10px] font-bold uppercase text-teal-800">{sectionLabels[f.section]} · {f.origin}</span><span className={`rounded px-2 py-1 text-[10px] font-semibold uppercase ${f.certainty === "observed" ? "bg-slate-100 text-slate-600" : "bg-amber-50 text-amber-800"}`}>{f.certainty.replaceAll("_", " ")}</span><span className="rounded bg-slate-100 px-2 py-1 text-[10px] text-slate-600">{f.review}</span></div><label className="mt-3 block text-xs font-semibold text-slate-600">Proposed wording<textarea value={text} onChange={e => setText(e.target.value)} maxLength={500} rows={2} className="mt-2 w-full rounded-lg border border-slate-200 p-3 text-sm leading-6" /></label>{f.limitation && <p className="mt-2 text-xs text-amber-800">Limit: {f.limitation}</p>}<p className="mt-2 text-xs text-slate-500">{f.category ? `${f.category} · ` : ""}{f.origin === "visual" ? "Candidate visual observation; any transcript citation provides context only." : f.origin === "spoken" ? "Reported in conversation; not independently visually verified." : "Clinician supplied"}{f.provider ? ` · ${f.provider}` : ""}</p><p className="mt-3 text-xs font-bold text-slate-600">Evidence</p><div className="mt-1 space-y-1">{f.evidence.map((ev, i) => <p key={i} className="text-xs leading-5 text-slate-500"><a className="font-semibold text-teal-700 underline" href={`#source-${ev.sourceId}`}>{sources.find(s => s.id === ev.sourceId)?.label || "Missing source"} [{ev.sourceId.slice(0, 8)}]</a>{ev.transcript && <span> · {ev.transcript.speaker} · {displayTimestamp(ev.transcript.startMs)}–{displayTimestamp(ev.transcript.endMs)}</span>} — {ev.role === "context" ? "Transcript context (not visual proof): " : ""}{ev.quote}</p>)}</div>{sources.filter(s => s.kind === "image" && f.evidence.some(e => e.sourceId === s.id)).map(s => <a key={s.id} href={`#source-${s.id}`}><img src={`/api/media/${s.mediaId}`} alt={`Evidence: ${s.label}`} className="mt-3 h-28 rounded object-contain" /></a>)}<label className="mt-3 block text-xs font-semibold text-slate-600">Reviewer note for edits or uncertainty<input value={note} onChange={e => setNote(e.target.value)} maxLength={500} placeholder="Explain corrections or limitations" className="mt-2 w-full rounded-lg border border-slate-200 p-2.5 text-sm" /></label><div className="mt-3 flex gap-2"><button disabled={disabled || !text.trim()} onClick={() => onSave("accepted", text, note)} className={`${button} bg-teal-800 text-white`}>Accept</button><button disabled={disabled} onClick={() => onSave("rejected", text, note)} className={`${button} border border-slate-200 text-slate-600`}>Reject</button></div></article>;
}

function ManualFinding({ sources, disabled, onSave }: { sources: Encounter["sources"]; disabled: boolean; onSave: (section: string, sourceId: string, text: string, evidenceQuote: string) => void }) {
  const [section, setSection] = useState("O");
  const [sourceId, setSourceId] = useState("");
  const [wording, setWording] = useState("");
  const [evidence, setEvidence] = useState("");
  return <section className={`${card} p-5 sm:p-6`}><h2 className="text-base font-semibold">Add a clinician observation</h2><p className="mt-2 text-xs text-slate-500">Use this if AI is unavailable or missed something. Your words are labeled clinician supplied and still require review.</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold">SOAP section<select value={section} onChange={e => setSection(e.target.value)} className="mt-2 w-full rounded-lg border border-slate-200 p-2.5 text-sm">{(["S","O","A","P"] as const).map(s => <option key={s} value={s}>{sectionLabels[s]}</option>)}</select></label><label className="text-xs font-semibold">Source<select value={sourceId} onChange={e => setSourceId(e.target.value)} className="mt-2 w-full rounded-lg border border-slate-200 p-2.5 text-sm"><option value="">Select source</option>{sources.map(s => <option key={s.id} value={s.id}>{s.label} · {s.id.slice(0,8)}</option>)}</select></label></div><label className="mt-3 block text-xs font-semibold">Observation<textarea value={wording} maxLength={500} onChange={e => setWording(e.target.value)} rows={2} className="mt-2 w-full rounded-lg border border-slate-200 p-3 text-sm" placeholder="What did you observe or hear?" /></label><label className="mt-3 block text-xs font-semibold">Evidence description or transcript quote<input value={evidence} maxLength={250} onChange={e => setEvidence(e.target.value)} className="mt-2 w-full rounded-lg border border-slate-200 p-3 text-sm" placeholder="Precise visible region or spoken words" /></label><button disabled={disabled || !sourceId || !wording.trim() || !evidence.trim()} onClick={() => { onSave(section, sourceId, wording, evidence); setWording(""); setEvidence(""); }} className={`${button} mt-3 border border-teal-200 bg-teal-50 text-teal-800`}>Add for review</button></section>;
}
