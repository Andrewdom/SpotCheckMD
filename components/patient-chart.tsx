"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ClipboardList, RefreshCw } from "lucide-react";
import type { Encounter } from "@/lib/domain";
import { patientAge, type PatientChart, type ChartCategory } from "@/lib/ehr/types";

const tabs = ["Overview", "History", "Medications", "Allergies", "Results", "Visit notes"] as const;
type Tab = typeof tabs[number];
const categories: Record<Tab, ChartCategory[]> = { Overview: [], History: ["condition", "history"], Medications: ["medication"], Allergies: ["allergy"], Results: ["vital", "lab"], "Visit notes": ["note"] };
const snapshotSections = [
  { label: "History", categories: ["condition", "history"] as ChartCategory[] },
  { label: "Medications", categories: ["medication"] as ChartCategory[] },
  { label: "Allergies", categories: ["allergy"] as ChartCategory[] },
  { label: "Results", categories: ["vital", "lab"] as ChartCategory[] },
] as const;
export type HistorySelection = { chartVersion: number; items: { id: string; confirmedToday: boolean }[] };
const button = "inline-flex min-h-9 items-center justify-center rounded-xl border border-[#dfdad6] bg-white px-3 py-2 text-xs font-semibold text-[#625a57] transition hover:bg-[#faf8f6] disabled:opacity-40";

export function PatientChartPanel({ patientId, encounter, stage, full = false, disabled = false, focusNoteId, onSave, onDirtyChange }: {
  patientId: string; encounter?: Encounter | null; stage: "chart" | "capture" | "review"; full?: boolean; disabled?: boolean; focusNoteId?: string;
  onSave: (selection: HistorySelection) => Promise<boolean>; onDirtyChange: (dirty: boolean) => void;
}) {
  const [chart, setChart] = useState<PatientChart | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [tab, setTab] = useState<Tab>("Overview");
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<HistorySelection["items"]>([]);
  const [dirty, setDirty] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const savedContext = encounter?.chartContext;
  const receiptId = encounter?.export?.id;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void fetch(`/api/ehr?patientId=${encodeURIComponent(patientId)}`, { cache: "no-store", signal: controller.signal })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || "Chart unavailable."); if (!controller.signal.aborted) setChart(data.chart); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [patientId, refresh, receiptId]);
  useEffect(() => {
    setItems(savedContext?.items.map(item => ({ id: item.id, confirmedToday: item.confirmedToday })) || []);
    setDirty(false); onDirtyChange(false);
  }, [savedContext?.importedAt, encounter?.id, onDirtyChange]);
  useEffect(() => {
    if (!focusNoteId) return;
    const category = chart?.records.find(record => record.id === focusNoteId)?.category;
    setTab(category === "medication" ? "Medications" : category === "allergy" ? "Allergies" : category === "vital" || category === "lab" ? "Results" : category === "history" || category === "condition" ? "History" : "Visit notes");
    setOpen(true);
  }, [focusNoteId, chart?.version]);
  useEffect(() => { if (stage !== "chart") setOpen(false); }, [stage]);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 30000); return () => clearInterval(timer); }, []);
  const stale = chart && clock - Date.parse(chart.refreshedAt) > 300000;
  const canSelect = Boolean(encounter?.consent && encounter.patientConfirmed && !disabled && !loading && !error);
  function change(next: HistorySelection["items"]) { setItems(next); setDirty(true); onDirtyChange(true); }
  async function save() {
    if (chart && await onSave({ chartVersion: chart.version, items })) { setDirty(false); onDirtyChange(false); }
  }
  const patient = chart?.patient;
  const shown = chart?.records.filter(record => categories[tab].includes(record.category)).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)) || [];
  const historyChanged = savedContext?.items.some(item => {
    const latest = chart?.records.find(record => record.id === item.id);
    return chart && (!latest || ["text", "recordedAt", "source", "status", "title"].some(key => latest[key as keyof typeof latest] !== item[key as keyof typeof item]));
  });
  return <section className="mb-6 overflow-hidden rounded-[18px] border border-[#e7e2de] bg-white shadow-[0_1px_2px_rgba(44,32,39,.03)]">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#ece7e3] p-5">
      <div className="flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-xl bg-[#f0e7ed] text-[#66485d]"><ClipboardList size={19} /></span><div><h2 className="font-semibold">Patient chart <span className="ml-2 rounded-full bg-[#f0e7ed] px-2 py-1 text-[10px] text-[#66485d]">Demo EHR</span></h2><p className="mt-1 text-xs text-[#817976]">{loading ? "Loading chart…" : chart ? `Updated ${new Date(chart.refreshedAt).toLocaleTimeString()} · version ${chart.version}` : "Chart unavailable"}{stale && " · Refresh recommended"}</p></div></div>
      <div className="flex gap-2"><button type="button" className={button} disabled={loading || disabled} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={13} className={`mr-1 inline ${loading ? "animate-spin" : ""}`} /> Refresh chart</button>{!full && <button type="button" className={button} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide chart" : "View chart"} <ChevronDown size={14} className="ml-1 inline" /></button>}</div>
    </div>
    {error && <p role="alert" className="m-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{error} {chart && "Showing the last retrieved chart. Refresh to reconnect."}</p>}
    {patient && <div className="flex flex-wrap items-center justify-between gap-3 bg-[#faf9f8] px-5 py-3 text-xs text-[#554e4b]">
      <p><strong>{patient.name}</strong> · DOB {patient.dateOfBirth} · Age {patientAge(patient.dateOfBirth)} · {patient.mrn}</p>
      <p className="font-semibold text-amber-900">Allergies: {patient.allergyStatus === "unknown" ? "Not verified" : patient.allergyStatus === "none_known" ? "No known allergies documented" : chart.records.filter(r => r.category === "allergy").map(r => `${r.title} (${r.status.toLowerCase()})`).join(", ")}</p>
    </div>}
    {chart && <div className="border-t border-[#ece7e3] p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-semibold">Chart at a glance</h3><p className="mt-0.5 text-[11px] text-[#817976]">From the patient record · review before using in this visit</p></div>{encounter && <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${historyChanged ? "bg-[#fff3dd] text-[#8a5c14]" : "bg-[#f0e7ed] text-[#66485d]"}`}>{historyChanged ? "Reviewed history changed" : `${savedContext?.items.length || 0} saved for note`}{dirty ? " · unsaved changes" : ""}</span>}</div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{snapshotSections.map(section => {
        const records = chart.records.filter(record => section.categories.includes(record.category)).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
        const reviewed = records.filter(record => savedContext?.items.some(item => item.id === record.id)).length;
        return <button key={section.label} type="button" onClick={() => { setTab(section.label); setOpen(true); }} className="min-w-0 rounded-xl border border-[#e7e2de] bg-white p-3 text-left transition hover:border-[#c9b3c1] hover:bg-[#fdfafd]" aria-label={`View ${section.label.toLowerCase()} in patient chart`}>
          <span className="flex items-center justify-between gap-2"><span className="text-xs font-semibold text-[#514946]">{section.label}</span><span className="text-[10px] text-[#8a627d]">{records.length} {records.length === 1 ? "entry" : "entries"}</span></span>
          <span className="mt-2 block min-h-8 text-xs leading-4 text-[#746c68]">{records.length ? records.slice(0, 2).map(record => `${record.title} (${record.status.toLowerCase()})`).join(" · ") : section.label === "Allergies" && chart.patient.allergyStatus === "unknown" ? "Not verified" : "Not documented"}</span>
          {encounter && <span className="mt-2 block text-[10px] font-medium text-[#8a627d]">{reviewed} reviewed for this visit</span>}
        </button>;
      })}</div>
    </div>}
    {(full || open) && <div className="p-5">
      <div role="tablist" aria-label="Patient chart sections" className="mb-5 flex gap-1 overflow-x-auto rounded-xl bg-[#f1efed] p-1">{tabs.map(value => <button type="button" role="tab" aria-selected={tab === value} key={value} onClick={() => setTab(value)} className={`shrink-0 rounded-lg px-3 py-2 text-xs font-semibold transition ${tab === value ? "bg-white text-[#403937] shadow-sm" : "text-[#746c68] hover:text-[#403937]"}`}>{value}</button>)}</div>
      {tab === "Overview" && patient && <dl className="mb-5 grid gap-x-6 gap-y-4 rounded-xl border border-[#e7e2de] bg-[#faf9f8] p-4 text-xs sm:grid-cols-2 lg:grid-cols-3">{[
        ["Recorded sex", patient.recordedSex], ["Gender identity", patient.genderIdentity], ["Preferred language", patient.language], ["Primary clinician", patient.primaryClinician], ["Preferred pharmacy", patient.pharmacy], ["Insurance", patient.insurance], ["Phone", patient.phone], ["Address", patient.address], ["Emergency contact", patient.emergencyContact],
      ].map(([label, value]) => <div key={label}><dt className="text-slate-500">{label}</dt><dd className="mt-1 font-medium">{value || "Not documented"}</dd></div>)}</dl>}
      {tab === "Allergies" && patient?.allergyStatus === "unknown" && <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Allergy history has not been verified. No allergy entries are available.</p>}
      {tab === "History" && patientId === "demo-002" && <p className="mb-4 text-xs text-slate-500">Family and surgical history: not documented.</p>}
      {tab === "Results" && !chart?.records.some(r => r.category === "lab") && <p className="mb-4 text-xs text-slate-500">Laboratory results: not documented.</p>}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">{shown.map(record => {
        const selected = items.find(item => item.id === record.id);
        const savedNote = chart?.notes.find(note => note.id === record.id);
        const currentNote = savedNote?.encounterId === encounter?.id;
        return <article key={record.id} id={`chart-${record.id}`} className={`min-w-0 rounded-xl border p-4 transition ${focusNoteId === record.id ? "border-[#9a708d] bg-[#fbf7fa] ring-1 ring-[#d7c5d0]" : selected ? "border-[#d7c5d0] bg-[#fdfbfd]" : "border-[#e7e2de]"}`}>
          <div className="flex items-start justify-between gap-3"><h3 className="text-sm font-semibold">{record.title}</h3><span className="rounded-md bg-[#f1efed] px-2 py-1 text-[10px] text-[#746c68]">{record.status}</span></div>
          <p className="mt-1 text-[11px] text-[#918986]">{record.recordedAt.slice(0, 10)} · {record.source}</p>
          {record.category === "note" ? <details open={focusNoteId === record.id} className="mt-3 text-sm"><summary className="cursor-pointer font-medium text-[#75546c]">Read note</summary><p className="mt-3 whitespace-pre-wrap break-words leading-6 text-[#625a57]">{record.text}</p></details> : <p className="mt-3 text-sm leading-6 text-[#625a57]">{record.text}</p>}
          {savedNote && <p className="mt-3 break-words text-[11px] text-slate-500">Document {savedNote.id} · saved {new Date(savedNote.savedAt).toLocaleString()}{savedNote.amendsId && ` · amends ${savedNote.amendsId}`} · approved by {savedNote.physician}</p>}
          {encounter && !currentNote && <div className="mt-3 border-t border-slate-100 pt-3 text-xs"><label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(selected)} disabled={!canSelect} onChange={event => change(event.target.checked ? [...items, { id: record.id, confirmedToday: false }] : items.filter(item => item.id !== record.id))} /> Include in note background</label>{selected && <label className="mt-3 flex items-center gap-2 text-slate-600"><input type="checkbox" checked={selected.confirmedToday} disabled={!canSelect} onChange={event => change(items.map(item => item.id === record.id ? { ...item, confirmedToday: event.target.checked } : item))} /> Confirmed during this visit</label>}</div>}
        </article>;
      })}</div>
      {!loading && tab !== "Overview" && !shown.length && <p className="rounded-xl bg-[#faf9f8] p-5 text-sm text-[#817976]">No records documented in this section.</p>}
      {encounter && <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#e2d4dc] bg-[#faf6f9] p-4"><div><p className="text-sm font-semibold">{items.length} record{items.length === 1 ? "" : "s"} selected {dirty && "· Unsaved"}</p><p className="mt-1 text-xs text-[#746c68]">{!encounter.consent || !encounter.patientConfirmed ? "Confirm patient and consent in Capture before including chart records." : "Saved selections appear as reviewed chart background in the note."}</p>{historyChanged && <p className="mt-1 text-xs text-amber-800">Included records differ from the current chart. Review and save an updated selection.</p>}</div><div className="flex gap-2"><button type="button" className={button} disabled={!canSelect || !items.length} onClick={() => change([])}>Clear</button><button type="button" className={`${button} border-[#8b657e] bg-[#51384a] text-white hover:bg-[#422e3c]`} disabled={!canSelect || !dirty} onClick={() => void save()}>Save chart review</button></div></div>}
    </div>}
  </section>;
}
