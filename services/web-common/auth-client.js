'use strict';
const http = require('node:http');
const { HttpError } = require('./http-utils');

/**
 * Client for the internal Authentication Service.
 *
 * verify() results are cached for `cacheTtlMs` (performance improvement #1):
 * a page load triggers several API calls plus many video Range requests, and
 * without the cache every one of them costs a round trip to auth + a MySQL
 * lookup. The TTL is short (default 30 s) so a disabled account loses access
 * quickly; a token is never cached past its own expiry.
 */
function createAuthClient({ baseUrl, agent, cacheTtlMs = 30000, maxEntries = 10000, timeoutMs = 3000, log }) {
  const base = new URL(baseUrl);
  const cache = new Map(); // token -> { user, until }

  function call(method, path, { body, token, rid } = {}) {
    return new Promise((resolve, reject) => {
      const data = body ? Buffer.from(JSON.stringify(body)) : null;
      const headers = { Accept: 'application/json' };
      if (data) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': data.length });
      if (token) headers.Authorization = `Bearer ${token}`;
      if (rid) headers['X-Request-ID'] = rid;
      const req = http.request(
        { hostname: base.hostname, port: base.port, path, method, headers, agent, timeout: timeoutMs },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            let json = {};
            try {
              json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            } catch {
              /* non-JSON error page */
            }
            resolve({ status: res.statusCode, body: json });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('auth service timeout')));
      req.on('error', (err) => {
        log?.error('auth service unreachable', { rid, err: err.code || err.message });
        reject(new HttpError(503, 'authentication service unavailable'));
      });
      if (data) req.write(data);
      req.end();
    });
  }

  async function verify(token, rid) {
    if (!token || token.length > 2048) return null;
    const now = Date.now();
    const hit = cache.get(token);
    if (hit && hit.until > now) return hit.user;
    const r = await call('GET', '/verify', { token, rid });
    if (r.status === 200) {
      const user = { username: r.body.sub, role: r.body.role };
      if (cacheTtlMs > 0) {
        if (cache.size >= maxEntries) cache.delete(cache.keys().next().value); // drop oldest
        cache.set(token, { user, until: Math.min(now + cacheTtlMs, r.body.exp * 1000) });
      }
      return user;
    }
    cache.delete(token);
    if (r.status === 401) return null;
    throw new HttpError(503, 'authentication service unavailable');
  }

  async function login(username, password, rid) {
    const r = await call('POST', '/login', { body: { username, password }, rid });
    if (r.status === 200) return r.body;
    throw new HttpError(r.status >= 500 ? 503 : r.status, r.body.error || 'login failed', r.body.fields && { fields: r.body.fields });
  }

  async function register(username, password, rid) {
    const r = await call('POST', '/register', { body: { username, password }, rid });
    if (r.status === 201) return r.body;
    throw new HttpError(r.status >= 500 ? 503 : r.status, r.body.error || 'registration failed', r.body.fields && { fields: r.body.fields });
  }

  /** Admin only: the auth service re-checks the caller's role from the token. */
  async function createUser(adminToken, { username, password, role }, rid) {
    const r = await call('POST', '/users', { body: { username, password, role }, token: adminToken, rid });
    if (r.status === 201) return r.body;
    throw new HttpError(r.status >= 500 ? 503 : r.status, r.body.error || 'user creation failed', r.body.fields && { fields: r.body.fields });
  }

  async function ready(rid) {
    try {
      return (await call('GET', '/readyz', { rid })).status === 200;
    } catch {
      return false;
    }
  }

  return { verify, login, register, createUser, ready, _cache: cache };
}

module.exports = { createAuthClient };
