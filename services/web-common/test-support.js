'use strict';
// Helpers for the web apps' unit tests: fake auth + file clients and a tiny HTTP client.
const crypto = require('node:crypto');
const http = require('node:http');
const { Readable } = require('node:stream');
const { HttpError } = require('./http-utils');

function fakeAuth(users = {}) {
  // users: token -> { username, role }
  let down = false;
  return {
    setDown(v) { down = v; },
    async verify(token) {
      if (down) throw new HttpError(503, 'authentication service unavailable');
      return users[token] || null;
    },
    async login(username) {
      const tok = Object.keys(users).find((t) => users[t].username === username);
      if (!tok) throw new HttpError(401, 'invalid username or password');
      return { token: tok, username, role: users[tok].role, expires_in: 3600 };
    },
    async register(username) { return { username, role: 'viewer' }; },
    async ready() { return !down; },
  };
}

function fakeFiles() {
  const store = new Map();
  let down = false;
  return {
    store,
    setDown(v) { down = v; },
    put(id, source) {
      return new Promise((resolve, reject) => {
        if (down) {
          source.resume();
          reject(new HttpError(503, 'file storage unavailable'));
          return;
        }
        const chunks = [];
        source.on('data', (c) => chunks.push(c));
        source.on('error', reject);
        source.on('end', () => {
          const buf = Buffer.concat(chunks);
          store.set(id, buf);
          resolve({ size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
        });
      });
    },
    async remove(id) { store.delete(id); return 204; },
    async get(id, { range }) {
      if (down) throw new HttpError(503, 'file storage unavailable');
      const buf = store.get(id);
      if (!buf) return Object.assign(Readable.from([]), { statusCode: 404, headers: {} });
      const m = range && /^bytes=(\d+)-(\d*)$/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : buf.length - 1;
        return Object.assign(Readable.from([buf.subarray(start, end + 1)]), {
          statusCode: 206,
          headers: { 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${buf.length}`, 'accept-ranges': 'bytes' },
        });
      }
      return Object.assign(Readable.from([buf]), { statusCode: 200,
        headers: { 'content-length': String(buf.length), 'accept-ranges': 'bytes' } });
    },
    async ready() { return !down; },
  };
}

const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, close: () => new Promise((r) => server.close(r)) };
}

/** fetch() wrapper returning { status, headers, body(Buffer), json } */
async function req(url, opts = {}) {
  const res = await fetch(url, opts);
  const body = Buffer.from(await res.arrayBuffer());
  let json;
  try { json = JSON.parse(body.toString('utf8')); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, body, json };
}

// Minimal valid-looking file headers for each container format.
const SAMPLES = {
  mp4: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(200, 7)]),
  webm: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 1)]),
  exe: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0)]),
};

module.exports = { fakeAuth, fakeFiles, quietLog, listen, req, SAMPLES };
