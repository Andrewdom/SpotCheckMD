"use client";

import { useState } from "react";
import { Check, LoaderCircle, ShieldCheck } from "lucide-react";
import { composeNote, PATIENTS, type Encounter } from "@/lib/domain";

export function EhrSubmission({ encounter, blockers, disabled, chartDirty, clinician, setClinician, onSubmit, onOpenNote }: {
  encounter: Encounter; blockers: string[]; disabled: boolean; chartDirty: boolean;
  clinician: string; setClinician: (name: string) => void;
  onSubmit: () => Promise<boolean>; onOpenNote: (id: string) => void;
}) {
  const [sending, setSending] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const receipt = encounter.ehrReceipts?.find(r => r.id === encounter.export?.id);
  const previous = encounter.ehrReceipts?.at(-1);
  const patient = PATIENTS.find(p => p.id === encounter.patientId);
  async function submit() { setSending(true); setUnconfirmed(false); try { if (!await onSubmit()) setUnconfirmed(true); } finally { setSending(false); } }
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
    <h2 className="flex items-center gap-2 text-base font-semibold"><ShieldCheck size={19} className="text-teal-700" /> Physician approval & submission</h2>
    <p className="mt-3 text-xs text-slate-600">Destination: <strong>Demo EHR · Visit notes</strong><br />{patient?.name} · {patient?.record} · Visit {new Date(encounter.createdAt).toLocaleDateString()}</p>
    {!!blockers.length && <ul className="mt-4 list-inside list-disc space-y-2 text-xs text-amber-800">{blockers.map(value => <li key={value}>{value}</li>)}</ul>}
    {chartDirty && <p className="mt-3 text-xs text-amber-800">Save your reviewed history selection before approving.</p>}
    <details className="mt-4 rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer text-xs font-semibold text-teal-800">Preview exact note for submission</summary><pre className="mt-3 whitespace-pre-wrap break-words font-sans text-xs leading-6 text-slate-600">{encounter.approval?.note || composeNote(encounter)}</pre></details>
    <label className="mt-5 block text-xs font-semibold text-slate-600">Reviewing clinician<input value={encounter.approval?.physician || clinician} onChange={event => setClinician(event.target.value)} disabled={disabled || Boolean(encounter.approval)} placeholder="Demo clinician name" className="mt-2 w-full rounded-lg border border-slate-200 p-3 text-sm" /></label>
    {!receipt && <button type="button" disabled={disabled || sending || blockers.length > 0 || chartDirty || (!encounter.approval && clinician.trim().length < 3)} onClick={() => void submit()} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-teal-800 px-4 py-3 text-sm font-semibold text-white disabled:opacity-40">{sending ? <LoaderCircle size={16} className="animate-spin" /> : <Check size={16} />}{sending ? "Sending to Demo EHR…" : encounter.approval ? "Send approved note to Demo EHR" : previous ? "Approve & send amendment" : "Approve & send to Demo EHR"}</button>}
    {unconfirmed && !receipt && <p role="alert" className="mt-3 text-xs text-amber-800">Submission could not be confirmed. Reload the encounter to check its receipt, then retry if needed. Retries cannot duplicate a saved revision.</p>}
    {receipt && <div role="status" className="mt-4 rounded-xl bg-teal-50 p-4"><p className="font-semibold text-teal-900">Saved to Demo EHR</p><p className="mt-2 break-all text-xs leading-5 text-teal-800">Document {receipt.id}<br />{new Date(receipt.at).toLocaleString()} · revision {receipt.revision}</p><button type="button" onClick={() => onOpenNote(receipt.id)} className="mt-3 text-sm font-semibold text-teal-800 underline">Open saved note</button></div>}
    {previous && !receipt && <p className="mt-3 text-xs text-slate-600">The previously saved note remains in the chart. Submitting this revision creates a linked amendment.</p>}
    <p className="mt-3 text-[11px] leading-5 text-slate-500">Local simulation with fictional records. Approval uses the entered demo clinician name. Review all wording before submission.</p>
  </section>;
}
