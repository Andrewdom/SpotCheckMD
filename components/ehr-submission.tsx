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
  const remaining = blockers.length + (chartDirty ? 1 : 0);
  return <section className="rounded-[18px] border border-[#e7e2de] bg-white p-5 shadow-[0_1px_2px_rgba(44,32,39,.03)]">
    <div className="flex items-start justify-between gap-3"><div><p className="text-[11px] font-semibold uppercase tracking-[.14em] text-[#8a627d]">Sign off</p><h2 className="mt-1 flex items-center gap-2 text-base font-semibold"><ShieldCheck size={18} className="text-[#75546c]" /> Physician approval</h2></div><span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${remaining ? "bg-[#fff3dd] text-[#8a5c14]" : "bg-[#e8f3ea] text-[#39704a]"}`}>{remaining ? `${remaining} to resolve` : "Ready"}</span></div>
    <p className="mt-3 text-xs leading-5 text-[#746c68]"><strong>Demo EHR · Visit notes</strong><br />{patient?.name} · {patient?.record} · {new Date(encounter.createdAt).toLocaleDateString()}</p>
    {!!blockers.length && <div className="mt-4 rounded-xl border border-[#ead8bd] bg-[#fff8eb] p-3"><p className="text-xs font-semibold text-[#6f4e1a]">Before signing</p><ul className="mt-2 list-inside list-disc space-y-1.5 text-xs leading-5 text-[#805b1f]">{blockers.map(value => <li key={value}>{value}</li>)}</ul></div>}
    {chartDirty && <p className="mt-3 rounded-xl bg-[#fff8eb] p-3 text-xs text-[#805b1f]">Save the reviewed history selection before approving.</p>}
    <details className="mt-4 rounded-xl border border-[#e7e2de] bg-[#faf9f8] p-3"><summary className="cursor-pointer text-xs font-semibold text-[#75546c]">Preview submitted note</summary><pre className="mt-3 whitespace-pre-wrap break-words font-sans text-xs leading-6 text-[#625a57]">{encounter.approval?.note || composeNote(encounter)}</pre></details>
    <label className="mt-5 block text-xs font-semibold text-[#625a57]">Reviewing clinician<input value={encounter.approval?.physician || clinician} onChange={event => setClinician(event.target.value)} disabled={disabled || Boolean(encounter.approval)} placeholder="Clinician name" className="mt-2 w-full rounded-xl border border-[#ded8d4] bg-white p-3 text-sm outline-none focus:border-[#9a708d]" /></label>
    {!receipt && <button type="button" disabled={disabled || sending || blockers.length > 0 || chartDirty || (!encounter.approval && clinician.trim().length < 3)} onClick={() => void submit()} className="mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#51384a] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#422e3c] disabled:opacity-40">{sending ? <LoaderCircle size={16} className="animate-spin" /> : <Check size={16} />}{sending ? "Sending…" : encounter.approval ? "Send approved note" : previous ? "Approve & send amendment" : "Approve & send"}</button>}
    {unconfirmed && !receipt && <p role="alert" className="mt-3 text-xs leading-5 text-[#805b1f]">Submission could not be confirmed. Reload the encounter to check its receipt, then retry if needed.</p>}
    {receipt && <div role="status" className="mt-4 rounded-xl border border-[#cfe3d4] bg-[#f1f8f3] p-4"><p className="font-semibold text-[#2f633e]">Saved to Demo EHR</p><p className="mt-2 break-all text-xs leading-5 text-[#39704a]">Document {receipt.id}<br />{new Date(receipt.at).toLocaleString()} · revision {receipt.revision}</p><button type="button" onClick={() => onOpenNote(receipt.id)} className="mt-3 text-sm font-semibold text-[#39704a] underline">Open saved note</button></div>}
    {previous && !receipt && <p className="mt-3 text-xs leading-5 text-[#746c68]">Submitting this revision creates a linked amendment to the saved note.</p>}
  </section>;
}
