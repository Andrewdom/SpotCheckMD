"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { Activity, ArrowLeft, Camera, Check, CheckCircle2, ChevronDown, ChevronRight, Clipboard, Cloud, FileText, ImagePlus, LoaderCircle, LogOut, Mic, Pencil, Plus, Quote, Sparkles, Square, TriangleAlert, Trash2, Upload, X, ZoomIn } from "lucide-react";

import { PATIENTS, composeNote, reviewBlockers, sectionLabels, type Encounter, type Finding } from "@/lib/domain";

import { ClinicalContextEditor, ImageAnalysisContext } from "@/components/clinical-context";
import { PatientChartPanel } from "@/components/patient-chart";
import { EhrSubmission } from "@/components/ehr-submission";
import { formatChartContext } from "@/lib/ehr/types";
import { downsampleToPCM16 } from "@/lib/transcription/pcm";

type Stage = "patients" | "chart" | "capture" | "review";
const card = "rounded-[18px] border border-[#e7e2de] bg-white shadow-[0_1px_2px_rgba(44,32,39,.03),0_10px_30px_rgba(44,32,39,.035)]";
const button = "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition duration-150 disabled:cursor-not-allowed disabled:opacity-40";
const primaryButton = `${button} bg-[#51384a] text-white shadow-[0_1px_2px_rgba(45,25,39,.18)] hover:bg-[#3f2939]`;
const secondaryButton = `${button} border border-[#dfdad6] bg-white text-[#48413f] hover:border-[#c8c0bb] hover:bg-[#faf8f6]`;

async function send(action: string, data: Record<string, unknown> | FormData) {
  const response = await fetch(`/api/demo?action=${action}`, { method: "POST", body: data instanceof FormData ? data : JSON.stringify(data), headers: data instanceof FormData ? undefined : { "Content-Type": "application/json" }, cache: "no-store" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed.");
  return result;
}

export default function Dashboard({ physician }: { physician: { displayName: string; username: string } }) {
  const [encounters, setEncounters] = useState<Encounter[]>([]);
  const [current, setCurrent] = useState<Encounter | null>(null);
  const [encounterToDelete, setEncounterToDelete] = useState<Encounter | null>(null);
  const [stage, setStage] = useState<Stage>("patients");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [dropTarget, setDropTarget] = useState<"image" | "audio" | null>(null);
  const [photoZooms, setPhotoZooms] = useState<Record<string, number>>({});
  const [photoPans, setPhotoPans] = useState<Record<string, { x: number; y: number }>>({});
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(null);
  const photoGalleryRef = useRef<HTMLDivElement>(null);
  const photoDrag = useRef<{
    sourceId: string;
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const photoPointers = useRef(new Map<number, {
    sourceId: string;
    pointerType: string;
    x: number;
    y: number;
  }>());
  const photoPinch = useRef<{
    sourceId: string;
    pointerIds: [number, number];
    startDistance: number;
    startZoom: number;
  } | null>(null);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [liveCaption, setLiveCaption] = useState("");
  const [liveCaptionState, setLiveCaptionState] = useState<"off" | "connecting" | "live" | "unavailable">("off");
  const [clinician, setClinician] = useState(physician.displayName);
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
  const newestPhotoId = current?.sources
    .filter(source => source.kind === "image")
    .reduce(
      (newest, source) =>
        !newest || source.createdAt > newest.createdAt ? source : newest,
      null as Encounter["sources"][number] | null,
    )?.id ?? null;
  const activePhotoId = selectedPhotoId ?? newestPhotoId;
  const activePhotoZoom = activePhotoId ? photoZooms[activePhotoId] ?? 1 : 1;
  const pendingCount = current?.findings.filter(finding => finding.review === "pending").length || 0;
  const reviewedCount = current ? current.findings.length - pendingCount : 0;
  const openEncounters = encounters.filter(encounter => !encounter.ehrReceipts?.some(receipt => receipt.id === encounter.export?.id));
  const capturedCount = current?.sources.filter(source => source.kind === "image" || source.kind === "audio").length || 0;

  useEffect(() => {
    const gallery = photoGalleryRef.current;
    if (!gallery) return;

    function handleWheel(event: WheelEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const preview = target.closest<HTMLElement>("[data-photo-id]");
      const sourceId = preview?.dataset.photoId;
      const galleryElement = photoGalleryRef.current;
      if (!preview || !sourceId || !galleryElement || !galleryElement.contains(preview)) return;

      event.preventDefault();
      setSelectedPhotoId(sourceId);

      const currentZoom = photoZooms[sourceId] ?? 1;
      const nextZoom = Math.max(
        1,
        Math.min(3, currentZoom * Math.exp(-event.deltaY * 0.0015)),
      );
      setPhotoZooms(current => ({
        ...current,
        [sourceId]: nextZoom,
      }));
      if (nextZoom === 1) {
        setPhotoPans(current => ({
          ...current,
          [sourceId]: { x: 0, y: 0 },
        }));
      }
    }

    gallery.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => gallery.removeEventListener("wheel", handleWheel, true);
  }, [photoZooms]);

  function update(e: Encounter) {
    active.current = e;
    setCurrent(e);
    setEncounters(prev => [e, ...prev.filter(v => v.id !== e.id)]);
  }
  function returnToWorkspace() {
    setCurrent(null);
    active.current = null;
    setChartPatientId("");
    setChartDirty(false);
    setFocusNoteId(undefined);
    setStage("patients");
  }
  const reload = useCallback(async () => {
    const response = await fetch("/api/demo", { cache: "no-store" });
    if (response.status === 401) {
      window.location.assign("/sign-in?reason=expired");
      return;
    }
    if (!response.ok) throw new Error("Could not load the demo workspace.");
    setEncounters((await response.json()).encounters);
  }, []);
  useEffect(() => { void reload().catch(error => setMessage(error.message)); }, [reload]);
  useEffect(() => {
    if (current?.analysis !== "running") return;
    let stopped = false;
    const poll = async () => {
      await refreshCurrent();
      if (!stopped && active.current?.analysis === "running") window.setTimeout(() => void poll(), 2000);
    };
    const timer = window.setTimeout(() => void poll(), 1200);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [current?.analysis, current?.id]);
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
          liveTurns.current.set(String(data.turn_order ?? liveTurns.current.size), `Doctor: ${data.transcript}${data.end_of_turn ? "" : " …"}`);
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
    try { const result = await send("create", { patientId }); update(result.encounter); setStage("capture"); }
    catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }
  async function deleteEncounter() {
    if (!encounterToDelete) return;

    setBusy(true);
    setMessage("");
    try {
      await send("delete-encounter", {
        encounterId: encounterToDelete.id,
        revision: encounterToDelete.revision,
      });
      setEncounters(previous =>
        previous.filter(encounter => encounter.id !== encounterToDelete.id),
      );
      setEncounterToDelete(null);
      setMessage("Saved encounter draft deleted.");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File | undefined, kind: "image" | "audio") {
    if (!file || !active.current) return;
    setBusy(true); setMessage("");
    try {
      const form = new FormData();
      form.append("encounterId", active.current.id); form.append("revision", String(active.current.revision)); form.append("kind", kind); form.append("file", file);
      const result = await send("upload", form);
      update(result.encounter);
      setMessage(kind === "image" ? "Image saved. Review its quality before analysis." : "Audio saved. Create the draft when capture is complete.");
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }
  function handleFileDragOver(event: DragEvent<HTMLDivElement>, kind: "image" | "audio") {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropTarget(kind);
  }

  function handleFileDragLeave(event: DragEvent<HTMLDivElement>, kind: "image" | "audio") {
    const nextTarget = event.relatedTarget;
    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
      setDropTarget(current => current === kind ? null : current);
    }
  }

  function handleFileDrop(event: DragEvent<HTMLDivElement>, kind: "image" | "audio") {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);

    if (busy) return;
    if (!current?.consent || !current.patientConfirmed) {
      setMessage("Confirm the patient and consent before uploading files.");
      return;
    }

    const file = event.dataTransfer.files[0];
    if (file) void upload(file, kind);
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
  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    window.location.assign("/sign-in?signedOut=1");
  }

  return <div className="min-h-screen bg-[#f8f7f5] text-[#292524] selection:bg-[#eadde6]">
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[268px] flex-col border-r border-[#e6e1dd] bg-[#f2efed] xl:flex">
      <div className="flex h-20 items-center gap-3 px-6"><span className="flex size-9 items-center justify-center rounded-xl bg-[#51384a] text-white"><Activity size={19} /></span><div><p className="text-[15px] font-bold tracking-[.12em]">AURA</p><p className="text-[10px] text-[#77706d]">Clinical workspace</p></div></div>
      <div className="px-4"><button type="button" disabled={busy || recording} onClick={returnToWorkspace} className={`${primaryButton} w-full justify-start px-3.5`}><Plus size={17} /> New encounter</button></div>
      <div className="mt-7 flex min-h-0 flex-1 flex-col"><p className="px-6 text-[10px] font-bold uppercase tracking-[.15em] text-[#98938a]">Recent encounters</p><nav className="soft-scrollbar mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto px-3" aria-label="Recent encounters">
        {encounters.length ? encounters.map(encounter => { const encounterPatient = PATIENTS.find(item => item.id === encounter.patientId); const selected = current?.id === encounter.id; const saved = encounter.ehrReceipts?.some(receipt => receipt.id === encounter.export?.id); return <button type="button" key={encounter.id} onClick={() => { update(encounter); setFocusNoteId(undefined); setStage(encounter.findings.length ? "review" : "capture"); }} className={`w-full rounded-xl px-3 py-3 text-left transition ${selected ? "bg-white shadow-sm" : "hover:bg-white/60"}`}><span className="block truncate text-sm font-semibold">{encounterPatient?.name}</span><span className="mt-1 flex items-center justify-between text-[11px] text-[#858078]"><span>{new Date(encounter.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}</span><span className={saved ? "text-[#39704a]" : encounter.findings.length ? "text-[#6b4a61]" : ""}>{saved ? "Saved" : encounter.findings.length ? "Review" : "Capture"}</span></span></button>; }) : <p className="px-3 py-4 text-xs leading-5 text-[#8d887f]">Your consultations will appear here.</p>}
      </nav></div>
      <div className="border-t border-[#e0ddd9] p-4"><div className="flex items-center gap-3 rounded-xl px-2 py-2"><span className="flex size-8 items-center justify-center rounded-full bg-[#ded9d5] text-xs font-bold">DR</span><span className="min-w-0 flex-1"><strong className="block truncate text-xs">{physician.displayName}</strong><small className="block truncate text-[10px] text-[#858078]">@{physician.username}</small></span><button type="button" onClick={() => void signOut()} className="rounded-lg p-2 text-[#858078] hover:bg-white hover:text-[#2e2c29]" aria-label="Sign out"><LogOut size={15} /></button></div></div>
    </aside>
    <div className="min-h-screen xl:pl-[268px]">
      <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-[#e7e4df] bg-[#fbfaf8]/95 px-4 backdrop-blur sm:px-7"><div className="flex min-w-0 items-center gap-3"><button type="button" disabled={busy || recording} onClick={returnToWorkspace} className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[#51384a] text-white xl:hidden" aria-label="Go to workspace"><Activity size={18} /></button><div className="min-w-0"><p className="truncate text-sm font-semibold">{current ? patient?.name : stage === "chart" ? PATIENTS.find(item => item.id === chartPatientId)?.name : "Clinical workspace"}</p><p className="truncate text-[11px] text-[#8a857d]">{current ? `${patient?.record} · ${patient?.detail}` : stage === "chart" ? "Demo EHR chart" : "Audio, images, chart context, and structured notes"}</p></div></div><div className="flex items-center gap-2">{current ? <span className="inline-flex items-center gap-1.5 rounded-full border border-[#dedad6] bg-white px-3 py-1.5 text-[10px] font-semibold text-[#716966]"><Cloud size={12} className="text-[#6a4a61]" /> Saved</span> : <span className="rounded-full border border-[#dedad6] bg-white px-3 py-1.5 text-[10px] font-semibold text-[#716966]">Synthetic workspace</span>}<button type="button" onClick={() => void signOut()} className="hidden rounded-lg p-2 text-[#858078] hover:bg-white hover:text-[#2e2c29] sm:block xl:hidden" aria-label="Sign out"><LogOut size={16} /></button></div></header>
      <main className="mx-auto max-w-[1320px] px-4 pb-16 pt-8 sm:px-7 lg:px-10">
      <div className="mb-8 flex flex-col justify-between gap-5 md:flex-row md:items-end"><div><p className="text-sm font-medium text-[#746c69]">{stage === "patients" ? `Welcome back, ${physician.displayName}` : stage === "chart" ? "Patient record" : new Date(current?.createdAt || Date.now()).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })}</p><h1 className={`mt-2 font-semibold tracking-[-.04em] ${stage === "patients" ? "max-w-3xl text-4xl sm:text-5xl" : "text-3xl"}`}>{stage === "patients" ? "Start or continue a consultation." : stage === "chart" ? "Review patient chart" : stage === "capture" ? "Capture consultation" : "Review clinical note"}</h1>{stage !== "patients" && <p className="mt-2 text-sm text-[#817976]">{stage === "chart" ? "Review available history before opening the encounter." : "Chart context, captured media, and the note remain linked to this encounter."}</p>}</div>{(current || stage === "chart") && <button disabled={busy || recording} className={`${secondaryButton} w-fit xl:hidden`} onClick={returnToWorkspace}><ArrowLeft size={15} /> Encounters</button>}</div>
      {message && <div role="status" className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-[#d9d4ca] bg-white px-4 py-3 text-sm shadow-sm"><span>{message}</span><button type="button" onClick={() => setMessage("")} aria-label="Dismiss message" className="text-xs font-semibold text-[#7e786f]">Dismiss</button></div>}
      {stage === "patients" && <div className="grid items-stretch gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(320px,.95fr)]">
        <section className={`${card} overflow-hidden`}><div className="border-b border-[#ece7e3] px-6 py-5"><h2 className="text-base font-semibold">New consultation</h2><p className="mt-1 text-xs text-[#817976]">Choose a patient to review their chart and begin capture.</p></div><div className="p-3">{PATIENTS.map(p => <button disabled={busy} key={p.id} onClick={() => { setCurrent(null); active.current = null; setChartPatientId(p.id); setFocusNoteId(undefined); setStage("chart"); }} className="group flex w-full items-center gap-4 rounded-2xl p-4 text-left transition hover:bg-[#f7f3f5] disabled:opacity-50"><span className="flex size-11 items-center justify-center rounded-full bg-[#f0e7ed] text-sm font-bold text-[#66485d]">{p.initials}</span><span className="min-w-0 flex-1"><strong className="block text-sm">{p.name}</strong><small className="mt-1 block text-[#827d75]">{p.record} · {p.detail}</small></span><ChevronRight size={17} className="text-[#aaa29e] transition group-hover:translate-x-0.5 group-hover:text-[#66485d]" /></button>)}</div></section>
        <section className={`${card} overflow-hidden`}>
          <div className="flex items-center justify-between border-b border-[#ece7e3] px-6 py-5"><div><h2 className="text-base font-semibold">Recent work</h2><p className="mt-1 text-xs text-[#817976]">Resume without rebuilding context.</p></div>{encounters.length > 0 && <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${openEncounters.length ? "bg-[#f2e8ee] text-[#66485d]" : "bg-[#e8f5ec] text-[#39704a]"}`}>{openEncounters.length ? `${openEncounters.length} open` : "Up to date"}</span>}</div>
          <div className="p-3">
            {encounters.length ? encounters.slice(0, 4).map(encounter => (
              <div
                key={encounter.id}
                className="flex items-center gap-2 rounded-2xl p-1 transition hover:bg-[#f8f5f6]"
              >
                <button
                  type="button"
                  onClick={() => {
                    update(encounter);
                    setFocusNoteId(undefined);
                    setStage(encounter.findings.length ? "review" : "capture");
                  }}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-3 text-left"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#f0ece9] text-xs font-bold">{PATIENTS.find(patient => patient.id === encounter.patientId)?.initials}</span><span className="min-w-0 flex-1">
                    <strong className="block truncate text-sm">
                      {PATIENTS.find(patient => patient.id === encounter.patientId)?.name}
                    </strong>
                    <small className="mt-0.5 block text-[#85807c]">
                      {new Date(
                        encounter.audit[encounter.audit.length - 1]?.at || encounter.createdAt,
                      ).toLocaleDateString([], { month: "short", day: "numeric" })} · {encounter.ehrReceipts?.some(receipt => receipt.id === encounter.export?.id) ? "Saved to Demo EHR" : encounter.approval ? "Approved" : encounter.findings.length ? "Review note" : "Capture"}
                    </small>
                  </span>
                  {encounter.ehrReceipts?.some(receipt => receipt.id === encounter.export?.id) ? <CheckCircle2 size={16} className="shrink-0 text-[#4d7b59]" /> : <ChevronRight size={15} className="shrink-0 text-[#aaa29e]" />}
                </button>
                <button
                  type="button"
                  aria-label={"Delete draft for " + (PATIENTS.find(patient => patient.id === encounter.patientId)?.name || "patient")}
                  title="Delete draft"
                  disabled={busy}
                  onClick={() => setEncounterToDelete(encounter)}
                  className="rounded-lg p-2 text-[#aaa29e] transition hover:bg-[#fff0ed] hover:text-[#9a3d32] disabled:opacity-40"
                >
                  <Trash2 size={17} />
                </button>
              </div>
            )) : (
              <div className="flex min-h-36 flex-col items-center justify-center px-5 text-center"><FileText size={20} className="text-[#aaa29e]" /><p className="mt-3 text-sm font-medium">No consultations yet</p><p className="mt-1 text-xs text-[#8a827f]">New encounters will be saved here.</p></div>
            )}
          </div>
        </section>

      </div>}
      {stage !== "patients" && (current?.patientId || chartPatientId) && <>
        <PatientChartPanel key={`${current?.patientId || chartPatientId}-${current?.id || "profile"}`} patientId={current?.patientId || chartPatientId} encounter={current} stage={stage as "chart" | "capture" | "review"} full={stage === "chart"} disabled={busy || recording} focusNoteId={focusNoteId} onDirtyChange={setChartDirty} onSave={selection => act("chart-context", { selection })} />
        {stage === "chart" && !current && <div className="mb-6 flex justify-end"><button disabled={busy} onClick={() => void create(chartPatientId)} className={primaryButton}>Start a new visit <ChevronRight size={16} /></button></div>}
      </>}
      {current && stage !== "patients" && <>
        <div className={`${card} mb-6 flex flex-col justify-between gap-4 p-4 sm:flex-row sm:items-center sm:p-5`}><div className="flex min-w-0 items-center gap-3"><span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[#f0e7ed] font-bold text-[#66485d]">{patient?.initials}</span><div className="min-w-0"><p className="truncate text-sm font-semibold">{patient?.name}</p><p className="truncate text-xs text-[#817976]">{patient?.record} · {patient?.detail}</p></div></div><div className="inline-flex w-fit max-w-full items-center overflow-x-auto rounded-xl border border-[#dfdad6] bg-[#efedeb] p-1 text-xs font-semibold" aria-label="Encounter progress"><button disabled={busy || recording} onClick={() => { setFocusNoteId(undefined); setStage("chart"); }} className={`shrink-0 rounded-lg px-3 py-2 transition ${stage === "chart" ? "bg-white text-[#292524] shadow-sm" : "text-[#77706d]"}`}>Chart</button><button disabled={busy || recording} onClick={() => setStage("capture")} className={`inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 transition ${stage === "capture" ? "bg-white text-[#292524] shadow-sm" : "text-[#77706d]"}`}><span className={`flex size-4 items-center justify-center rounded-full text-[9px] ${capturedCount ? "bg-[#e5f2e8] text-[#39704a]" : "bg-[#ddd7d3]"}`}>{capturedCount ? <Check size={10} /> : "1"}</span>Capture</button><button disabled={busy || recording} onClick={() => setStage("review")} className={`inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 transition ${stage === "review" ? "bg-white text-[#292524] shadow-sm" : "text-[#77706d]"}`}><span className={`flex size-4 items-center justify-center rounded-full text-[9px] ${current.findings.length > 0 && pendingCount === 0 ? "bg-[#e5f2e8] text-[#39704a]" : "bg-[#ddd7d3]"}`}>{current.findings.length > 0 && pendingCount === 0 ? <Check size={10} /> : "2"}</span>Review</button><span className={`hidden shrink-0 items-center gap-2 px-3 py-2 sm:inline-flex ${current.approval ? "text-[#39704a]" : "text-[#98908c]"}`}><span className={`flex size-4 items-center justify-center rounded-full text-[9px] ${current.approval ? "bg-[#e5f2e8]" : "bg-[#ddd7d3]"}`}>{current.approval ? <Check size={10} /> : "3"}</span>Sign off</span></div></div>
        {stage === "capture" && <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,.95fr)]">
          <div className="space-y-6"><section className={`${card} overflow-hidden`}><div className="p-5 sm:p-6"><div className="flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-full bg-[#f0e7ed] text-sm font-bold text-[#66485d]">{patient?.initials}</span><div><h2 className="text-sm font-semibold">{patient?.name}</h2><p className="text-[11px] text-[#817976]">{patient?.record} · Visit checks</p></div></div><div className="mt-5 space-y-3"><label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={current.patientConfirmed} onChange={e => void act("confirm", { confirmed: e.target.checked, consent: current.consent })} className="size-4 accent-[#65485d]" /> Patient and encounter confirmed</label><label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={current.consent} onChange={e => void act("confirm", { confirmed: current.patientConfirmed, consent: e.target.checked })} className="size-4 accent-[#65485d]" /> Recording and processing consent</label></div></div><div className="flex items-center justify-between border-t border-[#ece7e3] bg-[#faf8f7] px-5 py-3 text-[11px] text-[#7d7672]"><span className="inline-flex items-center gap-1.5"><Cloud size={12} /> Saved automatically</span><span>Revision {current.revision}</span></div></section><ClinicalContextEditor encounter={current} disabled={busy || recording} onSave={context => void act("context", { context })} />
          <section className={card + " p-5 sm:p-6"}>
            <div className="flex items-start justify-between gap-3"><div><h2 className="text-sm font-semibold">Ambient audio</h2><p className="mt-1 text-xs text-[#8a827f]">{recording ? "Capturing this consultation" : current.sources.some(source => source.kind === "audio") ? "Ready for note generation" : "Start when the visit begins"}</p></div>{recording && <span className="inline-flex items-center gap-2 rounded-full bg-[#fff0f1] px-2.5 py-1 text-[10px] font-bold text-[#a53a46]"><span className="status-pulse size-1.5 rounded-full bg-[#bd3745]" /> Recording live</span>}</div>
            <div
              className={`my-6 flex h-24 items-center justify-center gap-1 overflow-hidden rounded-2xl ${recording ? "bg-[#fff7f7]" : "bg-[#f7f5f3]"}`}
              aria-hidden="true"
            >
              {Array.from({ length: 33 }, (_, index) => (
                <span
                  key={index}
                  className={
                    `w-1.5 rounded-full ${recording ? "bg-[#bd5964]" : "bg-[#c9c2be]"} ` +
                    (recording ? "audio-bar-active" : "")
                  }
                  style={{
                    height: String(10 + (index * 13 + index * index * 3) % 42) + "px",
                    animationDelay: String(index * -42) + "ms",
                  }}
                />
              ))}
            </div>
            <p className={`mb-4 text-center ${recording ? "font-mono text-2xl font-semibold tabular-nums text-[#292524]" : "text-xs text-[#8a827f]"}`}>
              {recording
                ? "Recording " + Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0")
                : "Audio is captured only after you start recording."}
            </p>
            <button
              disabled={busy || !current.consent || !current.patientConfirmed}
              onClick={() => recording ? stopRecording() : void startRecording()}
              className={`${recording ? `${button} bg-[#a93643] text-white hover:bg-[#922f3a]` : primaryButton} w-full`}
            >
              {recording ? <Square size={16} /> : <Mic size={16} />}
              {recording ? "Stop and save recording" : "Start recording"}
            </button>
            {recording && <div className="mt-4 rounded-xl border border-[#e7e2de] bg-[#faf9f8] p-3"><p className="text-[10px] font-bold uppercase tracking-wider text-[#66485d]">{liveCaptionState === "live" ? "Live provisional transcript" : liveCaptionState === "connecting" ? "Connecting live captions" : liveCaptionState === "unavailable" ? "Live captions unavailable; recording continues" : "Recording"}</p><p className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs leading-5 text-[#69615e]">{liveCaption || "Waiting for speech…"}</p><p className="mt-2 text-[10px] text-[#8a827f]">The finalized post-visit transcript is the evidence source.</p></div>}
            <p className="mt-3 text-[11px] leading-5 text-[#8a827f]">
              Record doctor dictation only; do not record the patient's voice. Review the transcript and choose the correct SOAP section for each statement.
            </p>
            <div
              onDragOver={event => handleFileDragOver(event, "audio")}
              onDragLeave={event => handleFileDragLeave(event, "audio")}
              onDrop={event => handleFileDrop(event, "audio")}
              className={
                "mt-4 rounded-xl border-2 border-dashed p-4 text-center text-xs transition " +
                (dropTarget === "audio"
                  ? "border-[#8c6680] bg-[#f7f0f4] text-[#66485d]"
                  : "border-[#d8d0cc] text-[#817976]")
              }
            >
              {dropTarget === "audio" ? "Release to upload audio" : "Or drag an audio file here"}
            </div>
          </section></div>

          <section className={card + " p-5 sm:p-6"}>
            <h2 className="text-sm font-semibold">Photos</h2>
            <p className="mt-1 text-xs text-[#8a827f]">Add relevant visual context.</p>

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
                className={secondaryButton}
                onClick={() => void openCamera()}
              >
                <Camera size={16} />
                Camera
              </button>
              <button
                disabled={busy || !current.consent || !current.patientConfirmed}
                className={secondaryButton}
                onClick={() => fileInput.current?.click()}
              >
                <Upload size={16} />
                Upload
              </button>
            </div>

            <div
              onDragOver={event => handleFileDragOver(event, "image")}
              onDragLeave={event => handleFileDragLeave(event, "image")}
              onDrop={event => handleFileDrop(event, "image")}
              className={
                "mt-3 rounded-xl border-2 border-dashed p-4 text-center text-xs transition " +
                (dropTarget === "image"
                  ? "border-[#8c6680] bg-[#f7f0f4] text-[#66485d]"
                  : "border-[#d8d0cc] text-[#817976]")
              }
            >
              {dropTarget === "image" ? "Release to upload image" : "Or drag an image file here"}
            </div>

            {cameraOpen && (
              <div className="mt-4 space-y-3">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  aria-label="Live camera preview"
                  className="max-h-[28rem] w-full rounded-2xl bg-[#242120] object-contain"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    className={primaryButton}
                    onClick={() => void capturePhoto()}
                  >
                    <Camera size={16} />
                    Capture photo
                  </button>
                  <button
                    type="button"
                    className={secondaryButton}
                    onClick={closeCamera}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <div ref={photoGalleryRef} className="mt-5 space-y-4">
              {current.sources
                .filter(source => source.kind === "image")
                .map(source => (
                  <article
                    key={source.id}
                    className={
                      "rounded-xl border p-3 transition " +
                      (activePhotoId === source.id
                        ? "border-[#8c6680] ring-2 ring-[#eadde6]"
                        : "border-[#e7e2de]")
                    }
                  >
                    <div className="relative overflow-hidden rounded-lg bg-[#f2efed]">
                      <button
                        type="button"
                        data-photo-id={source.id}
                        aria-label={"Select " + source.label + " for zoom"}
                        aria-pressed={activePhotoId === source.id}
                        onClick={() => setSelectedPhotoId(source.id)}
                        onPointerDown={event => {
                          event.preventDefault();
                          setSelectedPhotoId(source.id);
                          event.currentTarget.setPointerCapture(event.pointerId);

                          photoPointers.current.set(event.pointerId, {
                            sourceId: source.id,
                            pointerType: event.pointerType,
                            x: event.clientX,
                            y: event.clientY,
                          });

                          const touchPointers = Array.from(photoPointers.current.entries())
                            .filter(([, pointer]) =>
                              pointer.sourceId === source.id && pointer.pointerType === "touch",
                            )
                            .slice(-2);

                          if (touchPointers.length === 2) {
                            const [[firstId, first], [secondId, second]] = touchPointers;
                            const startDistance = Math.hypot(
                              second.x - first.x,
                              second.y - first.y,
                            );
                            if (startDistance > 0) {
                              photoDrag.current = null;
                              photoPinch.current = {
                                sourceId: source.id,
                                pointerIds: [firstId, secondId],
                                startDistance,
                                startZoom: photoZooms[source.id] ?? 1,
                              };
                            }
                            return;
                          }

                          const imageZoom = photoZooms[source.id] ?? 1;
                          if (imageZoom <= 1) return;

                          const pan = photoPans[source.id] ?? { x: 0, y: 0 };
                          photoDrag.current = {
                            sourceId: source.id,
                            pointerId: event.pointerId,
                            startX: event.clientX,
                            startY: event.clientY,
                            originX: pan.x,
                            originY: pan.y,
                          };
                        }}
                        onPointerMove={event => {
                          const pointer = photoPointers.current.get(event.pointerId);
                          if (pointer?.sourceId === source.id) {
                            photoPointers.current.set(event.pointerId, {
                              ...pointer,
                              x: event.clientX,
                              y: event.clientY,
                            });
                          }

                          const pinch = photoPinch.current;
                          if (pinch?.sourceId === source.id) {
                            const first = photoPointers.current.get(pinch.pointerIds[0]);
                            const second = photoPointers.current.get(pinch.pointerIds[1]);
                            if (!first || !second) return;

                            event.preventDefault();
                            const distance = Math.hypot(second.x - first.x, second.y - first.y);
                            const nextZoom = Math.max(
                              1,
                              Math.min(3, pinch.startZoom * (distance / pinch.startDistance)),
                            );
                            setPhotoZooms(current => ({
                              ...current,
                              [source.id]: nextZoom,
                            }));
                            if (nextZoom === 1) {
                              setPhotoPans(current => ({
                                ...current,
                                [source.id]: { x: 0, y: 0 },
                              }));
                            }
                            return;
                          }

                          const drag = photoDrag.current;
                          if (!drag || drag.sourceId !== source.id || drag.pointerId !== event.pointerId) return;

                          event.preventDefault();
                          const frame = event.currentTarget.getBoundingClientRect();
                          const image = event.currentTarget.querySelector("img");
                          const imageWidth = image?.naturalWidth || frame.width;
                          const imageHeight = image?.naturalHeight || frame.height;
                          const fitScale = Math.min(frame.width / imageWidth, frame.height / imageHeight);
                          const imageZoom = photoZooms[source.id] ?? 1;
                          const maxX = (imageWidth * fitScale * (imageZoom - 1)) / 2;
                          const maxY = (imageHeight * fitScale * (imageZoom - 1)) / 2;
                          const x = Math.max(-maxX, Math.min(maxX, drag.originX + event.clientX - drag.startX));
                          const y = Math.max(-maxY, Math.min(maxY, drag.originY + event.clientY - drag.startY));

                          setPhotoPans(current => ({
                            ...current,
                            [source.id]: { x, y },
                          }));
                        }}
                        onPointerUp={event => {
                          photoPointers.current.delete(event.pointerId);
                          photoDrag.current = null;
                          if (photoPinch.current?.pointerIds.includes(event.pointerId)) {
                            photoPinch.current = null;
                          }
                        }}
                        onPointerCancel={event => {
                          photoPointers.current.delete(event.pointerId);
                          photoDrag.current = null;
                          photoPinch.current = null;
                        }}
                        onLostPointerCapture={event => {
                          photoPointers.current.delete(event.pointerId);
                          photoDrag.current = null;
                          if (photoPinch.current?.pointerIds.includes(event.pointerId)) {
                            photoPinch.current = null;
                          }
                        }}
                        className={
                          "block h-44 w-full touch-none select-none " +
                          ((photoZooms[source.id] ?? 1) > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in")
                        }
                      >
                        <img
                          draggable={false}
                          onDragStart={event => event.preventDefault()}
                          alt={source.label + ", source " + source.id.slice(0, 8)}
                          src={"/api/media/" + (source.previewMediaId || source.mediaId)}
                          style={{
                            transform:
                              "translate(" +
                              (photoPans[source.id]?.x ?? 0) +
                              "px, " +
                              (photoPans[source.id]?.y ?? 0) +
                              "px) scale(" +
                              (photoZooms[source.id] ?? 1) +
                              ")",
                          }}
                          className="h-full w-full object-contain transition-transform"
                        />
                      </button>
                      <button
                        type="button"
                        aria-label={"Remove " + source.label}
                        title="Remove image"
                        disabled={busy}
                        onClick={() => {
                          if (selectedPhotoId === source.id) setSelectedPhotoId(null);
                          setPhotoZooms(current => {
                            const next = { ...current };
                            delete next[source.id];
                            return next;
                          });
                          setPhotoPans(current => {
                            const next = { ...current };
                            delete next[source.id];
                            return next;
                          });
                          void act("remove-image", { sourceId: source.id });
                        }}
                        className="absolute right-2 top-2 z-10 rounded-full bg-black/70 p-1.5 text-white shadow transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <X size={15} />
                      </button>
                    </div>
                    <p className="mt-3 text-sm font-semibold">
                      {source.label}
                      <span className={
                        "ml-2 rounded px-2 py-1 text-[10px] uppercase " +
                        (source.quality?.status === "retake"
                          ? "bg-red-50 text-red-700"
                          : source.quality?.status === "limited"
                            ? "bg-amber-50 text-amber-800"
                            : "bg-[#e8f5ec] text-[#39704a]")
                      }>
                        {source.quality?.status || "pending"}
                      </span>
                    </p>
                    <p className="mt-1 text-xs text-[#817976]">
                      {source.width} × {source.height}
                    </p>
                    {source.imagePreparation && <details className="mt-2 text-[11px] text-[#817976]"><summary className="cursor-pointer font-medium text-[#75546c]">Image handling</summary><p className="mt-1 leading-5">Full-resolution inference copy: lossless PNG, orientation applied, metadata stripped. This screen uses a separate preview.</p></details>}
                    {source.quality?.reasons.map((reason, index) => (
                      <p key={reason} className="mt-2 text-xs text-amber-800">
                        {reason}. {source.quality?.guidance[index]}
                      </p>
                    ))}
                  </article>
                ))}

              {!current.sources.some(source => source.kind === "image") && (
                <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[#d8d0cc] bg-[#faf9f8] text-xs text-[#918986]">
                  <ImagePlus size={27} />
                  Add a photo
                </div>
              )}
            </div>

            {current.sources.some(source => source.kind === "image") && (
              <div className="mt-4 space-y-2">
                <p className="text-xs font-medium text-[#75546c]">
                  {selectedPhotoId
                    ? "Selected photo only — pinch or scroll to zoom, then drag to inspect."
                    : "Newest photo selected by default. Pinch or scroll to zoom, then drag to inspect."}
                </p>
                <label className="flex items-center gap-2 text-xs text-[#7e7673]">
                <ZoomIn size={15} />
                Preview zoom
                <input
                  aria-label="Preview zoom"
                  type="range"
                  min="1"
                  max="3"
                  step="0.1"
                  value={activePhotoZoom}
                  onChange={event => {
                    if (!activePhotoId) return;
                    const nextZoom = Number(event.target.value);
                    setPhotoZooms(current => ({
                      ...current,
                      [activePhotoId]: nextZoom,
                    }));
                    if (nextZoom === 1) {
                      setPhotoPans(current => ({
                        ...current,
                        [activePhotoId]: { x: 0, y: 0 },
                      }));
                    }
                  }}
                  className="flex-1 accent-[#65485d]"
                />
                {activePhotoZoom.toFixed(2)}×
                </label>
              </div>
            )}
          </section>
          <div className="lg:col-span-2"><div className={`${card} flex flex-col justify-between gap-4 border-[#dfd0d9] bg-[#fcf9fb] p-5 sm:flex-row sm:items-center sm:p-6`}><div><p className="text-sm font-semibold">Ready to create the note?</p><p className="mt-1 text-xs text-[#817976]">{current.analysis === "running" ? `Analysis is ${current.activeAnalysis?.status === "processing" ? "processing" : "queued"}. You can leave this page while it finishes.` : `${capturedCount} ${capturedCount === 1 ? "source" : "sources"} captured`}</p></div><button disabled={busy || recording || current.analysis === "running" || !current.consent || !current.patientConfirmed || !current.sources.some(s => s.kind === "image" || s.kind === "audio")} onClick={() => void act("analyze", {}, "review")} className={primaryButton}>{busy || current.analysis === "running" ? <LoaderCircle className="animate-spin" size={16} /> : <Sparkles size={16} />}{busy ? "Queuing…" : current.analysis === "running" ? current.activeAnalysis?.status === "processing" ? "Creating draft…" : "Queued…" : "Create SOAP draft"}</button></div></div>
        </div>}
        {stage === "review" && (
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_390px]">
            <div className="space-y-6">
              <section className={`${card} overflow-hidden`}>
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#ece7e3] px-5 py-5 sm:px-7">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[.16em] text-[#8a627d]">Clinical note</p>
                    <h2 className="mt-1 text-xl font-semibold tracking-[-.02em]">SOAP draft</h2>
                    <p className="mt-1 text-xs text-[#817976]">{current.approval ? "Approved snapshot" : `${reviewedCount} of ${current.findings.length} suggestions reviewed`}</p>
                  </div>
                  <button onClick={() => void copyNote()} className={secondaryButton}><Clipboard size={15} />Copy {current.approval ? "approved note" : "draft"}</button>
                </div>
                <div className="mx-5 mt-5 rounded-xl border border-[#e7e2de] bg-[#faf9f8] p-4 sm:mx-7">
                  <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">Reviewed patient history</h3><p className="mt-1 text-xs text-[#817976]">{current.chartContext?.items.length ? `${current.chartContext.items.length} chart ${current.chartContext.items.length === 1 ? "item" : "items"} saved for this note` : "No chart items saved for this note"}</p></div><button type="button" disabled={busy || recording} onClick={() => { setFocusNoteId(undefined); setStage("chart"); window.scrollTo({ top: 0, behavior: "smooth" }); }} className="text-xs font-semibold text-[#75546c] underline">Review chart</button></div>
                  {!!current.chartContext?.items.length && <>
                    <div className="mt-4 grid gap-2 sm:grid-cols-2">{current.chartContext.items.slice(0, 4).map(item => <button key={item.id} type="button" onClick={() => { setFocusNoteId(item.id); setStage("chart"); window.scrollTo({ top: 0, behavior: "smooth" }); }} className="rounded-lg border border-[#e7e2de] bg-white p-3 text-left hover:border-[#c9b3c1]"><span className="block text-xs font-semibold">{item.title}</span><span className="mt-1 block text-[11px] text-[#817976]">{item.category} · {item.confirmedToday ? "Confirmed this visit" : "Historical chart entry"}</span></button>)}</div>
                    {current.chartContext.items.length > 4 && <p className="mt-2 text-[11px] text-[#817976]">+{current.chartContext.items.length - 4} more reviewed {current.chartContext.items.length - 4 === 1 ? "item" : "items"}</p>}
                    <details className="mt-3"><summary className="cursor-pointer text-xs font-semibold text-[#75546c]">View full reviewed background</summary><p className="mt-3 whitespace-pre-wrap text-xs leading-6 text-[#6f6865]">{formatChartContext(current.chartContext)}</p></details>
                  </>}
                </div>
                <div className="px-5 py-2 sm:px-7">
                  {(["S", "O", "A", "P"] as const).map(section => {
                    const sectionFindings = current.findings.filter(f => f.section === section && (current.approval ? f.review === "accepted" : f.review !== "rejected"));
                    return <div key={section} className="grid gap-3 border-b border-[#eeeae7] py-6 last:border-0 sm:grid-cols-[132px_1fr]">
                      <div>
                        <span className="flex size-8 items-center justify-center rounded-lg bg-[#f0e7ed] text-xs font-bold text-[#66485d]">{section}</span>
                        <h3 className="mt-2 text-xs font-semibold text-[#625a57]">{sectionLabels[section]}</h3>
                      </div>
                      <div className="space-y-3 text-[15px] leading-7 text-[#48413f]">
                        {sectionFindings.map(f => <p key={f.id}>{!current.approval && f.review === "pending" && <span className="mr-2 rounded-md bg-[#fff3dd] px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[#8a5c14]">Review</span>}{f.certainty !== "observed" && <span className="text-[#805b1f]">[{f.certainty.replaceAll("_", " ")}] </span>}{f.text}{f.limitation && <span className="text-[#746c68]"> (Limitation: {f.limitation})</span>}{f.reviewNote && <span className="text-[#746c68]"> Reviewer: {f.reviewNote}</span>}{" "}<a onClick={() => document.getElementById(`source-${f.evidence[0]?.sourceId}`)?.closest("details")?.setAttribute("open", "")} href={`#source-${f.evidence[0]?.sourceId}`} className="text-xs font-medium text-[#75546c] underline">[{f.evidence.map(v => v.sourceId.slice(0, 8)).join(", ")}]</a></p>)}
                        {!sectionFindings.length && <p className="text-[#918986]">Not documented.</p>}
                      </div>
                    </div>;
                  })}
                </div>
              </section>

              <TranscriptReview encounter={current} />
              <ImageAnalysisContext encounter={current} disabled={busy} onAcknowledge={() => void act("acknowledge-warnings")} />

              <details className="group rounded-[18px] border border-[#e7e2de] bg-white p-5 shadow-[0_1px_2px_rgba(44,32,39,.03)] sm:p-6" open={current.conflicts.some(c => !c.resolution.trim())}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-sm font-semibold"><TriangleAlert size={17} className="text-[#a86c18]" />Uncertainty and conflicts {current.conflicts.length > 0 && <span className="rounded-full bg-[#fff3dd] px-2 py-0.5 text-[10px] text-[#8a5c14]">{current.conflicts.length}</span>}</span>
                  <ChevronDown size={15} className="text-[#918986] transition group-open:rotate-180" />
                </summary>
                <div className="mt-4 border-t border-[#ece7e3] pt-4">
                  {current.conflicts.length ? current.conflicts.map(c => <div key={c.id} className="mt-3 rounded-xl border border-[#ead8bd] bg-[#fff8eb] p-4 first:mt-0"><p className="text-sm text-[#6f4e1a]">{c.description}</p><label className="mt-3 block text-xs font-semibold">Clinician resolution<textarea defaultValue={c.resolution} onBlur={e => { if (e.target.value !== c.resolution) void act("resolve", { conflictId: c.id, resolution: e.target.value }); }} className="mt-2 w-full rounded-xl border border-[#dfc9a7] bg-white p-3 text-sm outline-none focus:border-[#9a708d]" rows={2} /></label></div>) : <p className="text-xs text-[#817976]">No automated left/right discrepancy flagged.</p>}
                  <p className="mt-4 text-xs text-[#817976]">Add a reviewer note for uncertain or limited-image findings before sign off.</p>
                </div>
              </details>

              <details id="original-sources" className="group rounded-[18px] border border-[#e7e2de] bg-white p-5 shadow-[0_1px_2px_rgba(44,32,39,.03)] sm:p-6">
                <summary className="flex cursor-pointer list-none items-center justify-between"><span><span className="block text-sm font-semibold">Source material</span><span className="mt-1 block text-[11px] text-[#817976]">{current.sources.length} captured {current.sources.length === 1 ? "source" : "sources"}</span></span><ChevronDown size={15} className="text-[#918986] transition group-open:rotate-180" /></summary>
                <div className="mt-4 space-y-3 border-t border-[#ece7e3] pt-4">{current.sources.map(s => <div id={`source-${s.id}`} key={s.id} className="scroll-mt-24 rounded-xl border border-[#e7e2de] bg-[#faf9f8] p-3"><p className="text-xs font-semibold">{s.label} <span className="font-normal text-[#918986]">· {s.id.slice(0, 8)}</span></p>{s.kind === "image" && <img src={`/api/media/${s.previewMediaId || s.mediaId}`} alt={s.label} className="mt-3 max-h-72 w-full rounded-lg bg-white object-contain" />}{s.kind === "audio" && <audio className="mt-3 w-full" controls src={`/api/media/${s.mediaId}`} />}{s.kind === "transcript" && <p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-[#6f6865]">{s.text}</p>}</div>)}</div>
              </details>
            </div>

            <aside className="space-y-5 xl:sticky xl:top-24">
              <section className={`${card} p-5`}>
                <div className="flex items-start justify-between gap-3">
                  <div><p className="text-[11px] font-semibold uppercase tracking-[.14em] text-[#8a627d]">Review queue</p><h2 className="mt-1 text-base font-semibold">Suggested findings</h2></div>
                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${pendingCount ? "bg-[#fff3dd] text-[#8a5c14]" : current.findings.length ? "bg-[#e8f3ea] text-[#39704a]" : "bg-[#f1efed] text-[#746c68]"}`}>{pendingCount ? `${pendingCount} left` : current.findings.length ? "Reviewed" : "No findings"}</span>
                </div>
                <p className="mt-2 text-xs leading-5 text-[#817976]">Include, edit, or exclude each suggestion from the final note.</p>
                {current.analysis === "running" && <p className="mt-4 flex items-center gap-2 rounded-xl bg-[#f6f1f4] p-3 text-xs text-[#66485d]"><LoaderCircle className="animate-spin" size={15} />{current.activeAnalysis?.status === "processing" ? "Visual analysis is processing." : "Visual analysis is queued."}</p>}
                {current.analysis === "failed" && <p role="alert" className="mt-4 rounded-xl bg-[#fff0ee] p-3 text-xs text-[#9b3d34]">{current.analysisError}</p>}
                {!current.findings.length && current.analysis !== "running" && <p className="mt-4 rounded-xl bg-[#faf9f8] p-4 text-xs leading-5 text-[#817976]">No suggestions yet. Add a clinician observation or return to Capture to create a draft.</p>}
                <div className="mt-4 space-y-3">{current.findings.map(f => <FindingCard key={f.id} finding={f} sources={current.sources} disabled={busy} onSave={(review, text, reviewNote) => void act("review", { findingId: f.id, review, text, reviewNote })} />)}</div>
              </section>
              <ManualFinding sources={current.sources} disabled={busy} onSave={(section, sourceId, text, evidenceQuote) => void act("manual", { section, sourceId, text, evidenceQuote })} />
              <EhrSubmission key={current.id} encounter={current} blockers={blockers} disabled={busy || recording} chartDirty={chartDirty} clinician={clinician} setClinician={setClinician} onSubmit={() => act(current.approval ? "export" : "approve-send", { physician: clinician })} onOpenNote={id => { setFocusNoteId(id); setStage("chart"); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
            </aside>
          </div>
        )}
      </>}
      {encounterToDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
          onClick={event => {
            if (event.target === event.currentTarget && !busy) setEncounterToDelete(null);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-encounter-title"
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
          >
            <div className="flex items-start gap-3">
              <span className="rounded-full bg-red-50 p-2 text-red-700">
                <Trash2 size={19} />
              </span>
              <div>
                <h2 id="delete-encounter-title" className="text-lg font-semibold">
                  Delete this encounter draft?
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  This permanently deletes the saved draft and its uploaded media. This action cannot be undone.
                </p>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setEncounterToDelete(null)}
                className={button + " border border-slate-200"}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void deleteEncounter()}
                className={button + " bg-red-700 text-white hover:bg-red-800"}
              >
                {busy ? "Deleting…" : "Delete draft"}
              </button>
            </div>
          </section>
        </div>
      )}
      <footer className="mt-10 border-t border-[#e6e1dd] pt-5 text-xs text-[#918986]">AURA · Synthetic clinical workspace</footer>
      </main>
    </div>
  </div>;
}

function displayTimestamp(milliseconds: number) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function TranscriptReview({ encounter }: { encounter: Encounter }) {
  const artifact = encounter.transcripts?.at(-1);
  if (!artifact) return null;

  return (
    <details className="group rounded-[18px] border border-[#e7e2de] bg-white p-5 shadow-[0_1px_2px_rgba(44,32,39,.03)] sm:p-6">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
        <span>
          <span className="block text-sm font-semibold">Final transcript</span>
          <span className="mt-1 block text-[11px] text-[#817976]">{artifact.utterances.length} segments · {artifact.provider}</span>
        </span>
        <span className="flex items-center gap-3">
          <span className="hidden rounded-full bg-[#f0e7ed] px-2.5 py-1 text-[10px] font-semibold text-[#66485d] sm:inline">{artifact.settings.medicalMode ? "Medical mode" : "General transcription"}</span>
          <ChevronDown size={15} className="text-[#918986] transition group-open:rotate-180" />
        </span>
      </summary>
      <div className="mt-4 border-t border-[#ece7e3] pt-4">
        <p className="text-xs leading-5 text-[#817976]">Finalized clinician dictation used as note evidence. Verify patient-reported history and speaker attribution before inclusion.</p>
        {artifact.settings.keyterms.length > 0 && <p className="mt-2 text-xs text-[#817976]">Key terms: {artifact.settings.keyterms.join(", ")}</p>}
        <div className="mt-4 max-h-80 space-y-2 overflow-auto rounded-xl bg-[#faf9f8] p-3">
          {artifact.utterances.map(utterance => (
            <div key={utterance.id} className="rounded-lg border border-[#eeeae7] bg-white p-3 text-xs leading-5">
              <p className="font-semibold text-[#75546c]">Doctor · {displayTimestamp(utterance.startMs)}–{displayTimestamp(utterance.endMs)}</p>
              <p className="mt-1 text-[#554e4b]">{utterance.text}</p>
              {utterance.words.length > 0 && <p className="mt-1 text-[10px] text-[#aaa29e]">{utterance.words.length} timestamped words</p>}
            </div>
          ))}
        </div>
        <p className="mt-3 text-[10px] text-[#aaa29e]">Model {artifact.model} · immutable digest {artifact.digest.slice(0, 12)}</p>
      </div>
    </details>
  );
}

function FindingCard({ finding: f, sources, disabled, onSave }: { finding: Finding; sources: Encounter["sources"]; disabled: boolean; onSave: (review: Finding["review"], text: string, note: string) => void }) {
  const [text, setText] = useState(f.text);
  const [note, setNote] = useState(f.reviewNote);
  const [editing, setEditing] = useState(false);
  useEffect(() => { setText(f.text); setNote(f.reviewNote); setEditing(false); }, [f.id, f.text, f.reviewNote]);
  const needsNote = f.certainty !== "observed" || text !== f.originalText || f.evidence.some(ev => sources.find(source => source.id === ev.sourceId)?.quality?.status === "limited");
  const reviewed = f.review !== "pending";

  return (
    <article className={`rounded-2xl border p-4 transition ${f.review === "accepted" ? "border-[#cfe3d4] bg-[#f7fbf8]" : f.review === "rejected" ? "border-[#e4dfdc] bg-[#faf9f8] opacity-75" : "border-[#e7e2de] bg-white"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded-md bg-[#f0e7ed] px-2 py-1 text-[10px] font-semibold text-[#66485d]">{f.section} · {sectionLabels[f.section]}</span>
          <span className={`rounded-md px-2 py-1 text-[10px] font-medium ${f.certainty === "observed" ? "bg-[#f1efed] text-[#746c68]" : "bg-[#fff3dd] text-[#8a5c14]"}`}>{f.certainty.replaceAll("_", " ")}</span>
        </div>
        {reviewed && <span className={`inline-flex items-center gap-1 text-[10px] font-semibold capitalize ${f.review === "accepted" ? "text-[#39704a]" : "text-[#817976]"}`}>{f.review === "accepted" && <Check size={12} />}{f.review}</span>}
      </div>

      {editing ? (
        <div className="mt-3 space-y-3">
          <label className="block text-xs font-semibold text-[#625a57]">Note wording<textarea value={text} onChange={e => setText(e.target.value)} maxLength={500} rows={3} className="mt-2 w-full rounded-xl border border-[#ded8d4] bg-white p-3 text-sm leading-6 outline-none focus:border-[#9a708d]" /></label>
          <label className="block text-xs font-semibold text-[#625a57]">Reviewer note {needsNote ? <span className="font-normal text-[#a86c18]">· required</span> : <span className="font-normal text-[#918986]">· optional</span>}<input value={note} onChange={e => setNote(e.target.value)} maxLength={500} placeholder="Explain a correction or limitation" className="mt-2 w-full rounded-xl border border-[#ded8d4] bg-white p-2.5 text-sm outline-none focus:border-[#9a708d]" /></label>
        </div>
      ) : (
        <p className="mt-3 text-sm font-medium leading-6 text-[#403937]">{text}</p>
      )}

      {f.limitation && <p className="mt-2 text-xs leading-5 text-[#805b1f]">{f.limitation}</p>}
      <div className="mt-3 space-y-2">
        {f.evidence.map((ev, i) => (
          <blockquote key={i} className="border-l-2 border-[#d5c1ce] pl-3 text-xs leading-5 text-[#746c68]">
            <Quote size={12} className="mb-1 text-[#9a708d]" />
            {ev.role === "context" && <span className="font-medium">Context: </span>}{ev.quote}
            <a onClick={() => document.getElementById(`source-${ev.sourceId}`)?.closest("details")?.setAttribute("open", "")} className="ml-1 font-semibold text-[#75546c] underline" href={`#source-${ev.sourceId}`}>{sources.find(s => s.id === ev.sourceId)?.label || "Source"}{ev.transcript ? ` · ${displayTimestamp(ev.transcript.startMs)}` : ""}</a>
          </blockquote>
        ))}
      </div>
      <details className="mt-3 text-[11px] text-[#918986]">
        <summary className="cursor-pointer">Suggestion details</summary>
        <p className="mt-2 leading-5">{f.category ? `${f.category} · ` : ""}{f.origin === "visual" ? "Candidate visual observation; transcript citations are context." : f.origin === "spoken" ? "Reported in conversation; not visually verified." : "Clinician supplied"}{f.provider ? ` · ${f.provider}` : ""}</p>
        {sources.filter(s => s.kind === "image" && f.evidence.some(e => e.sourceId === s.id)).map(s => <a key={s.id} onClick={() => document.getElementById(`source-${s.id}`)?.closest("details")?.setAttribute("open", "")} href={`#source-${s.id}`}><img src={`/api/media/${s.mediaId}`} alt={`Evidence: ${s.label}`} className="mt-3 h-28 rounded-lg bg-white object-contain" /></a>)}
      </details>

      <div className="mt-4 flex flex-wrap gap-2">
        {editing ? <>
          <button disabled={disabled || !text.trim() || (needsNote && !note.trim())} onClick={() => { onSave("accepted", text, note); setEditing(false); }} className={primaryButton}><Check size={14} />Save & include</button>
          <button disabled={disabled} onClick={() => { setText(f.text); setNote(f.reviewNote); setEditing(false); }} className={secondaryButton}>Cancel</button>
        </> : <>
          <button disabled={disabled || !text.trim() || (needsNote && !note.trim())} onClick={() => onSave("accepted", text, note)} className={f.review === "accepted" ? secondaryButton : primaryButton}><Check size={14} />Include</button>
          <button disabled={disabled} onClick={() => setEditing(true)} className={secondaryButton}><Pencil size={13} />Edit</button>
          <button disabled={disabled} onClick={() => onSave("rejected", text, note)} className="inline-flex min-h-10 items-center justify-center rounded-xl px-3 py-2 text-xs font-semibold text-[#817976] hover:bg-[#f3f0ee] disabled:opacity-40">Exclude</button>
        </>}
      </div>
      {needsNote && !note.trim() && !editing && <p className="mt-2 text-[11px] text-[#a86c18]">Add a reviewer note before including this finding.</p>}
    </article>
  );
}

function ManualFinding({ sources, disabled, onSave }: { sources: Encounter["sources"]; disabled: boolean; onSave: (section: string, sourceId: string, text: string, evidenceQuote: string) => void }) {
  const [section, setSection] = useState("O");
  const [sourceId, setSourceId] = useState("");
  const [wording, setWording] = useState("");
  const [evidence, setEvidence] = useState("");
  return (
    <details className="group rounded-[18px] border border-[#e7e2de] bg-white p-5 shadow-[0_1px_2px_rgba(44,32,39,.03)]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3"><span className="flex items-center gap-2 text-sm font-semibold"><Plus size={16} className="text-[#75546c]" />Add clinician finding</span><ChevronDown size={15} className="text-[#918986] transition group-open:rotate-180" /></summary>
      <div className="mt-4 border-t border-[#ece7e3] pt-4">
        <p className="text-xs leading-5 text-[#817976]">Add a clinician-authored observation to the note.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
          <label className="text-xs font-semibold text-[#625a57]">SOAP section<select value={section} onChange={e => setSection(e.target.value)} className="mt-2 w-full rounded-xl border border-[#ded8d4] bg-white p-2.5 text-sm outline-none focus:border-[#9a708d]">{(["S","O","A","P"] as const).map(s => <option key={s} value={s}>{sectionLabels[s]}</option>)}</select></label>
          <label className="text-xs font-semibold text-[#625a57]">Source<select value={sourceId} onChange={e => setSourceId(e.target.value)} className="mt-2 w-full rounded-xl border border-[#ded8d4] bg-white p-2.5 text-sm outline-none focus:border-[#9a708d]"><option value="">Select source</option>{sources.map(s => <option key={s.id} value={s.id}>{s.label} · {s.id.slice(0,8)}</option>)}</select></label>
        </div>
        <label className="mt-3 block text-xs font-semibold text-[#625a57]">Finding<textarea value={wording} maxLength={500} onChange={e => setWording(e.target.value)} rows={2} className="mt-2 w-full rounded-xl border border-[#ded8d4] bg-white p-3 text-sm outline-none focus:border-[#9a708d]" placeholder="What did you observe or hear?" /></label>
        <label className="mt-3 block text-xs font-semibold text-[#625a57]">Evidence<input value={evidence} maxLength={250} onChange={e => setEvidence(e.target.value)} className="mt-2 w-full rounded-xl border border-[#ded8d4] bg-white p-3 text-sm outline-none focus:border-[#9a708d]" placeholder="Visible region or exact spoken words" /></label>
        <button disabled={disabled || !sourceId || !wording.trim() || !evidence.trim()} onClick={() => { onSave(section, sourceId, wording, evidence); setWording(""); setEvidence(""); }} className={`${primaryButton} mt-4 w-full`}>Add to review</button>
      </div>
    </details>
  );
}
