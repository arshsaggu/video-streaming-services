'use strict';
const crypto = require('node:crypto');
const {
  HttpError, SECURITY_HEADERS, sendJSON, readJSON, parseCookies, sessionCookie, staticAssets,
  requireSameOriginHeader,
} = require('./http-utils');

const COOKIE = 'vss_session';

/**
 * Minimal web framework shared by the Upload and Streaming web apps:
 * routing, request ids, access logs, security headers, error mapping, and the
 * session endpoints (/api/login, /api/logout, /api/register, /api/me).
 *
 * The browser never sees the JWT in JavaScript: it lives in an HttpOnly,
 * SameSite=Strict cookie set by this server.
 */
function createWebApp({ service, log, auth, staticDir, cookieSecure = false, routes = [], readiness = async () => ({}) }) {
  const serveStatic = staticAssets(staticDir);

  async function currentUser(ctx) {
    if (ctx._user !== undefined) return ctx._user;
    const token = parseCookies(ctx.req.headers.cookie)[COOKIE];
    ctx._user = token ? await auth.verify(token, ctx.rid) : null;
    return ctx._user;
  }

  async function requireUser(ctx, roles) {
    const user = await currentUser(ctx);
    if (!user) throw new HttpError(401, 'login required');
    if (roles && !roles.includes(user.role)) {
      log.warn('forbidden', { rid: ctx.rid, user: user.username, role: user.role, path: ctx.path });
      throw new HttpError(403, `requires role: ${roles.join(' or ')}`);
    }
    ctx.user = user;
    return user;
  }

  const builtins = [
    ['GET', /^\/healthz$/, async (ctx) => sendJSON(ctx.res, 200, { status: 'ok' })],
    ['GET', /^\/readyz$/, async (ctx) => {
      const deps = await readiness(ctx.rid);
      const ok = Object.values(deps).every((v) => v === 'up');
      sendJSON(ctx.res, ok ? 200 : 503, { status: ok ? 'ok' : 'degraded', ...deps });
    }],
    ['POST', /^\/api\/login$/, async (ctx) => {
      requireSameOriginHeader(ctx.req);
      const { username, password } = await readJSON(ctx.req);
      if (typeof username !== 'string' || typeof password !== 'string') throw new HttpError(422, 'username and password required');
      const r = await auth.login(username, password, ctx.rid);
      ctx.res.setHeader('Set-Cookie', sessionCookie(COOKIE, r.token, { maxAge: r.expires_in, secure: cookieSecure }));
      log.info('session started', { rid: ctx.rid, user: r.username, role: r.role });
      sendJSON(ctx.res, 200, { username: r.username, role: r.role });
    }],
    ['POST', /^\/api\/register$/, async (ctx) => {
      requireSameOriginHeader(ctx.req);
      const { username, password } = await readJSON(ctx.req);
      if (typeof username !== 'string' || typeof password !== 'string') throw new HttpError(422, 'username and password required');
      sendJSON(ctx.res, 201, await auth.register(username, password, ctx.rid));
    }],
    ['POST', /^\/api\/logout$/, async (ctx) => {
      requireSameOriginHeader(ctx.req);
      ctx.res.setHeader('Set-Cookie', sessionCookie(COOKIE, '', { maxAge: 0, secure: cookieSecure }));
      sendJSON(ctx.res, 200, { ok: true });
    }],
    ['GET', /^\/api\/me$/, async (ctx) => {
      const u = await requireUser(ctx);
      sendJSON(ctx.res, 200, u);
    }],
  ];
  const table = [...builtins, ...routes];

  return async function handler(req, res) {
    const started = process.hrtime.bigint();
    const rid = String(req.headers['x-request-id'] || crypto.randomUUID().slice(0, 16)).slice(0, 64);
    let path;
    try {
      path = new URL(req.url, 'http://x').pathname;
    } catch {
      path = '/';
    }
    const ctx = { req, res, rid, path, query: new URL(req.url, 'http://x').searchParams, requireUser, currentUser,
      token: () => parseCookies(req.headers.cookie)[COOKIE] };
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.setHeader('X-Request-ID', rid);

    res.on('finish', () => {
      if (path === '/healthz') return;
      log.info('request', {
        rid, method: req.method, path, status: res.statusCode,
        ms: Number((process.hrtime.bigint() - started) / 1000n) / 1000,
        user: ctx.user?.username,
      });
    });

    try {
      for (const [method, re, fn] of table) {
        const m = re.exec(path);
        if (m && (method === req.method || (method === 'GET' && req.method === 'HEAD'))) {
          ctx.params = m.groups || {};
          await fn(ctx);
          return;
        }
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, path)) return;
      throw new HttpError(404, 'not found');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) log.error('request failed', { rid, path, status, err: err.message });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJSON(res, status, { error: status === 500 ? 'internal error' : err.message, ...(err.extra || {}) });
    }
  };
}

module.exports = { createWebApp, COOKIE };
