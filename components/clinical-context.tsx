"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { specialties, type ClinicalContext } from "@/lib/image-analysis/contracts";
import type { Encounter } from "@/lib/domain";

type ContextEncounter = Pick<Encounter, "id" | "specialty" | "clinicalContext">;

export function clinicalContextDraft(encounter: Pick<Encounter, "specialty" | "clinicalContext">): ClinicalContext {
  return encounter.clinicalContext || { specialty: encounter.specialty, imageType: "clinical_photo", anatomicalLocation: "", physicianContext: "" };
}

// Identity of the saved context, not the encounter object. Refreshing consent or pairing
// replaces that object without changing what was saved.
export function clinicalContextSyncKey(encounter: ContextEncounter): string {
  const draft = clinicalContextDraft(encounter);
  return JSON.stringify([encounter.id, draft.specialty, draft.imageType, draft.anatomicalLocation, draft.physicianContext]);
}

export function clinicalContextChanged(saved: ClinicalContext, edited: ClinicalContext): boolean {
  return JSON.stringify(saved) !== JSON.stringify(edited);
}

export function ClinicalContextEditor({ encounter, disabled, onSave, onDirtyChange }: { encounter: Encounter; disabled: boolean; onSave: (context: ClinicalContext) => Promise<boolean>; onDirtyChange: (dirty: boolean) => void }) {
  const draft = clinicalContextDraft(encounter);
  const [value, setValue] = useState<ClinicalContext>(draft);
  const syncKey = clinicalContextSyncKey(encounter);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => { setValue(draftRef.current); }, [syncKey]);
  const dirty = clinicalContextChanged(draft, value);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  return <details className="group rounded-[18px] border border-[#e7e2de] bg-white p-5 shadow-[0_1px_2px_rgba(44,32,39,.03)]">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3"><span className="flex items-center gap-3"><span className="flex size-9 items-center justify-center rounded-xl bg-[#f0e7ed] text-[#66485d]"><SlidersHorizontal size={16} /></span><span><span className="flex items-center gap-2 text-sm font-semibold">Clinical context {dirty && <span className="rounded-full bg-[#fff3dd] px-2 py-0.5 text-[10px] text-[#8a5c14]">Unsaved</span>}</span><span className="mt-1 block text-[11px] capitalize text-[#817976]">Saved: {draft.specialty.replaceAll("_", " ")} · {draft.imageType.replaceAll("_", " ")}</span></span></span><ChevronDown size={15} className="text-[#918986] transition group-open:rotate-180" /></summary>
    <div className="mt-5 border-t border-[#ece7e3] pt-4">
      <p className="text-xs leading-5 text-[#817976]">Add only context confirmed for this visit. Spoken context does not prove a visual finding. Supported inputs are authorized 2D JPEG or PNG images; MedGemma internally normalizes images to its model input size.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold text-[#625a57]">Specialty<select aria-label="Medical specialty" disabled={disabled} value={value.specialty} onChange={e => setValue({ ...value, specialty: e.target.value as ClinicalContext["specialty"] })} className="mt-2 w-full rounded-xl border border-[#ded8d4] bg-white p-2.5 outline-none focus:border-[#9a708d]">{specialties.map(s => <option key={s} value={s}>{s.replaceAll("_", " ")}{["skin", "throat"].includes(s) ? " (legacy demo)" : ""}</option>)}</select></label>
        <label className="text-xs font-semibold text-[#625a57]">Image type<select disabled={disabled} value={value.imageType} onChange={e => setValue({ ...value, imageType: e.target.value as ClinicalContext["imageType"] })} className="mt-2 w-full rounded-xl border border-[#ded8d4] bg-white p-2.5 outline-none focus:border-[#9a708d]"><option value="clinical_photo">Clinical photograph</option><option value="radiograph">2D radiograph</option><option value="other_2d">Other 2D image — exploratory</option></select></label>
        <label className="text-xs font-semibold text-[#625a57] sm:col-span-2">Confirmed anatomical location <span className="font-normal text-[#918986]">(optional)</span><input disabled={disabled} value={value.anatomicalLocation} maxLength={200} onChange={e => setValue({ ...value, anatomicalLocation: e.target.value })} className="mt-2 w-full rounded-xl border border-[#ded8d4] p-2.5 outline-none focus:border-[#9a708d]" placeholder="Leave blank if unconfirmed" /></label>
        <label className="text-xs font-semibold text-[#625a57] sm:col-span-2">Physician context <span className="font-normal text-[#918986]">(optional)</span><textarea disabled={disabled} value={value.physicianContext} maxLength={2000} onChange={e => setValue({ ...value, physicianContext: e.target.value })} className="mt-2 w-full rounded-xl border border-[#ded8d4] p-3 outline-none focus:border-[#9a708d]" rows={3} /></label>
      </div><button disabled={disabled || !dirty} onClick={() => void onSave(value)} className="mt-4 inline-flex min-h-10 items-center justify-center rounded-xl border border-[#dfdad6] bg-white px-4 py-2.5 text-sm font-semibold text-[#48413f] hover:bg-[#faf8f6] disabled:opacity-40">{dirty ? "Save context" : "Context saved"}</button>
      <p className="mt-3 text-[11px] leading-5 text-[#918986]">Saving invalidates any existing approval. Run analysis again to use changed context. No specialty-specific clinical validation is claimed.</p>
    </div>
  </details>;
}

export function ImageAnalysisContext({ encounter, onAcknowledge, disabled }: { encounter: Encounter; onAcknowledge: () => void; disabled: boolean }) {
  return <details open={Boolean(encounter.analysisWarnings?.length && !encounter.warningsAcknowledged) || undefined} className="group rounded-[18px] border border-[#e7e2de] bg-white p-5 shadow-[0_1px_2px_rgba(44,32,39,.03)]">
    <summary className="flex cursor-pointer list-none items-center justify-between"><span><span className="block text-sm font-semibold">Analysis details & limitations</span><span className="mt-1 block text-[11px] text-[#817976]">{encounter.imageAnalyses?.length || 0} completed image {(encounter.imageAnalyses?.length || 0) === 1 ? "analysis" : "analyses"}</span></span><ChevronDown size={15} className="text-[#918986] transition group-open:rotate-180" /></summary><div className="mt-4 space-y-3 border-t border-[#ece7e3] pt-4">
    {encounter.analysisError && <p role="alert" className="text-sm text-[#805b1f]">{encounter.analysisError}</p>}
    {!!encounter.analysisWarnings?.length && <div className="rounded-xl border border-[#ead8bd] bg-[#fff8eb] p-3"><ul className="list-inside list-disc space-y-2 text-xs text-[#805b1f]">{encounter.analysisWarnings.map((w, i) => <li key={i}>{w}</li>)}</ul><button disabled={disabled || encounter.warningsAcknowledged} onClick={onAcknowledge} className="mt-3 rounded-xl border border-[#dfdad6] bg-white px-3 py-2 text-sm font-semibold">{encounter.warningsAcknowledged ? "Limitations acknowledged" : "Acknowledge limitations"}</button></div>}
    {!encounter.imageAnalyses?.length && <p className="text-xs text-[#817976]">No completed image analysis. Transcript documentation remains available.</p>}
    {encounter.imageAnalyses?.map((result, index) => {
      const a = result.analysis; const source = encounter.sources.find(s => s.id === a.imageSourceId);
      return <details key={`${result.runId}-${index}`} className="rounded-xl border border-[#e7e2de] p-3"><summary className="cursor-pointer text-sm font-semibold">{source?.label || a.imageSourceId} · {result.provider} · {a.imageType}</summary>
        {source?.mediaId && <a onClick={() => document.getElementById(`source-${source.id}`)?.closest("details")?.setAttribute("open", "")} href={`#source-${source.id}`}><img src={`/api/media/${source.previewMediaId || source.mediaId}`} alt={`Analyzed ${source.label}`} className="mt-3 max-h-36 rounded object-contain" /></a>}
        <p className="mt-2 text-xs">Model: {result.model} · {Math.round(result.latencyMs)} ms · Run {result.runId.slice(0, 8)}</p>
        {result.runtime && <p className="mt-2 text-xs text-amber-800">Experimental local runtime: {result.runtime.engine} · {result.runtime.quantization} quantization. Performance may differ from the original weights; verify every observation.</p>}
        {result.imageProcessing && <p className="mt-2 text-xs text-amber-800">Image transport: authenticated multipart, {result.imageProcessing.decodedWidth} × {result.imageProcessing.decodedHeight} pixels received ({Math.round(result.imageProcessing.receivedBytes / 1024 / 1024 * 10) / 10} MB), {result.imageProcessing.metadataPresentAtService ? "metadata detected — verify the client preparation path" : "metadata stripped"}. Model input: {result.imageProcessing.modelInputWidth} × {result.imageProcessing.modelInputHeight}, {result.imageProcessing.visionTokens} vision tokens. MedGemma resized the image internally; this is not native-resolution model processing.</p>}
        <p className="mt-2 break-all text-xs text-slate-500">Model revision: {result.modelRevision}{result.runtime && ` · Runtime revision: ${result.runtime.engineRevision}`}</p>
        <p className="mt-2 text-xs">Anatomical context: {a.anatomicalRegion.value || "Unknown"} ({a.anatomicalRegion.source}); {a.anatomicalRegion.visuallyConfirmed ? "model claims visible — verify" : "not visually confirmed"}</p>
        {a.anatomicalRegion.transcriptQuote && <blockquote className="mt-2 text-xs">“{a.anatomicalRegion.transcriptQuote}”</blockquote>}
        {result.contextRange && <p className="mt-2 text-xs text-slate-500">Transcript character range {result.contextRange.start}–{result.contextRange.end}. Ranges are text offsets, not audio timestamps.</p>}
        {a.reportedHistory.map((h, i) => <div key={i} className="mt-3 rounded-xl bg-[#faf9f8] p-3 text-xs"><strong>{h.attribution.replaceAll("_", " ")} · context only</strong><p className="mt-1">{h.description}</p><a onClick={() => document.getElementById(`source-${h.transcriptSourceId}`)?.closest("details")?.setAttribute("open", "")} className="mt-1 inline-block text-[#75546c] underline" href={`#source-${h.transcriptSourceId}`}>“{h.transcriptQuote}”</a><p className="mt-1 text-[#817976]">Review spoken findings separately before note inclusion.</p></div>)}
        {a.limitations.map((l, i) => <p key={i} className="mt-2 text-xs text-amber-800">{l}</p>)}
      </details>;
    })}</div>
  </details>;
}
