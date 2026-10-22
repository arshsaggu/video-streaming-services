'use strict';
/**
 * File System Service (Node.js, standard library only).
 *
 * Stores and serves video files on a persistent volume. Internal only: it is
 * attached to the private `backend` network, publishes no port, and every
 * request (except /healthz) must carry the shared X-Internal-Token.
 *
 *   PUT    /files/{id}   stream body to disk (atomic publish), returns size + sha256
 *   GET    /files/{id}   serve file; supports HTTP Range (needed for video seeking)
 *   HEAD   /files/{id}
 *   DELETE /files/{id}
 *   GET    /healthz      liveness
 *   GET    /readyz       storage directory is writable
 *   GET    /stats        simple counters for observability
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class TooLarge extends Error {}

function createFileServer({ storageDir, internalToken, maxBytes, readBufferBytes = 1024 * 1024, log }) {
  fs.mkdirSync(storageDir, { recursive: true, mode: 0o750 });
  // Hash both sides so timingSafeEqual always compares equal-length buffers.
  const wantDigest = crypto.createHash('sha256').update(internalToken).digest();
  const stats = { uploads: 0, downloads: 0, bytes_in: 0, bytes_out: 0, rejected_unauthorized: 0 };

  const json = (res, status, body, extra = {}) => {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length, ...extra });
    res.end(data);
  };

  const authorized = (req) => {
    const got = crypto.createHash('sha256').update(String(req.headers['x-internal-token'] || '')).digest();
    return crypto.timingSafeEqual(got, wantDigest);
  };

  async function put(req, res, id) {
    const finalPath = path.join(storageDir, id);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      return json(res, 413, { error: 'file too large' }, { Connection: 'close' });
    }
    if (fs.existsSync(finalPath)) {
      req.resume();
      return json(res, 409, { error: 'file already exists' });
    }

    const tmpPath = path.join(storageDir, `.upload-${crypto.randomUUID()}`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    // Counts and hashes on the fly; aborts as soon as the limit is crossed
    // (does not trust Content-Length, which a chunked upload doesn't have).
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(new TooLarge());
        hash.update(chunk);
        cb(null, chunk);
      },
    });

    try {
      // flush: true -> fsync before close, so a crash can't leave a "complete" but empty file.
      await pipeline(req, meter, fs.createWriteStream(tmpPath, { flags: 'wx', mode: 0o640, flush: true }));
    } catch (err) {
      await fsp.rm(tmpPath, { force: true });
      if (err instanceof TooLarge) return json(res, 413, { error: 'file too large' }, { Connection: 'close' });
      log.warn('upload aborted', { rid: req.headers['x-request-id'], id, err: err.code || err.message });
      if (!res.headersSent && !res.destroyed) json(res, 400, { error: 'upload aborted' });
      return;
    }
    if (size === 0) {
      await fsp.rm(tmpPath, { force: true });
      return json(res, 400, { error: 'empty body' });
    }
    try {
      // link() fails with EEXIST instead of overwriting: atomic publish, no race between two uploads.
      await fsp.link(tmpPath, finalPath);
    } catch (err) {
      await fsp.rm(tmpPath, { force: true });
      if (err.code === 'EEXIST') return json(res, 409, { error: 'file already exists' });
      throw err;
    }
    await fsp.rm(tmpPath, { force: true });
    stats.uploads += 1;
    stats.bytes_in += size;
    json(res, 201, { id, size, sha256: hash.digest('hex') });
  }

  /** Parses a single "bytes=" range. Returns {start,end}, 'invalid' (-> 416) or null (-> whole file). */
  function parseRange(header, size) {
    if (!header) return null;
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m) return null; // multi-range or unknown unit: RFC 9110 allows ignoring Range
    let start;
    let end;
    if (m[1] === '' && m[2] === '') return 'invalid';
    if (m[1] === '') { // suffix: last N bytes
      const n = Number(m[2]);
      if (n === 0) return 'invalid';
      start = Math.max(0, size - n);
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
    if (start >= size || start > end) return 'invalid';
    return { start, end };
  }

  async function get(req, res, id) {
    const filePath = path.join(storageDir, id);
    let st;
    try {
      st = await fsp.stat(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') return json(res, 404, { error: 'not found' });
      throw err;
    }
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const lastModified = st.mtime.toUTCString();
    const base = { 'Accept-Ranges': 'bytes', ETag: etag, 'Last-Modified': lastModified,
      'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' };

    // If-Range: only honour Range when the client's copy is still current.
    const ifRange = req.headers['if-range'];
    const rangeAllowed = !ifRange || ifRange === etag || ifRange === lastModified;
    const range = rangeAllowed ? parseRange(req.headers.range, st.size) : null;

    if (range === 'invalid') {
      return json(res, 416, { error: 'range not satisfiable' }, { 'Content-Range': `bytes */${st.size}` });
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : st.size - 1;
    const length = st.size === 0 ? 0 : end - start + 1;
    const headers = { ...base, 'Content-Length': length };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD' || length === 0) return res.end();

    // Performance improvement #3: read in large chunks (default 1 MiB instead of
    // Node's 64 KiB) -> ~16x fewer read syscalls / chunk callbacks per video.
    const stream = fs.createReadStream(filePath, { start, end, highWaterMark: readBufferBytes });
    try {
      await pipeline(stream, res);
      stats.downloads += 1;
      stats.bytes_out += length;
    } catch (err) {
      // The viewer seeked or closed the tab: normal for video, not an error.
      if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        log.warn('download interrupted', { rid: req.headers['x-request-id'], id, err: err.code || err.message });
      }
    }
  }

  async function del(_req, res, id) {
    try {
      await fsp.unlink(path.join(storageDir, id));
    } catch (err) {
      if (err.code === 'ENOENT') return json(res, 404, { error: 'not found' });
      throw err;
    }
    res.writeHead(204);
    res.end();
  }

  async function readyz(res) {
    const probe = path.join(storageDir, '.ready-probe');
    try {
      await fsp.writeFile(probe, 'ok', { mode: 0o600 });
      await fsp.rm(probe, { force: true });
      json(res, 200, { status: 'ok', storage: 'writable' });
    } catch (err) {
      log.error('storage not writable', { err: err.code || err.message });
      json(res, 503, { status: 'unavailable', storage: 'not writable' });
    }
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/healthz' && req.method === 'GET') return json(res, 200, { status: 'ok' });

    if (!authorized(req)) {
      stats.rejected_unauthorized += 1;
      log.warn('rejected request without valid internal token',
        { rid: req.headers['x-request-id'], remote: req.socket.remoteAddress, path: p });
      req.resume();
      return json(res, 401, { error: 'unauthorized' });
    }
    if (p === '/readyz' && req.method === 'GET') return readyz(res);
    if (p === '/stats' && req.method === 'GET') return json(res, 200, stats);

    const m = /^\/files\/([^/]+)$/.exec(p);
    if (!m) return json(res, 404, { error: 'not found' });
    let id;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      return json(res, 400, { error: 'invalid file id' });
    }
    // Strict UUID check also blocks path traversal ("../", "%2F", absolute paths).
    if (!ID_RE.test(id)) {
      req.resume();
      return json(res, 400, { error: 'invalid file id' });
    }
    switch (req.method) {
      case 'PUT': return put(req, res, id);
      case 'GET': case 'HEAD': return get(req, res, id);
      case 'DELETE': return del(req, res, id);
      default: return json(res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD, PUT, DELETE' });
    }
  }

  const server = http.createServer(async (req, res) => {
    const t0 = process.hrtime.bigint();
    const p = req.url.split('?')[0];
    res.on('finish', () => {
      if (p === '/healthz') return;
      log.info('request', { rid: req.headers['x-request-id'], method: req.method, path: p,
        range: req.headers.range, status: res.statusCode,
        ms: Number((process.hrtime.bigint() - t0) / 1000n) / 1000 });
    });
    try {
      await route(req, res);
    } catch (err) {
      log.error('storage error', { rid: req.headers['x-request-id'], path: p, err: err.code || err.message });
      if (!res.headersSent) json(res, 500, { error: 'storage error' });
      else res.destroy();
    }
  });
  server.requestTimeout = 0;      // large uploads and long video streams are legitimate
  server.headersTimeout = 15000;  // ...but slow header trickling is cut off
  server.keepAliveTimeout = 65000;
  server.stats = stats;
  return server;
}

module.exports = { createFileServer };
