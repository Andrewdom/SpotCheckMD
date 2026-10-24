import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { morphology, observationText, targetSchema, type VisualObservation } from "../lib/observations";
import { assessImage, cropPhoto, describePhoto } from "../lib/analysis";

const target = { region: "auto" as const, crop: { x: .1, y: .2, width: .5, height: .4 }, diameterMm: null, examSurface: "not_confirmed" as const };
const observation: VisualObservation = {
  region: "skin", anatomy: { region: "skin", certainty: "clear" }, routing: "automatic", target,
  attributes: { assessability: "describable", colors: ["brown"], shape: "oval", border: "well_defined", apparentElevation: "flat_appearing", surface: "smooth_appearing" },
};

test("morphology requires independent measurement and examination; never guesses size", () => {
  assert.equal(morphology(observation), "flat-appearing area");
  assert.match(observationText(observation), /size not measured/);
  assert.equal(morphology({ ...observation, target: { ...target, diameterMm: 15 } }), "flat-appearing area");
  assert.equal(morphology({ ...observation, target: { ...target, diameterMm: 15, examSurface: "flat" } }), "patch candidate");
  assert.equal(morphology({ ...observation, target: { ...target, diameterMm: 5, examSurface: "flat" } }), "macule candidate");
  assert.equal(morphology({ ...observation, target: { ...target, diameterMm: 10, examSurface: "flat" } }), "flat-appearing area");
  assert.equal(morphology({ ...observation, target: { ...target, diameterMm: 15, examSurface: "raised" } }), "flat-appearing area");
});

test("crop and diameter input rejects invalid and out-of-bounds values", () => {
  for (const bad of [{...target, diameterMm: -2}, {...target, diameterMm: "8"}, {...target, crop: {...target.crop, x: .9}}, {...target, crop: {...target.crop, width: 0}}, {...target, crop: {...target.crop, y: NaN}}]) assert.equal(targetSchema.safeParse(bad).success, false);
});

test("selection extracts actual pixels and blocks unusably small crops", async () => {
  const bytes = await sharp({ create: { width: 800, height: 600, channels: 3, background: "brown" } }).jpeg().toBuffer();
  const crop = await sharp(await cropPhoto(bytes, target)).metadata();
  assert.equal(crop.width, 400); assert.equal(crop.height, 240);
  await assert.rejects(() => cropPhoto(bytes, { ...target, crop: { x: 0, y: 0, width: .02, height: .02 } }), /larger area/);
});

test("quality gate does not equate low average brightness with unusable exposure", async () => {
  for (const v of [20, 60, 120, 210]) {
    const bytes = await sharp({create:{width:800,height:800,channels:3,background:{r:v,g:v,b:v}}}).jpeg().toBuffer();
    const result = await assessImage(bytes);
    assert.equal(result.quality.status, "limited", `uniform shade ${v} should warn about detail, not be rejected for mean brightness`);
  }
  const black = await sharp({create:{width:800,height:800,channels:3,background:"black"}}).jpeg().toBuffer();
  assert.equal((await assessImage(black)).quality.status, "retake");
});

test("uncertain or unsupported anatomy stops the descriptive stage", async () => {
  const original = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-placeholder";
  try {
    for (const anatomy of [{region:"unclear",certainty:"uncertain"},{region:"other",certainty:"clear"},{region:"skin",certainty:"uncertain"}]) {
      let count = 0;
      globalThis.fetch = async () => { count++; return Response.json({output:[{content:[{type:"output_text",text:JSON.stringify(anatomy)}]}]}); };
      const bytes = await sharp({create:{width:800,height:800,channels:3,background:"tan"}}).jpeg().toBuffer();
      const result = await describePhoto({id:"photo",bytes,quality:{status:"usable",reasons:[],guidance:[]},target});
      assert.equal(count,1); assert.equal(result.suggestion.certainty,"not_assessable"); assert.equal(result.suggestion.observation,undefined);
    }
  } finally { globalThis.fetch = original; delete process.env.OPENAI_API_KEY; }
});

test("AI output cannot smuggle a measurement or diagnosis through extra fields", async () => {
  const original = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-placeholder";
  try {
    let count = 0;
    globalThis.fetch = async () => Response.json({output:[{content:[{type:"output_text",text:JSON.stringify(++count === 1 ? observation.anatomy : {...observation.attributes,diameterMm:22,diagnosis:"invented"})}]}]});
    const bytes = await sharp({create:{width:800,height:800,channels:3,background:"tan"}}).jpeg().toBuffer();
    await assert.rejects(() => describePhoto({id:"photo",bytes,quality:{status:"usable",reasons:[],guidance:[]},target}), /invalid description/);
  } finally { globalThis.fetch = original; delete process.env.OPENAI_API_KEY; }
});
