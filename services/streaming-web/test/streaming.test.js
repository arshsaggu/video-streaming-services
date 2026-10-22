'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStreamingApp } = require('../src/app');
const { memoryVideoRepo } = require('../../web-common/memory-repo');
const { fakeAuth, fakeFiles, quietLog, listen, req } = require('../../web-common/test-support');

const USERS = { 'tok-view': { username: 'vic', role: 'viewer' } };
const AUTH = { headers: { Cookie: 'vss_session=tok-view' } };

async function setup(t) {
  const repo = memoryVideoRepo();
  const files = fakeFiles();
  const auth = fakeAuth(USERS);
  const id = crypto.randomUUID();
  const bytes = crypto.randomBytes(5000);
  files.store.set(id, bytes);
  await repo.insert({ id, title: 'Sample', description: '', contentType: 'video/mp4', size: bytes.length,
    sha256: 'x', uploadedBy: 'uma' });
  const srv = await listen(createStreamingApp({ log: quietLog, auth, files, repo, cookieSecure: false }));
  t.after(srv.close);
  return { base: srv.base, repo, files, auth, id, bytes };
}

test('list requires login', async (t) => {
  const { base } = await setup(t);
  assert.equal((await req(`${base}/api/videos`)).status, 401);
  const r = await req(`${base}/api/videos`, AUTH);
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 1);
  assert.equal(r.json.videos[0].title, 'Sample');
});

test('pagination params are clamped', async (t) => {
  const { base } = await setup(t);
  const r = await req(`${base}/api/videos?limit=100000&offset=-5`, AUTH);
  assert.equal(r.json.limit, 100);
  assert.equal(r.json.offset, 0);
});

test('full and ranged streaming with correct headers', async (t) => {
  const { base, id, bytes } = await setup(t);
  const full = await req(`${base}/api/videos/${id}/stream`, AUTH);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(full.body, bytes);

  const part = await req(`${base}/api/videos/${id}/stream`, { headers: { ...AUTH.headers, Range: 'bytes=1000-1999' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 1000-1999/5000');
  assert.deepEqual(part.body, bytes.subarray(1000, 2000));
});

test('stream requires login and a valid id', async (t) => {
  const { base, id } = await setup(t);
  assert.equal((await req(`${base}/api/videos/${id}/stream`)).status, 401);
  assert.equal((await req(`${base}/api/videos/..%2F..%2Fetc%2Fpasswd/stream`, AUTH)).status, 400);
  assert.equal((await req(`${base}/api/videos/${crypto.randomUUID()}/stream`, AUTH)).status, 404);
  assert.equal((await req(`${base}/api/videos/${id}/stream`, { headers: { ...AUTH.headers, Range: 'bytes=abc' } })).status, 416);
});

test('dependency outages map to 503', async (t) => {
  const { base, id, repo, files } = await setup(t);
  files.setDown(true);
  assert.equal((await req(`${base}/api/videos/${id}/stream`, AUTH)).status, 503);
  files.setDown(false);
  repo.setDown(true);
  assert.equal((await req(`${base}/api/videos`, AUTH)).status, 503);
  const ready = await req(`${base}/readyz`);
  assert.equal(ready.status, 503);
  repo.setDown(false);
  assert.equal((await req(`${base}/api/videos`, AUTH)).status, 200, 'recovers once the database is back');
});
