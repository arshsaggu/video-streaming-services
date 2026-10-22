// Seeds data for the load test: a viewer account + a few videos (uploaded as admin).
// Env: UPLOAD_URL, STREAM_URL, ADMIN_PASSWORD_FILE, K6_USER, K6_PASSWORD, SEED_VIDEOS (3), SEED_MB (8)
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const UPLOAD = process.env.UPLOAD_URL || 'http://localhost:8081';
const STREAM = process.env.STREAM_URL || 'http://localhost:8082';
const ADMIN_PW = readFileSync(process.env.ADMIN_PASSWORD_FILE || 'secrets/admin_password.txt', 'utf8').trim();
const USER = process.env.K6_USER || 'loadtest';
const PASS = process.env.K6_PASSWORD || 'loadtest-pass-123';
const WANT = Number(process.env.SEED_VIDEOS || 3);
const MB = Number(process.env.SEED_MB || 8);
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' };

const reg = await fetch(`${STREAM}/api/register`, { method: 'POST', headers: H, body: JSON.stringify({ username: USER, password: PASS }) });
console.log(`viewer '${USER}': ${reg.status === 201 ? 'created' : reg.status === 409 ? 'exists' : `HTTP ${reg.status}`}`);

const login = await fetch(`${UPLOAD}/api/login`, { method: 'POST', headers: H, body: JSON.stringify({ username: 'admin', password: ADMIN_PW }) });
if (login.status !== 200) throw new Error(`admin login failed: ${login.status}`);
const cookie = login.headers.get('set-cookie').split(';')[0];

const mine = await (await fetch(`${UPLOAD}/api/videos`, { headers: { Cookie: cookie } })).json();
const have = mine.videos.filter((v) => v.title.startsWith('Load test ')).length;
for (let i = have; i < WANT; i++) {
  const body = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(12), randomBytes(MB * 1048576)]);
  const r = await fetch(`${UPLOAD}/api/videos`, { method: 'POST', body,
    headers: { Cookie: cookie, 'X-Requested-With': 'fetch', 'Content-Type': 'video/mp4', 'X-Video-Title': encodeURIComponent(`Load test ${i + 1}`) } });
  console.log(`upload 'Load test ${i + 1}' (${MB} MB): HTTP ${r.status}`);
  if (r.status !== 201) process.exit(1);
}
console.log(`seed complete: ${Math.max(have, WANT)} load-test videos`);
