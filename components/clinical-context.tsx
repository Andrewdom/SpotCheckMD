"use client";
import { useEffect, useRef, useState } from "react";
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

export function ClinicalContextEditor({ encounter, disabled, onSave }: { encounter: Encounter; disabled: boolean; onSave: (context: ClinicalContext) => void }) {
  const draft = clinicalContextDraft(encounter);
  const [value, setValue] = useState<ClinicalContext>(draft);
  const syncKey = clinicalContextSyncKey(encounter);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => { setValue(draftRef.current); }, [syncKey]);
  return <section className="rounded-2xl border border-slate-200 bg-white p-5">
    <h2 className="font-semibold">Clinical context for image analysis</h2>
    <p className="mt-2 text-xs text-slate-500">Context helps orient review. Spoken statements and location are not proof of visible findings. Supported input: authorized 2D JPEG/PNG images only. SpotCheckMD preserves oriented source pixels for transport, but MedGemma internally normalizes each image to 896 × 896.</p>
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <label className="text-xs font-semibold">Specialty<select aria-label="Medical specialty" disabled={disabled} value={value.specialty} onChange={e => setValue({ ...value, specialty: e.target.value as ClinicalContext["specialty"] })} className="mt-1 w-full rounded border p-2">{specialties.map(s => <option key={s} value={s}>{s.replaceAll("_", " ")}{["skin", "throat"].includes(s) ? " (legacy demo)" : ""}</option>)}</select></label>
      <label className="text-xs font-semibold">Image type<select disabled={disabled} value={value.imageType} onChange={e => setValue({ ...value, imageType: e.target.value as ClinicalContext["imageType"] })} className="mt-1 w-full rounded border p-2"><option value="clinical_photo">Clinical photograph</option><option value="radiograph">2D radiograph</option><option value="other_2d">Other 2D image — exploratory</option></select></label>
      <label className="text-xs font-semibold sm:col-span-2">Explicitly confirmed anatomical location (optional)<input disabled={disabled} value={value.anatomicalLocation} maxLength={200} onChange={e => setValue({ ...value, anatomicalLocation: e.target.value })} className="mt-1 w-full rounded border p-2" placeholder="Leave blank if unconfirmed" /></label>
      <label className="text-xs font-semibold sm:col-span-2">Physician-supplied context (optional)<textarea disabled={disabled} value={value.physicianContext} maxLength={2000} onChange={e => setValue({ ...value, physicianContext: e.target.value })} className="mt-1 w-full rounded border p-2" rows={3} /></label>
    </div><button disabled={disabled} onClick={() => onSave(value)} className="mt-3 rounded-lg border border-teal-200 bg-teal-50 px-4 py-2 text-sm font-semibold text-teal-800">Confirm and save context</button>
    <p className="mt-2 text-xs text-slate-500">Saving invalidates approval. Run analysis again to use changed context. No specialty-specific clinical validation is claimed.</p>
  </section>;
}

export function ImageAnalysisContext({ encounter, onAcknowledge, disabled }: { encounter: Encounter; onAcknowledge: () => void; disabled: boolean }) {
  return <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5">
    <h2 className="font-semibold">Image analysis and conversation context</h2>
    {encounter.analysisError && <p role="alert" className="text-sm text-amber-800">{encounter.analysisError}</p>}
    {!!encounter.analysisWarnings?.length && <div className="rounded border border-amber-200 bg-amber-50 p-3"><ul className="list-inside list-disc space-y-2 text-xs text-amber-900">{encounter.analysisWarnings.map((w, i) => <li key={i}>{w}</li>)}</ul><button disabled={disabled || encounter.warningsAcknowledged} onClick={onAcknowledge} className="mt-3 rounded border bg-white px-3 py-2 text-sm">{encounter.warningsAcknowledged ? "Limitations acknowledged" : "Acknowledge incomplete analysis"}</button></div>}
    {!encounter.imageAnalyses?.length && <p className="text-xs text-slate-500">No completed image analysis. Transcript documentation works independently.</p>}
    {encounter.imageAnalyses?.map((result, index) => {
      const a = result.analysis; const source = encounter.sources.find(s => s.id === a.imageSourceId);
      return <details key={`${result.runId}-${index}`} className="rounded border p-3"><summary className="cursor-pointer text-sm font-semibold">{source?.label || a.imageSourceId} · {result.provider} · {a.imageType}</summary>
        {source?.mediaId && <a href={`#source-${source.id}`}><img src={`/api/media/${source.previewMediaId || source.mediaId}`} alt={`Analyzed ${source.label}`} className="mt-3 max-h-36 rounded object-contain" /></a>}
        <p className="mt-2 text-xs">Model: {result.model} · {Math.round(result.latencyMs)} ms · Run {result.runId.slice(0, 8)}</p>
        {result.runtime && <p className="mt-2 text-xs text-amber-800">Experimental local runtime: {result.runtime.engine} · {result.runtime.quantization} quantization. Performance may differ from the original weights; verify every observation.</p>}
        {result.imageProcessing && <p className="mt-2 text-xs text-amber-800">Image transport: authenticated multipart, {result.imageProcessing.decodedWidth} × {result.imageProcessing.decodedHeight} pixels received ({Math.round(result.imageProcessing.receivedBytes / 1024 / 1024 * 10) / 10} MB), {result.imageProcessing.metadataPresentAtService ? "metadata detected — verify the client preparation path" : "metadata stripped"}. Model input: {result.imageProcessing.modelInputWidth} × {result.imageProcessing.modelInputHeight}, {result.imageProcessing.visionTokens} vision tokens. MedGemma resized the image internally; this is not native-resolution model processing.</p>}
        <p className="mt-2 break-all text-xs text-slate-500">Model revision: {result.modelRevision}{result.runtime && ` · Runtime revision: ${result.runtime.engineRevision}`}</p>
        <p className="mt-2 text-xs">Anatomical context: {a.anatomicalRegion.value || "Unknown"} ({a.anatomicalRegion.source}); {a.anatomicalRegion.visuallyConfirmed ? "model claims visible — verify" : "not visually confirmed"}</p>
        {a.anatomicalRegion.transcriptQuote && <blockquote className="mt-2 text-xs">“{a.anatomicalRegion.transcriptQuote}”</blockquote>}
        {result.contextRange && <p className="mt-2 text-xs text-slate-500">Transcript character range {result.contextRange.start}–{result.contextRange.end}. Ranges are text offsets, not audio timestamps.</p>}
        {a.reportedHistory.map((h, i) => <div key={i} className="mt-3 rounded bg-slate-50 p-2 text-xs"><strong>{h.attribution.replaceAll("_", " ")} · context only</strong><p>{h.description}</p><a className="text-teal-700 underline" href={`#source-${h.transcriptSourceId}`}>“{h.transcriptQuote}”</a><p>Not verified by this image. Review spoken findings separately before note inclusion.</p></div>)}
        {a.limitations.map((l, i) => <p key={i} className="mt-2 text-xs text-amber-800">{l}</p>)}
      </details>;
    })}
  </section>;
}
