"use client";

import { useEffect, useRef, useState } from "react";
import type { Finding, Source } from "@/lib/domain";
import { borders, colors, label, morphology, observationText, oralFeatures, oralSites, shapes, surfaces, type Crop, type ObservationTarget, type VisualObservation } from "@/lib/observations";

const button = "rounded-lg border border-teal-200 px-3 py-2 text-xs font-semibold text-teal-800 disabled:opacity-40 disabled:cursor-not-allowed";
const input = "mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 text-sm";
const fullPhoto: Crop = { x: 0, y: 0, width: 1, height: 1 };

export function PhotoTarget({ source, disabled, onSave, onDetect, onDirty }: {
  source: Source; disabled: boolean;
  onSave: (target: ObservationTarget) => Promise<boolean>;
  onDetect: () => void; onDirty: (dirty: boolean) => void;
}) {
  const [crop, setCrop] = useState<Crop | null>(source.target?.crop || null);
  const [region, setRegion] = useState<ObservationTarget["region"]>(source.target?.region || "auto");
  const [diameter, setDiameter] = useState(source.target?.diameterMm?.toString() || "");
  const [exam, setExam] = useState<ObservationTarget["examSurface"]>(source.target?.examSurface || "not_confirmed");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const start = useRef<{ x: number; y: number } | null>(null);
  const savedTarget = JSON.stringify(source.target);
  useEffect(() => {
    setCrop(source.target?.crop || null); setRegion(source.target?.region || "auto");
    setDiameter(source.target?.diameterMm?.toString() || ""); setExam(source.target?.examSurface || "not_confirmed"); setDirty(false);
  }, [savedTarget]);
  function change() { setDirty(true); onDirty(true); setError(""); }
  function point(e: React.PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  }
  function move(e: React.PointerEvent<HTMLDivElement>) {
    if (!start.current) return;
    const p = point(e), a = start.current;
    setCrop({ x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), width: Math.abs(p.x - a.x), height: Math.abs(p.y - a.y) });
  }
  async function save() {
    if (!crop || crop.width < .02 || crop.height < .02) { setError("Draw a larger selection, or choose the whole photo."); return; }
    const mm = diameter.trim() ? Number(diameter) : null;
    if (mm !== null && (!Number.isFinite(mm) || mm <= 0 || mm > 1000)) { setError("Enter a positive diameter up to 1000 mm, or leave it blank."); return; }
    if (await onSave({ region, crop, diameterMm: mm, examSurface: exam })) { setDirty(false); onDirty(false); }
  }
  return <article className="rounded-xl border border-slate-200 p-3">
    <div className="mb-3 flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{source.label}</h3><span className="rounded bg-slate-100 px-2 py-1 text-[10px] uppercase">{source.quality?.status}</span></div>
    <p className="mb-2 text-xs text-slate-500">Drag a box around one finding. On a phone, drag with your finger.</p>
    <div className="relative touch-none select-none overflow-hidden rounded-lg bg-slate-100"
      onPointerDown={e => { if (disabled) return; e.currentTarget.setPointerCapture(e.pointerId); start.current = point(e); change(); }}
      onPointerMove={move} onPointerUp={e => { move(e); start.current = null; }} onPointerCancel={() => { start.current = null; }}>
      <img draggable={false} src={`/api/media/${source.mediaId}`} alt={`${source.label}: select one area of interest`} className="block h-auto w-full" />
      {crop && <div aria-label="Selected area" className="pointer-events-none absolute border-2 border-teal-400" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%`, boxShadow: "0 0 0 9999px rgb(15 23 42 / .35)" }} />}
    </div>
    <div className="mt-3 flex flex-wrap gap-2"><button disabled={disabled} className={button} onClick={() => { setCrop(fullPhoto); change(); }}>Use whole photo</button><button disabled={disabled || source.quality?.status === "retake"} className={button} onClick={onDetect}>Suggest body region</button></div>
    {source.anatomy && <p className="mt-2 text-xs text-teal-800">AI region suggestion: {source.anatomy.region} · {source.anatomy.certainty}. Verify against the photo.</p>}
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="text-xs font-semibold">Body region<select className={input} value={region} disabled={disabled} onChange={e => { setRegion(e.target.value as ObservationTarget["region"]); change(); }}><option value="auto">Detect automatically</option><option value="skin">Skin — clinician selected</option><option value="mouth">Mouth — clinician selected</option></select></label>
      <label className="text-xs font-semibold">Measured diameter (mm)<input className={input} type="number" inputMode="decimal" step="any" min="0.1" max="1000" value={diameter} placeholder="Not measured" disabled={disabled} onChange={e => { setDiameter(e.target.value); change(); }} /></label>
      {region !== "mouth" && <label className="text-xs font-semibold">Skin surface confirmed by examination<select className={input} value={exam} disabled={disabled} onChange={e => { setExam(e.target.value as ObservationTarget["examSurface"]); change(); }}><option value="not_confirmed">Not confirmed</option><option value="flat">Flat</option><option value="raised">Raised</option></select></label>}
    </div>
    <p className="mt-2 text-[11px] leading-5 text-slate-500">Only enter a diameter you measured. The AI does not infer millimeters from pixels. The box selects evidence; it does not trace the lesion boundary.</p>
    <details className="mt-2 text-xs text-slate-500"><summary>Adjust selection with numbers</summary><div className="mt-2 grid grid-cols-2 gap-2">{(["x", "y", "width", "height"] as const).map(k => <label key={k}>{k} (%)<input aria-label={`Selection ${k} percent`} className={input} type="number" min="0" max="100" step="1" value={Math.round((crop || fullPhoto)[k] * 100)} onChange={e => { setCrop({ ...(crop || fullPhoto), [k]: Number(e.target.value) / 100 }); change(); }} disabled={disabled} /></label>)}</div></details>
    {source.quality?.reasons.map((r, i) => <p key={r} className="mt-2 text-xs text-amber-800">{r}. {source.quality?.guidance[i]}</p>)}
    {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
    <button disabled={disabled || !crop || source.quality?.status === "retake"} className={`${button} mt-3 bg-teal-50`} onClick={() => void save()}>{source.target && !dirty ? "Selection saved" : "Save photo settings"}</button>
    {dirty && <p className="mt-2 text-xs text-amber-800">Save these changes before analysis. Saving resets this photo’s AI draft and any approval.</p>}
  </article>;
}

function SelectField({ name, value, options, disabled, onChange }: { name: string; value: string; options: readonly string[]; disabled: boolean; onChange: (v: string) => void }) {
  return <label className="text-xs font-semibold">{name}<select aria-label={name} className={input} value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>{options.map(v => <option value={v} key={v}>{label(v)}</option>)}</select></label>;
}

export function StructuredFinding({ finding: f, source, disabled, onSave }: {
  finding: Finding; source?: Source; disabled: boolean;
  onSave: (review: Finding["review"], attributes: VisualObservation["attributes"], reviewNote: string) => void;
}) {
  const [o, setO] = useState(f.observation!);
  const [note, setNote] = useState(f.reviewNote);
  const savedObservation = JSON.stringify(f.observation);
  useEffect(() => { setO(f.observation!); setNote(f.reviewNote); }, [f.id, savedObservation, f.reviewNote]);
  const a = o.attributes;
  const change = (key: string, value: unknown) => setO(prev => ({ ...prev, attributes: { ...prev.attributes, [key]: value } }));
  const crop = o.target.crop;
  const w = source?.width || 1000, h = source?.height || 1000;
  return <article className="rounded-xl border border-slate-200 p-4">
    <div className="flex flex-wrap gap-2 text-[10px] font-semibold uppercase"><span className="rounded bg-teal-50 px-2 py-1 text-teal-800">{o.region} description</span><span className="rounded bg-amber-50 px-2 py-1 text-amber-800">Clinician verification required</span><span className="rounded bg-slate-100 px-2 py-1">{f.review}</span></div>
    {source && <a href={`#source-${source.id}`} className="mt-3 block"><svg role="img" aria-label="Selected evidence crop" className="max-h-64 w-full rounded-lg bg-slate-50" viewBox={`${crop.x * w} ${crop.y * h} ${crop.width * w} ${crop.height * h}`}><image href={`/api/media/${source.mediaId}`} width={w} height={h} preserveAspectRatio="none" /></svg><p className="mt-1 text-xs text-teal-700 underline">View original {source.label}</p></a>}
    <p className="mt-3 text-sm font-semibold">Descriptive category: {morphology(o)}</p>
    <p className="mt-1 text-xs text-slate-500">{o.target.diameterMm === null ? "Size not measured" : `Clinician-entered diameter: ${o.target.diameterMm} mm`} · Region {o.routing === "automatic" ? "suggested by AI" : "selected by clinician"}</p>
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <SelectField name="Assessability" value={a.assessability} options={["describable", "uncertain", "not_assessable"]} disabled={disabled} onChange={v => change("assessability", v)} />
      <SelectField name="Shape" value={a.shape} options={shapes} disabled={disabled} onChange={v => change("shape", v)} />
      <SelectField name="Border" value={a.border} options={borders} disabled={disabled} onChange={v => change("border", v)} />
      {"apparentElevation" in a && <><SelectField name="Apparent elevation" value={a.apparentElevation} options={["flat_appearing", "raised_appearing", "unclear"]} disabled={disabled} onChange={v => change("apparentElevation", v)} /><SelectField name="Surface appearance" value={a.surface} options={surfaces} disabled={disabled} onChange={v => change("surface", v)} /></>}
      {"site" in a && <><SelectField name="Oral site" value={a.site} options={oralSites} disabled={disabled} onChange={v => change("site", v)} /><SelectField name="Visible feature" value={a.feature} options={oralFeatures} disabled={disabled} onChange={v => change("feature", v)} /></>}
    </div>
    <fieldset disabled={disabled} className="mt-3"><legend className="text-xs font-semibold">Visible colors (up to four)</legend><div className="mt-2 flex flex-wrap gap-3">{colors.map(c => <label key={c} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={a.colors.includes(c)} onChange={e => change("colors", e.target.checked ? [...a.colors, c].slice(0, 4) : a.colors.filter(v => v !== c))} />{label(c)}</label>)}</div></fieldset>
    <p className="mt-4 text-xs font-semibold">Draft wording</p><p className="mt-2 rounded-lg bg-slate-50 p-3 text-sm leading-6">{observationText(o)}</p>
    <p className="mt-2 text-xs leading-5 text-amber-800">{f.limitation}</p>
    <label className="mt-3 block text-xs font-semibold">Clinician verification / corrections<textarea className={input} rows={2} maxLength={500} value={note} disabled={disabled} onChange={e => setNote(e.target.value)} placeholder="Document what you verified in the photo and any corrections." /></label>
    <div className="mt-3 flex gap-2"><button disabled={disabled || !note.trim() || !a.colors.length} className={`${button} bg-teal-800 text-white`} onClick={() => onSave("accepted", a, note)}>Accept description</button><button disabled={disabled} className={button} onClick={() => onSave("rejected", f.observation!.attributes, note)}>Reject</button></div>
  </article>;
}
