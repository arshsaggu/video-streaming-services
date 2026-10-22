// k6 load test: a realistic viewer session mix.
//   - browse the catalogue (MySQL + auth check)
//   - fetch a 256 KB byte range of a video (auth check + MySQL lookup + file-service proxy)
//
// Run via: ./scripts/loadtest.sh   (seeds a user + video, runs this, collects docker stats)
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:8082';
const CHUNK = 256 * 1024;

export const options = {
  scenarios: {
    viewers: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: Number(__ENV.VUS || 50) },
        { duration: __ENV.DURATION || '40s', target: Number(__ENV.VUS || 50) },
        { duration: '5s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:list}': ['p(95)<500'],
    'http_req_duration{name:range}': ['p(95)<800'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'max'],
};

export function setup() {
  const res = http.post(`${BASE}/api/login`, JSON.stringify({ username: __ENV.K6_USER, password: __ENV.K6_PASSWORD }), {
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.body}`);
  const cookie = res.headers['Set-Cookie'].split(';')[0];
  const list = http.get(`${BASE}/api/videos?limit=50`, { headers: { Cookie: cookie } }).json();
  if (!list.videos.length) throw new Error('no videos to stream - run scripts/loadtest.sh to seed');
  return { cookie, videos: list.videos.map((v) => ({ id: v.id, size: v.size })) };
}

export default function (data) {
  const headers = { Cookie: data.cookie };
  const list = http.get(`${BASE}/api/videos?limit=24`, { headers, tags: { name: 'list' } });
  check(list, { 'list 200': (r) => r.status === 200 });

  const v = data.videos[Math.floor(Math.random() * data.videos.length)];
  const start = Math.floor(Math.random() * Math.max(1, v.size - CHUNK));
  const end = Math.min(v.size - 1, start + CHUNK - 1);
  const part = http.get(`${BASE}/api/videos/${v.id}/stream`, {
    headers: { ...headers, Range: `bytes=${start}-${end}` }, tags: { name: 'range' }, responseType: 'none',
  });
  check(part, { 'range 206': (r) => r.status === 206 });
  sleep(Number(__ENV.THINK ?? 0.2)); // THINK=0 turns this into a saturation (max throughput) test
}
