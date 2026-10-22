'use strict';
const path = require('node:path');
const { pipeline } = require('node:stream');
const { createWebApp } = require('../../web-common/web-app');
const { HttpError, sendJSON, UUID_RE } = require('../../web-common/http-utils');

const VIEW_ROLES = ['viewer', 'uploader', 'admin'];
const PASS_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
const RANGE_RE = /^bytes=\d*-\d*(,\s*\d*-\d*)*$/;

/**
 * Video Streaming web app.
 *   GET /api/videos?limit=&offset=   catalogue from MySQL
 *   GET /api/videos/:id              one video's metadata
 *   GET /api/videos/:id/stream       video bytes; forwards HTTP Range so the
 *                                    browser can seek without downloading everything
 */
function createStreamingApp({ log, auth, files, repo, cookieSecure }) {
  const dbError = (ctx, err) => {
    log.error('database error', { rid: ctx.rid, err: err.code || err.message });
    return new HttpError(503, 'video database unavailable');
  };

  const routes = [
    ['GET', /^\/api\/videos$/, async (ctx) => {
      await ctx.requireUser(ctx, VIEW_ROLES);
      const limit = clampInt(ctx.query.get('limit'), 1, 100, 24);
      const offset = clampInt(ctx.query.get('offset'), 0, 1_000_000, 0);
      let rows; let total;
      try {
        [rows, total] = await Promise.all([repo.list(limit, offset), repo.count()]);
      } catch (err) {
        throw dbError(ctx, err);
      }
      sendJSON(ctx.res, 200, { total, limit, offset, videos: rows.map(toDto) });
    }],

    ['GET', /^\/api\/videos\/(?<id>[^/]+)$/, async (ctx) => {
      await ctx.requireUser(ctx, VIEW_ROLES);
      const video = await lookup(ctx);
      sendJSON(ctx.res, 200, toDto(video));
    }],

    ['GET', /^\/api\/videos\/(?<id>[^/]+)\/stream$/, async (ctx) => {
      const { req, res, rid } = ctx;
      await ctx.requireUser(ctx, VIEW_ROLES);
      const video = await lookup(ctx);

      const range = req.headers.range;
      if (range && (range.length > 200 || !RANGE_RE.test(range))) throw new HttpError(416, 'invalid range');

      const upstream = await files.get(video.id, { range, ifRange: req.headers['if-range'], rid, method: req.method });
      if (upstream.statusCode === 404) {
        upstream.resume();
        log.error('metadata exists but file is missing', { rid, id: video.id });
        throw new HttpError(404, 'video file missing');
      }
      if (![200, 206, 304, 416].includes(upstream.statusCode)) {
        upstream.resume();
        log.error('file service error', { rid, id: video.id, status: upstream.statusCode });
        throw new HttpError(502, 'file storage error');
      }

      const headers = { 'Content-Type': video.content_type, 'Cache-Control': 'private, max-age=3600',
        'Content-Disposition': 'inline' };
      for (const h of PASS_HEADERS) if (upstream.headers[h]) headers[h] = upstream.headers[h];
      res.writeHead(upstream.statusCode, headers);

      // pipeline() propagates backpressure and tears down the upstream request
      // if the viewer closes the tab or seeks (browser aborts the old range).
      pipeline(upstream, res, (err) => {
        if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          log.warn('stream interrupted', { rid, id: video.id, err: err.code || err.message });
        }
      });
    }],
  ];

  async function lookup(ctx) {
    const { id } = ctx.params;
    if (!UUID_RE.test(id)) throw new HttpError(400, 'invalid video id');
    let video;
    try {
      video = await repo.get(id);
    } catch (err) {
      throw dbError(ctx, err);
    }
    if (!video) throw new HttpError(404, 'video not found');
    return video;
  }

  return createWebApp({
    service: 'streaming-web', log, auth, cookieSecure, routes,
    staticDir: [path.join(__dirname, '..', 'public'), path.join(__dirname, '..', '..', 'web-common', 'public')],
    readiness: async (rid) => ({
      mysql: await repo.ping().then(() => 'up', () => 'down'),
      auth: (await auth.ready(rid)) ? 'up' : 'down',
      file_service: (await files.ready(rid)) ? 'up' : 'down',
    }),
  });
}

function clampInt(v, min, max, def) {
  const n = Number.parseInt(v ?? '', 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function toDto(r) {
  return { id: r.id, title: r.title, description: r.description, contentType: r.content_type,
    size: Number(r.size_bytes), uploadedBy: r.uploaded_by, createdAt: r.created_at };
}

module.exports = { createStreamingApp };
