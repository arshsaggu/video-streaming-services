'use strict';
const http = require('node:http');
const { HttpError } = require('./http-utils');

/**
 * Client for the internal File System Service. Every call carries the shared
 * X-Internal-Token; the token never leaves the private backend network.
 */
function createFileClient({ baseUrl, token, agent, log, timeoutMs = 10000 }) {
  const base = new URL(baseUrl);

  function request(method, id, { headers = {}, rid } = {}) {
    return http.request({
      hostname: base.hostname, port: base.port, path: `/files/${id}`, method, agent, timeout: timeoutMs,
      headers: { 'X-Internal-Token': token, ...(rid ? { 'X-Request-ID': rid } : {}), ...headers },
    });
  }

  function unavailable(rid, err) {
    log?.error('file service unreachable', { rid, err: err.code || err.message });
    return new HttpError(503, 'file storage unavailable');
  }

  /** Stream `source` into the file service. Resolves with { size, sha256 }. */
  function put(id, source, { contentLength, rid }) {
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/octet-stream' };
      if (contentLength) headers['Content-Length'] = contentLength;
      const req = request('PUT', id, { headers, rid });
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; reject(e); } };
      req.on('timeout', () => req.destroy(new Error('file service timeout')));
      req.on('error', (err) => fail(err instanceof HttpError ? err : unavailable(rid, err)));
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let body = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
          if (res.statusCode === 201) { settled = true; resolve({ size: body.size, sha256: body.sha256 }); return; }
          if (res.statusCode === 413) return fail(new HttpError(413, 'file too large'));
          log?.error('file service rejected upload', { rid, status: res.statusCode });
          fail(new HttpError(502, 'file storage error'));
        });
      });
      source.on('error', (err) => {
        // validation failure or client aborted: abort the upstream request so no partial file is kept
        req.destroy();
        fail(err instanceof HttpError ? err : new HttpError(400, 'upload aborted'));
      });
      source.pipe(req);
    });
  }

  function remove(id, rid) {
    return new Promise((resolve) => {
      const req = request('DELETE', id, { rid });
      req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => resolve(0));
      req.on('timeout', () => req.destroy());
      req.end();
    });
  }

  /** Open a (possibly ranged) download. Resolves with the upstream IncomingMessage. */
  function get(id, { range, ifRange, rid, method = 'GET' }) {
    return new Promise((resolve, reject) => {
      const headers = {};
      if (range) headers.Range = range;
      if (ifRange) headers['If-Range'] = ifRange;
      const req = request(method, id, { headers, rid });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('file service timeout')));
      req.on('response', (res) => {
        res.setTimeout?.(0);
        req.setTimeout(0);
        resolve(res);
      });
      req.on('error', (err) => reject(unavailable(rid, err)));
      req.end();
    });
  }

  async function ready(rid) {
    return new Promise((resolve) => {
      const req = http.request({ hostname: base.hostname, port: base.port, path: '/readyz', agent, timeout: 2000,
        headers: { 'X-Internal-Token': token, ...(rid ? { 'X-Request-ID': rid } : {}) } });
      req.on('response', (res) => { res.resume(); resolve(res.statusCode === 200); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => req.destroy());
      req.end();
    });
  }

  return { put, remove, get, ready };
}

module.exports = { createFileClient };
