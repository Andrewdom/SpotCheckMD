import { z } from "zod";

export const cropSchema = z.object({
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().min(0.02).max(1), height: z.number().min(0.02).max(1),
}).strict().refine(c => c.x + c.width <= 1.000001 && c.y + c.height <= 1.000001, "Selection must stay inside the photo.");
export type Crop = z.infer<typeof cropSchema>;
export const targetSchema = z.object({
  region: z.enum(["auto", "skin", "mouth"]), crop: cropSchema,
  diameterMm: z.number().positive().max(1000).nullable(),
  examSurface: z.enum(["not_confirmed", "flat", "raised"]),
}).strict();
export type ObservationTarget = z.infer<typeof targetSchema>;
export const anatomySchema = z.object({
  region: z.enum(["skin", "mouth", "other", "unclear"]),
  certainty: z.enum(["clear", "uncertain"]),
}).strict();
export type Anatomy = z.infer<typeof anatomySchema>;

export const colors = ["brown", "black", "red", "pink", "purple", "blue", "white", "yellow", "similar_to_surrounding_tissue", "unclear"] as const;
export const shapes = ["round", "oval", "irregular", "linear", "ring_like", "unclear"] as const;
export const borders = ["well_defined", "ill_defined", "mixed", "unclear"] as const;
export const surfaces = ["smooth_appearing", "scaly_appearing", "crusted_appearing", "broken_surface", "fluid_filled_appearing", "unclear"] as const;
export const oralSites = ["tongue", "gum", "inner_cheek", "palate", "inner_lip", "oropharynx", "unclear"] as const;
export const oralFeatures = ["ulcer_like_area", "white_area", "red_area", "raised_area", "other_visible_change", "unclear"] as const;
const common = {
  assessability: z.enum(["describable", "uncertain", "not_assessable"]),
  colors: z.array(z.enum(colors)).min(1).max(4), shape: z.enum(shapes), border: z.enum(borders),
};
export const skinSchema = z.object({ ...common,
  apparentElevation: z.enum(["flat_appearing", "raised_appearing", "unclear"]),
  surface: z.enum(surfaces),
}).strict();
export const mouthSchema = z.object({ ...common, site: z.enum(oralSites), feature: z.enum(oralFeatures) }).strict();
export type SkinAttributes = z.infer<typeof skinSchema>;
export type MouthAttributes = z.infer<typeof mouthSchema>;
export type VisualObservation = {
  region: "skin" | "mouth"; anatomy: Anatomy; routing: "automatic" | "clinician";
  target: ObservationTarget; attributes: SkinAttributes | MouthAttributes;
};
export const label = (value: string) => value.replaceAll("_", " ");

// Keep size- or palpation-dependent names out of model output. This narrow rule
// only proposes macule/patch when flatness AND a diameter came from the clinician.
// At exactly 10 mm, keep neutral wording rather than pretend conventions agree.
export function morphology(o: VisualObservation): string {
  if (o.attributes.assessability === "not_assessable") return "not assessable";
  if (o.region === "mouth") return label((o.attributes as MouthAttributes).feature);
  const a = o.attributes as SkinAttributes;
  if (a.assessability === "not_assessable") return "not assessable";
  if (o.target.examSurface === "flat" && a.apparentElevation === "flat_appearing" && a.surface === "smooth_appearing" && o.target.diameterMm !== null) {
    if (o.target.diameterMm < 10) return "macule candidate";
    if (o.target.diameterMm > 10) return "patch candidate";
  }
  return a.apparentElevation === "flat_appearing" ? "flat-appearing area" : a.apparentElevation === "raised_appearing" ? "raised-appearing area" : "skin finding";
}

export function observationText(o: VisualObservation): string {
  const a = o.attributes;
  if (a.assessability === "not_assessable") return `Selected ${o.region} area is not assessable from this photo.`;
  const parts = [`${o.region === "skin" ? "Skin" : "Mouth"} observation: ${morphology(o)}`];
  if (o.region === "mouth") parts.push(`site: ${label((a as MouthAttributes).site)}`);
  parts.push(`color: ${a.colors.map(label).join(", ")}`, `shape: ${label(a.shape)}`, `border: ${label(a.border)}`);
  if (o.region === "skin") parts.push(`surface: ${label((a as SkinAttributes).surface)}`);
  parts.push(o.target.diameterMm === null ? "size not measured" : `clinician-entered diameter: ${o.target.diameterMm} mm`);
  return parts.join("; ") + ".";
}

export function observationLimit(o: VisualObservation): string {
  const limits = ["Photo description requires clinician verification; color depends on lighting."];
  if (o.target.diameterMm === null) limits.push("No physical scale or diameter supplied.");
  if (o.region === "skin" && o.target.examSurface === "not_confirmed") limits.push("Elevation/texture not confirmed by examination.");
  if (o.routing === "clinician") limits.push("Body region selected by clinician.");
  if (o.anatomy.certainty !== "clear" || o.anatomy.region !== o.region) limits.push("AI body-region suggestion is uncertain or disagrees; verify routing.");
  if (o.region === "skin") {
    const elevation = (o.attributes as SkinAttributes).apparentElevation;
    if ((o.target.examSurface === "flat" && elevation === "raised_appearing") || (o.target.examSurface === "raised" && elevation === "flat_appearing")) limits.push("Image appearance and clinician surface entry disagree.");
  }
  return limits.join(" ");
}

export function parseReviewedAttributes(o: VisualObservation, value: unknown): VisualObservation {
  return { ...o, attributes: (o.region === "skin" ? skinSchema : mouthSchema).parse(value) };
}
