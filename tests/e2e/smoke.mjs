// End-to-end smoke test against a running stack.
//
// Runs anywhere Node 22 runs, or (no Node needed on the host) inside the compose network:
//   docker run --rm --network vss_frontend -v "$PWD/tests:/tests:ro" -v "$PWD/secrets:/secrets:ro" \
//     -e UPLOAD_URL=http://upload-web:3000 -e STREAM_URL=http://streaming-web:3000 \
//     -e ADMIN_PASSWORD_FILE=/secrets/admin_password.txt -e CHECK_ISOLATION=1 \
//     node:22-alpine node /tests/e2e/smoke.mjs
// (./scripts/e2e.sh does exactly this.)
//
// Env: UPLOAD_URL, STREAM_URL, ADMIN_PASSWORD or ADMIN_PASSWORD_FILE (default ./secrets/admin_password.txt)
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

const UPLOAD = process.env.UPLOAD_URL || 'http://localhost:8081';
const STREAM = process.env.STREAM_URL || 'http://localhost:8082';
const ADMIN_PW = process.env.ADMIN_PASSWORD
  || readFileSync(process.env.ADMIN_PASSWORD_FILE || 'secrets/admin_password.txt', 'utf8').trim();

let failures = 0;
const check = (cond, label, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  (${detail})` : ''}`);
  if (!cond) failures += 1;
};

async function call(base, path, { method = 'GET', cookie, json, body, headers = {} } = {}) {
  const h = { 'X-Requested-With': 'fetch', ...headers };
  if (cookie) h.Cookie = cookie;
  if (json) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
  const buf = Buffer.from(await res.arrayBuffer());
  let data; try { data = JSON.parse(buf.toString()); } catch { /* binary */ }
  return { status: res.status, headers: res.headers, buf, data };
}

async function login(base, username, password) {
  const r = await call(base, '/api/login', { method: 'POST', json: { username, password } });
  const set = r.headers.get('set-cookie') || '';
  return { ...r, cookie: set.split(';')[0] };
}

// A tiny file with a valid MP4 'ftyp' header followed by random payload.
export function sampleVideo(bytes = 256 * 1024) {
  return Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(12), randomBytes(bytes)]);
}

const suffix = Date.now().toString(36);

// 1. health
for (const [name, base] of [['upload-web', UPLOAD], ['streaming-web', STREAM]]) {
  const r = await call(base, '/readyz');
  check(r.status === 200, `${name} ready (mysql/auth/file-service up)`, JSON.stringify(r.data));
}

// 2. auth
const admin = await login(UPLOAD, 'admin', ADMIN_PW);
check(admin.status === 200 && admin.cookie.startsWith('vss_session='), 'admin can log in');
check(/HttpOnly/.test(admin.headers.get('set-cookie') || ''), 'session cookie is HttpOnly');
check((await login(UPLOAD, 'admin', 'wrong-password!')).status === 401, 'wrong password rejected');

// 3. roles
const uploaderName = `up_${suffix}`;
const mk = await call(UPLOAD, '/api/admin/users', { method: 'POST', cookie: admin.cookie,
  json: { username: uploaderName, password: 'uploader-pass-1', role: 'uploader' } });
check(mk.status === 201, 'admin creates an uploader account', mk.status);
const viewerName = `view_${suffix}`;
const reg = await call(STREAM, '/api/register', { method: 'POST', json: { username: viewerName, password: 'viewer-pass-1' } });
check(reg.status === 201 && reg.data.role === 'viewer', 'self-registration creates a viewer');
const uploader = await login(UPLOAD, uploaderName, 'uploader-pass-1');
const viewer = await login(STREAM, viewerName, 'viewer-pass-1');

// 4. upload
const video = sampleVideo();
const sha = createHash('sha256').update(video).digest('hex');
const up = (cookie, extra = {}) => call(UPLOAD, '/api/videos', { method: 'POST', cookie, body: video,
  headers: { 'Content-Type': 'video/mp4', 'X-Video-Title': encodeURIComponent(`Smoke test ${suffix}`), ...extra } });
check((await up(undefined)).status === 401, 'upload without login -> 401');
check((await up(viewer.cookie)).status === 403, 'upload as viewer -> 403');
check((await call(UPLOAD, '/api/videos', { method: 'POST', cookie: uploader.cookie, body: Buffer.from('MZ' + 'x'.repeat(100)),
  headers: { 'Content-Type': 'video/mp4', 'X-Video-Title': 'fake' } })).status === 415, 'non-video content -> 415');
const ok = await up(uploader.cookie);
check(ok.status === 201 && ok.data.sha256 === sha, 'uploader uploads a video (sha256 matches)', JSON.stringify(ok.data));
const id = ok.data?.id;

// 5. streaming
const list = await call(STREAM, '/api/videos?limit=100', { cookie: viewer.cookie });
check(list.status === 200 && list.data.videos.some((v) => v.id === id), 'viewer sees the video in the catalogue');
check((await call(STREAM, '/api/videos')).status === 401, 'catalogue without login -> 401');
const full = await call(STREAM, `/api/videos/${id}/stream`, { cookie: viewer.cookie });
check(full.status === 200 && createHash('sha256').update(full.buf).digest('hex') === sha, 'full stream returns identical bytes');
check(full.headers.get('content-type') === 'video/mp4', 'stream has the stored Content-Type');
const part = await call(STREAM, `/api/videos/${id}/stream`, { cookie: viewer.cookie, headers: { Range: 'bytes=100-1123' } });
check(part.status === 206 && part.buf.length === 1024 && part.buf.equals(video.subarray(100, 1124)), 'Range request -> 206 with exact bytes');
check((await call(STREAM, `/api/videos/${id}/stream`)).status === 401, 'stream without login -> 401');

// 6. network isolation (only meaningful when run inside the compose network)
if (process.env.CHECK_ISOLATION === '1') {
  for (const url of ['http://file-service:8080/healthz', 'http://auth-service:8000/healthz', 'http://mysql:3306']) {
    let reachable = true;
    try { await fetch(url, { signal: AbortSignal.timeout(2000) }); } catch { reachable = false; }
    check(!reachable, `internal service not reachable from the frontend network: ${url}`);
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
