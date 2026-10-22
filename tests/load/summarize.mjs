// Turns k6 summaries + docker stats samples into a comparison table.
// Usage: node summarize.mjs <resultsDir> <label>...    -> prints markdown
import { readFileSync, existsSync } from 'node:fs';

const [dir, ...labels] = process.argv.slice(2);
const SERVICES = ['streaming-web', 'auth-service', 'mysql', 'file-service'];

const mem = (s) => { // "123.4MiB / 256MiB" -> MiB
  const m = /([\d.]+)\s*([KMG]i?B)/.exec(s);
  if (!m) return 0;
  return Number(m[1]) * ({ KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 }[m[2]] || 1);
};

const rows = [];
for (const label of labels) {
  const k = JSON.parse(readFileSync(`${dir}/k6-${label}.json`, 'utf8')).metrics;
  const stats = existsSync(`${dir}/stats-${label}.csv`) ? readFileSync(`${dir}/stats-${label}.csv`, 'utf8').trim().split('\n') : [];
  const per = {};
  for (const line of stats) {
    const [name, cpu, usage] = line.split(',');
    const svc = SERVICES.find((s) => name.includes(s));
    if (!svc) continue;
    per[svc] ??= { cpu: [], mem: [] };
    per[svc].cpu.push(Number.parseFloat(cpu));
    per[svc].mem.push(mem(usage));
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const max = (a) => (a.length ? Math.max(...a) : 0);
  rows.push({
    label,
    rps: k.http_reqs.rate,
    reqs: k.http_reqs.count,
    failed: (k.http_req_failed.value ?? k.http_req_failed.rate ?? 0) * 100,
    p95list: k['http_req_duration{name:list}']?.['p(95)'],
    p95range: k['http_req_duration{name:range}']?.['p(95)'],
    avg: k.http_req_duration.avg,
    mbps: (k.data_received.rate * 8) / 1e6,
    res: Object.fromEntries(SERVICES.map((s) => [s, per[s] ? `${avg(per[s].cpu).toFixed(0)}% / ${max(per[s].mem).toFixed(0)} MiB` : 'n/a'])),
  });
}

const f = (n, d = 1) => (n === undefined ? 'n/a' : n.toFixed(d));
console.log('| Run | Throughput (req/s) | Requests | Errors | Avg latency (ms) | p95 list (ms) | p95 range (ms) | Data out (Mbit/s) |');
console.log('|---|---:|---:|---:|---:|---:|---:|---:|');
for (const r of rows) {
  console.log(`| ${r.label} | ${f(r.rps)} | ${r.reqs} | ${f(r.failed, 2)}% | ${f(r.avg)} | ${f(r.p95list)} | ${f(r.p95range)} | ${f(r.mbps)} |`);
}
console.log('\nAverage CPU / peak memory per container during each run:\n');
console.log(`| Run | ${SERVICES.join(' | ')} |`);
console.log(`|---|${SERVICES.map(() => '---').join('|')}|`);
for (const r of rows) console.log(`| ${r.label} | ${SERVICES.map((s) => r.res[s]).join(' | ')} |`);
