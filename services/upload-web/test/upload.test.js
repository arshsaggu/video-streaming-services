'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUploadApp } = require('../src/app');
const { memoryVideoRepo } = require('../../web-common/memory-repo');
const { fakeAuth, fakeFiles, quietLog, listen, req, SAMPLES } = require('../../web-common/test-support');

const USERS = { 'tok-up': { username: 'uma', role: 'uploader' }, 'tok-view': { username: 'vic', role: 'viewer' } };

async function setup(t) {
  const repo = memoryVideoRepo();
  const files = fakeFiles();
  const auth = fakeAuth(USERS);
  const app = createUploadApp({ log: quietLog, auth, files, repo, maxBytes: 1024 * 1024, cookieSecure: false });
  const srv = await listen(app);
  t.after(srv.close);
  return { repo, files, auth, base: srv.base };
}

function uploadReq(base, { token = 'tok-up', type = 'video/mp4', body = SAMPLES.mp4, title = 'My clip', csrf = true, desc } = {}) {
  const headers = { 'Content-Type': type, 'X-Video-Title': encodeURIComponent(title) };
  if (desc !== undefined) headers['X-Video-Description'] = encodeURIComponent(desc);
  if (token) headers.Cookie = `vss_session=${token}`;
  if (csrf) headers['X-Requested-With'] = 'fetch';
  return req(`${base}/api/videos`, { method: 'POST', headers, body });
}

test('uploader can upload; file stored and metadata recorded', async (t) => {
  const { base, repo, files } = await setup(t);
  const r = await uploadReq(base, { desc: 'Café ☕ <b>not html</b>' });
  assert.equal(r.status, 201);
  assert.equal(r.json.size, SAMPLES.mp4.length);
  assert.equal(repo.rows.length, 1);
  assert.equal(repo.rows[0].uploaded_by, 'uma');
  assert.equal(repo.rows[0].description, 'Café ☕ <b>not html</b>');
  assert.deepEqual(files.store.get(r.json.id), SAMPLES.mp4);

  const list = await req(`${base}/api/videos`, { headers: { Cookie: 'vss_session=tok-up' } });
  assert.equal(list.status, 200);
  assert.equal(list.json.videos[0].title, 'My clip');
});

test('unauthenticated -> 401, viewer -> 403', async (t) => {
  const { base, repo } = await setup(t);
  assert.equal((await uploadReq(base, { token: null })).status, 401);
  assert.equal((await uploadReq(base, { token: 'forged' })).status, 401);
  assert.equal((await uploadReq(base, { token: 'tok-view' })).status, 403);
  assert.equal(repo.rows.length, 0);
});

test('missing CSRF header is refused', async (t) => {
  const { base } = await setup(t);
  assert.equal((await uploadReq(base, { csrf: false })).status, 403);
});

test('input validation: type, title, size, magic bytes', async (t) => {
  const { base, files, repo } = await setup(t);
  assert.equal((await uploadReq(base, { type: 'application/x-msdownload', body: SAMPLES.exe })).status, 422);
  assert.equal((await uploadReq(base, { title: '' })).status, 422);
  assert.equal((await uploadReq(base, { title: 'x'.repeat(121) })).status, 422);
  assert.equal((await uploadReq(base, { title: 'bad\u0007bell' })).status, 422);
  // .exe content disguised as mp4
  assert.equal((await uploadReq(base, { body: SAMPLES.exe })).status, 415);
  // webm content declared as webm is fine
  assert.equal((await uploadReq(base, { type: 'video/webm', body: SAMPLES.webm })).status, 201);
  // over the configured 1 MB limit
  assert.equal((await uploadReq(base, { body: Buffer.concat([SAMPLES.mp4, Buffer.alloc(1024 * 1024)]) })).status, 413);
  assert.equal(files.store.size, 1);
  assert.equal(repo.rows.length, 1);
});

test('database outage: upload rolled back, 503 returned', async (t) => {
  const { base, repo, files } = await setup(t);
  repo.setDown(true);
  const r = await uploadReq(base);
  assert.equal(r.status, 503);
  assert.equal(files.store.size, 0, 'stored file must be removed when metadata insert fails');
});

test('file service outage -> 503, nothing recorded', async (t) => {
  const { base, repo, files } = await setup(t);
  files.setDown(true);
  const r = await uploadReq(base);
  assert.equal(r.status, 503);
  assert.equal(repo.rows.length, 0);
});

test('auth service outage -> 503 (not 401/500)', async (t) => {
  const { base, auth } = await setup(t);
  auth.setDown(true);
  assert.equal((await uploadReq(base)).status, 503);
});

test('health, readiness and security headers', async (t) => {
  const { base, repo } = await setup(t);
  assert.equal((await req(`${base}/healthz`)).status, 200);
  assert.equal((await req(`${base}/readyz`)).status, 200);
  repo.setDown(true);
  const ready = await req(`${base}/readyz`);
  assert.equal(ready.status, 503);
  assert.equal(ready.json.mysql, 'down');
  const page = await req(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
});

test('login sets an HttpOnly SameSite=Strict cookie', async (t) => {
  const { base } = await setup(t);
  const r = await req(`${base}/api/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ username: 'uma', password: 'whatever-123' }) });
  assert.equal(r.status, 200);
  const c = r.headers.get('set-cookie');
  assert.match(c, /vss_session=tok-up/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.equal(r.json.token, undefined, 'token must not be exposed to page JavaScript');
});

test('admin user creation is admin-only and forwards the caller token', async (t) => {
  const { base, auth } = await setup(t);
  let seen;
  auth.createUser = async (tok, body) => { seen = tok; return { username: body.username, role: body.role }; };
  const mk = (tok) => req(`${base}/api/admin/users`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Cookie: `vss_session=${tok}` },
    body: JSON.stringify({ username: 'newbie', password: 'newbie-pass-1', role: 'uploader' }) });
  assert.equal((await mk('tok-up')).status, 403);
  USERS['tok-admin'] = { username: 'root', role: 'admin' };
  const r = await mk('tok-admin');
  assert.equal(r.status, 201);
  assert.equal(seen, 'tok-admin');
});
