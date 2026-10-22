'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createFileServer } = require('../src/server');

const TOKEN = '0123456789abcdef0123456789abcdef-test';
const ID = '3f2b8c1e-0d4a-4e6b-9a51-1c2d3e4f5a6b';
const quiet = { info() {}, warn() {}, error() {} };

async function setup(t, maxBytes = 1 << 20) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-'));
  const server = createFileServer({ storageDir: dir, internalToken: TOKEN, maxBytes, log: quiet });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); fs.rmSync(dir, { recursive: true, force: true }); }));
  return { base, dir, server };
}

async function call(url, { method = 'GET', body, headers = {}, token = TOKEN } = {}) {
  const h = { ...headers };
  if (token !== null) h['X-Internal-Token'] = token;
  const res = await fetch(url, { method, body, headers: h });
  const buf = Buffer.from(await res.arrayBuffer());
  let json;
  try { json = JSON.parse(buf.toString()); } catch { /* binary */ }
  return { status: res.status, headers: res.headers, buf, json };
}

test('upload, full download and Range requests', async (t) => {
  const { base, dir } = await setup(t);
  const payload = Buffer.from('0123456789'.repeat(1000)); // 10 000 bytes
  const put = await call(`${base}/files/${ID}`, { method: 'PUT', body: payload });
  assert.equal(put.status, 201);
  assert.equal(put.json.size, 10000);
  assert.equal(put.json.sha256, crypto.createHash('sha256').update(payload).digest('hex'));
  assert.ok(fs.existsSync(path.join(dir, ID)));

  const full = await call(`${base}/files/${ID}`);
  assert.equal(full.status, 200);
  assert.deepEqual(full.buf, payload);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');

  const part = await call(`${base}/files/${ID}`, { headers: { Range: 'bytes=100-199' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 100-199/10000');
  assert.deepEqual(part.buf, payload.subarray(100, 200));

  const open = await call(`${base}/files/${ID}`, { headers: { Range: 'bytes=9990-' } });
  assert.equal(open.status, 206);
  assert.deepEqual(open.buf, payload.subarray(9990));

  const suffix = await call(`${base}/files/${ID}`, { headers: { Range: 'bytes=-5' } });
  assert.equal(suffix.headers.get('content-range'), 'bytes 9995-9999/10000');

  const bad = await call(`${base}/files/${ID}`, { headers: { Range: 'bytes=999999-' } });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('content-range'), 'bytes */10000');

  const head = await call(`${base}/files/${ID}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10000');
  assert.equal(head.buf.length, 0);
});

test('If-Range with a stale validator returns the whole file', async (t) => {
  const { base } = await setup(t);
  await call(`${base}/files/${ID}`, { method: 'PUT', body: Buffer.alloc(1000, 1) });
  const etag = (await call(`${base}/files/${ID}`, { method: 'HEAD' })).headers.get('etag');
  const fresh = await call(`${base}/files/${ID}`, { headers: { Range: 'bytes=0-9', 'If-Range': etag } });
  assert.equal(fresh.status, 206);
  const stale = await call(`${base}/files/${ID}`, { headers: { Range: 'bytes=0-9', 'If-Range': '"old"' } });
  assert.equal(stale.status, 200);
  assert.equal(stale.buf.length, 1000);
});

test('missing or wrong token is rejected; /healthz stays open', async (t) => {
  const { base, server } = await setup(t);
  assert.equal((await call(`${base}/files/${ID}`, { token: null })).status, 401);
  assert.equal((await call(`${base}/files/${ID}`, { token: 'wrong-token' })).status, 401);
  assert.equal((await call(`${base}/stats`, { token: 'x'.repeat(200) })).status, 401);
  assert.equal((await call(`${base}/healthz`, { token: null })).status, 200);
  assert.equal(server.stats.rejected_unauthorized, 3);
});

test('invalid ids and path traversal are rejected', async (t) => {
  const { base, dir } = await setup(t);
  for (const id of ['..%2F..%2Fetc%2Fpasswd', 'not-a-uuid', ID.toUpperCase(), '%E0%A4%A']) {
    const r = await call(`${base}/files/${id}`, { method: 'PUT', body: 'x' });
    assert.equal(r.status, 400, id);
  }
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('size limit: declared and streamed (chunked) uploads; no partial file left', async (t) => {
  const { base, dir } = await setup(t, 100);
  assert.equal((await call(`${base}/files/${ID}`, { method: 'PUT', body: Buffer.alloc(101) })).status, 413);

  // chunked upload without Content-Length: the limit must still hold
  const status = await new Promise((resolve, reject) => {
    const u = new URL(`${base}/files/${ID}`);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'PUT',
      headers: { 'X-Internal-Token': TOKEN, 'Transfer-Encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write(Buffer.alloc(60));
    req.write(Buffer.alloc(60));
    req.end();
  });
  assert.equal(status, 413);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(fs.readdirSync(dir), [], 'temp file must be removed');
});

test('empty body, duplicate upload and delete', async (t) => {
  const { base } = await setup(t);
  assert.equal((await call(`${base}/files/${ID}`, { method: 'PUT', body: '' })).status, 400);
  assert.equal((await call(`${base}/files/${ID}`, { method: 'PUT', body: 'abc' })).status, 201);
  assert.equal((await call(`${base}/files/${ID}`, { method: 'PUT', body: 'xyz' })).status, 409);
  assert.equal((await call(`${base}/files/${ID}`)).buf.toString(), 'abc', 'original must not be overwritten');
  assert.equal((await call(`${base}/files/${ID}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call(`${base}/files/${ID}`)).status, 404);
  assert.equal((await call(`${base}/files/${ID}`, { method: 'DELETE' })).status, 404);
});

test('readiness reflects storage writability', async (t) => {
  const { base, dir } = await setup(t);
  assert.equal((await call(`${base}/readyz`)).status, 200);
  if (process.getuid && process.getuid() === 0) return t.skip('root ignores directory permissions');
  fs.chmodSync(dir, 0o500);
  t.after(() => { try { fs.chmodSync(dir, 0o750); } catch { /* already removed */ } });
  assert.equal((await call(`${base}/readyz`)).status, 503);
});
