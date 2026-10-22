'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; media-src 'self' blob:; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function sendJSON(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

/** Read a small JSON body with a hard size cap. */
function readJSON(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    const type = req.headers['content-type'] || '';
    if (!type.startsWith('application/json')) {
      reject(new HttpError(415, 'expected application/json'));
      req.resume();
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        resolve(v);
      } catch {
        reject(new HttpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

function sessionCookie(name, value, { maxAge, secure }) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/**
 * Loads a directory of static assets into memory once (they are tiny) and
 * serves them with strong ETags, so repeat visits are 304s.
 */
function staticAssets(dirs) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  const files = new Map();
  for (const dir of [].concat(dirs)) for (const name of fs.readdirSync(dir)) {
    if (files.has('/' + name)) continue; // first directory wins
    const body = fs.readFileSync(path.join(dir, name));
    const etag = '"' + crypto.createHash('sha256').update(body).digest('base64url').slice(0, 16) + '"';
    files.set('/' + name, { body, etag, type: types[path.extname(name)] || 'application/octet-stream' });
  }
  return (req, res, urlPath) => {
    const f = files.get(urlPath === '/' ? '/index.html' : urlPath);
    if (!f) return false;
    if (req.headers['if-none-match'] === f.etag) {
      res.writeHead(304, { ETag: f.etag });
      res.end();
      return true;
    }
    res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': f.body.length, ETag: f.etag,
      'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : f.body);
    return true;
  };
}

/** CSRF defence for cookie-authenticated, state-changing requests. */
function requireSameOriginHeader(req) {
  // Browsers cannot add custom headers to cross-site requests without a CORS
  // preflight, which we never approve. Combined with SameSite=Strict cookies.
  if (req.headers['x-requested-with'] !== 'fetch') {
    throw new HttpError(403, 'missing X-Requested-With header');
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

module.exports = {
  HttpError, SECURITY_HEADERS, sendJSON, readJSON, parseCookies, sessionCookie, staticAssets,
  requireSameOriginHeader, UUID_RE,
};
