import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

test("body region → selected crop → structured review → approval, with revision and failure guards", async () => {
  const root = await mkdtemp(path.join(tmpdir(),"spotcheck-test-"));
  process.env.AURA_DATA_DIR = root; process.env.OPENAI_API_KEY = "test-placeholder";
  const { POST } = await import("../app/api/demo/route");
  const original = globalThis.fetch;
  let cookie = "", e: any, mode = "skin", calls: string[] = [];
  const skin = { assessability:"describable",colors:["brown"],shape:"oval",border:"well_defined",apparentElevation:"flat_appearing",surface:"smooth_appearing" };
  const mouth = { assessability:"uncertain",colors:["white"],shape:"irregular",border:"ill_defined",site:"tongue",feature:"white_area" };
  globalThis.fetch = async (_url, init) => {
    if (mode === "429") return Response.json({error:{}},{status:429});
    const request = JSON.parse(init!.body as string), name = request.text.format.name;
    calls.push(name);
    const content = request.input[0].content;
    const photo = content.find((v:any) => v.type === "input_image");
    if (name !== "body_region") {
      assert.ok(photo, "description receives an image");
      const meta = await sharp(Buffer.from(photo.image_url.split(",")[1],"base64")).metadata();
      assert.equal(meta.width,400,"model sees selected crop");
      assert.equal(request.text.format.schema.properties.diameterMm, undefined,"AI schema has no size field");
    }
    const output = name === "body_region" ? {region:mode,certainty:"clear"} : name === "skin_description" ? skin : mouth;
    return Response.json({output:[{content:[{type:"output_text",text:JSON.stringify(output)}]}]});
  };
  async function action(name:string, body:object | FormData, auth = cookie) {
    const r = await POST(new Request(`http://localhost/api/demo?action=${name}`,{method:"POST",headers:{Origin:"http://localhost",Cookie:auth,...(body instanceof FormData?{}:{"Content-Type":"application/json"})},body:body instanceof FormData?body:JSON.stringify(body)}));
    return {status:r.status,data:await r.json(),cookie:r.headers.get("set-cookie")};
  }
  async function act(name:string, body:object = {}) { return action(name,{encounterId:e.id,revision:e.revision,...body}); }
  try {
    cookie = (await action("bootstrap",{})).cookie!.split(";")[0];
    e = (await action("create",{patientId:"demo-001"})).data.encounter;
    assert.equal((await act("detect-region",{sourceId:"missing"})).status,400);
    e = (await act("confirm",{confirmed:true,consent:true})).data.encounter;
    const photo = await sharp({create:{width:800,height:800,channels:3,background:"tan"}}).jpeg().toBuffer();
    const form = new FormData(); form.append("encounterId",e.id);form.append("revision",String(e.revision));form.append("kind","image");form.append("file",new Blob([new Uint8Array(photo)],{type:"image/jpeg"}),"synthetic.jpg");
    e = (await action("upload",form)).data.encounter;
    const sourceId = e.sources[0].id;
    assert.equal((await act("analyze")).status,400); assert.equal(calls.length,0);
    const target = {region:"auto",crop:{x:.1,y:.1,width:.5,height:.5},diameterMm:15,examSurface:"flat"};
    assert.equal((await act("target",{sourceId,target:{...target,crop:{...target.crop,x:.9}}})).status,400);
    assert.equal((await action("target",{encounterId:e.id,revision:e.revision,sourceId,target},"")).status,401);
    e = (await act("target",{sourceId,target})).data.encounter;
    const stale = e.revision;
    const analysis = await act("analyze"); assert.equal(analysis.status,200,JSON.stringify(analysis.data)); e = analysis.data.encounter;
    assert.deepEqual(calls,["body_region","skin_description"]);
    assert.equal(e.findings[0].review,"pending"); assert.match(e.findings[0].text,/patch candidate/);
    assert.equal(e.sources[0].anatomy.region,"skin"); assert.equal(e.promptVersion,"region-observation-v2");
    assert.equal((await action("target",{encounterId:e.id,revision:stale,sourceId,target})).status,409);
    const findingId = e.findings[0].id;
    assert.equal((await act("review",{findingId,review:"accepted",attributes:mouth,reviewNote:"checked"})).status,400);
    e = (await act("review",{findingId,review:"accepted",attributes:{...skin,border:"mixed"},reviewNote:""})).data.encounter;
    assert.equal((await act("approve",{physician:"Dr Demo"})).status,400);
    e = (await act("review",{findingId,review:"accepted",attributes:{...skin,border:"mixed"},reviewNote:"Verified selected synthetic area; corrected border and reviewed quality limitation."})).data.encounter;
    assert.match(e.findings[0].text,/border: mixed/);
    e = (await act("approve",{physician:"Dr Demo"})).data.encounter; assert.ok(e.approval);
    e = (await act("target",{sourceId,target:{...target,diameterMm:null,examSurface:"not_confirmed"}})).data.encounter;
    assert.equal(e.approval,null); assert.equal(e.findings.length,0);
    mode = "mouth"; calls = [];
    e = (await act("analyze")).data.encounter;
    assert.deepEqual(calls,["body_region","mouth_description"]);
    assert.equal(e.findings[0].observation.region,"mouth"); assert.match(e.findings[0].text,/size not measured/); assert.match(e.findings[0].text,/white area/);
    const prior = e.findings[0].id;
    mode = "429";
    assert.equal((await act("analyze")).status,503);
    const { GET } = await import("../app/api/demo/route");
    const reloaded = await GET(new Request("http://localhost/api/demo",{headers:{Cookie:cookie}}));
    e = (await reloaded.json()).encounters[0];
    assert.equal(e.analysis,"failed"); assert.equal(e.findings[0].id,prior,"failed run preserves previous drafts");
    assert.match(e.analysisError,/429/);
  } finally { globalThis.fetch = original; delete process.env.OPENAI_API_KEY; await rm(root,{recursive:true,force:true}); }
});
