const sharp = require('sharp');
const assert = require('node:assert/strict');
(async () => {
  const base = process.env.SMOKE_BASE || 'http://127.0.0.1:3107';
  let cookie = '';
  async function action(name, body, auth = cookie) {
    const response = await fetch(`${base}/api/demo?action=${name}`, { method: 'POST', headers: { Origin: base, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(auth ? { Cookie: auth } : {}) }, body: body instanceof FormData ? body : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
  }
  assert.ok(process.env.SMOKE_USERNAME && process.env.SMOKE_PASSWORD, 'set SMOKE_USERNAME and SMOKE_PASSWORD');
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: process.env.SMOKE_USERNAME, password: process.env.SMOKE_PASSWORD }) });
  assert.equal(login.status, 200, 'physician sign-in failed');
  cookie = login.headers.get('set-cookie').split(';')[0];
  const created = await action('create', { patientId: 'demo-001' }); let e = created.body.encounter;
  assert.equal(created.status, 200);
  assert.equal((await action('approve', { encounterId: e.id, revision: e.revision, physician: 'Dr Test' })).status, 400);
  const removedPairingAction = await action('pair', { encounterId: e.id, revision: e.revision });
  assert.equal(removedPairingAction.status, 400);
  const doctorCookie = cookie;
  const confirm = await action('confirm', { encounterId: e.id, revision: e.revision, confirmed: true, consent: true }, doctorCookie); e = confirm.body.encounter;
  const photo = await sharp({ create: { width: 800, height: 800, channels: 3, background: { r: 135, g: 115, b: 100 } } }).jpeg().toBuffer();
  const form = new FormData(); form.append('encounterId', e.id); form.append('revision', e.revision); form.append('kind', 'image'); form.append('file', new Blob([photo], { type: 'image/jpeg' }), 'synthetic.jpg');
  const upload = await action('upload', form, doctorCookie); e = upload.body.encounter;
  assert.equal(upload.status, 200);
  assert.equal(e.sources[0].quality.status, 'limited');
  assert.equal((await fetch(`${base}/api/media/${e.sources[0].mediaId}`, { headers: { Cookie: doctorCookie } })).status, 200);
  assert.notEqual((await fetch(`${base}/api/media/${e.sources[0].mediaId}`)).status, 200);
  assert.equal((await action('export', { encounterId: e.id, revision: e.revision }, doctorCookie)).status, 400);
  if (process.env.LIVE_AI === '1') {
    const result = await action('analyze', { encounterId: e.id, revision: e.revision }, doctorCookie);
    assert.equal(result.status, 200, result.body.error || 'live analysis failed');
    e = result.body.encounter;
    console.log(`LIVE AI: ${result.body.encounter.findings.length} pending finding(s), ${result.body.encounter.model}`);
  }
  const manual = await action('manual', { encounterId: e.id, revision: e.revision, section: 'O', sourceId: e.sources[0].id, text: 'Staged brown patch is visible.', evidenceQuote: 'Central region of synthetic image' }, doctorCookie);
  assert.equal(manual.status, 200); e = manual.body.encounter;
  const accepted = await action('review', { encounterId: e.id, revision: e.revision, findingId: e.findings[0].id, review: 'accepted', text: e.findings[0].text, reviewNote: 'Synthetic image is limited; clinician reviewed the source.' }, doctorCookie);
  assert.equal(accepted.status, 200); e = accepted.body.encounter;
  const approved = await action('approve', { encounterId: e.id, revision: e.revision, physician: 'Dr Demo' }, doctorCookie);
  assert.equal(approved.status, 200); e = approved.body.encounter;
  const exported = await action('export', { encounterId: e.id, revision: e.revision }, doctorCookie);
  assert.equal(exported.status, 200); e = exported.body.encounter;
  const repeated = await action('export', { encounterId: e.id, revision: e.revision }, doctorCookie);
  assert.equal(repeated.body.encounter.export.id, e.export.id);
  const edited = await action('review', { encounterId: e.id, revision: e.revision, findingId: e.findings[0].id, review: 'accepted', text: 'Edited clinician wording.', reviewNote: 'Changed after approval' }, doctorCookie);
  assert.equal(edited.body.encounter.approval, null);
  assert.equal((await action('export', { encounterId: e.id, revision: edited.body.encounter.revision }, doctorCookie)).status, 400);
  console.log('PASS: direct browser workspace, consent, quality, media auth, approval, idempotent simulated export, edit revocation');
})().catch(error => { console.error(error); process.exitCode = 1; });
