'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { createWebApp } = require('../../web-common/web-app');
const { HttpError, sendJSON, readJSON, requireSameOriginHeader } = require('../../web-common/http-utils');
const { validateUploadMeta, magicByteGuard } = require('./validate');

const UPLOAD_ROLES = ['uploader', 'admin'];

/**
 * Upload Video web app.
 *   POST /api/videos   raw video body; metadata in X-Video-Title / X-Video-Description headers
 *   GET  /api/videos   the current user's uploads
 *
 * Flow: auth check -> validate metadata -> stream body through a magic-byte
 * check straight to the File System Service (never buffered in memory or on
 * this container's disk) -> store metadata in MySQL. If the MySQL write fails
 * the stored file is deleted again (compensating action) so storage and
 * metadata never disagree.
 */
function createUploadApp({ log, auth, files, repo, maxBytes, cookieSecure }) {
  const routes = [
    // Admin: create accounts with a chosen role (e.g. promote a teammate to uploader).
    ['POST', /^\/api\/admin\/users$/, async (ctx) => {
      requireSameOriginHeader(ctx.req);
      await ctx.requireUser(ctx, ['admin']);
      const body = await readJSON(ctx.req);
      const created = await auth.createUser(ctx.token(), body, ctx.rid);
      log.info('admin created user', { rid: ctx.rid, user: created.username, role: created.role, by: ctx.user.username });
      sendJSON(ctx.res, 201, created);
    }],

    ['GET', /^\/api\/videos$/, async (ctx) => {
      const user = await ctx.requireUser(ctx, UPLOAD_ROLES);
      let rows;
      try {
        rows = await repo.listByUploader(user.username, 50);
      } catch (err) {
        log.error('database error', { rid: ctx.rid, err: err.code || err.message });
        throw new HttpError(503, 'video database unavailable');
      }
      sendJSON(ctx.res, 200, { videos: rows.map(toDto) });
    }],

    ['POST', /^\/api\/videos$/, async (ctx) => {
      const { req, res, rid } = ctx;
      requireSameOriginHeader(req);
      const user = await ctx.requireUser(ctx, UPLOAD_ROLES);
      const meta = validateUploadMeta(req.headers, maxBytes);
      const id = crypto.randomUUID();

      const guarded = req.pipe(magicByteGuard(meta.contentType));
      req.on('error', (e) => guarded.destroy(e));
      req.on('aborted', () => guarded.destroy(new HttpError(400, 'client aborted upload')));

      const t0 = Date.now();
      const stored = await files.put(id, guarded, { contentLength: meta.contentLength, rid });
      if (stored.size !== meta.contentLength) {
        await files.remove(id, rid);
        throw new HttpError(400, 'upload incomplete');
      }

      try {
        await repo.insert({ id, title: meta.title, description: meta.description, contentType: meta.contentType,
          size: stored.size, sha256: stored.sha256, uploadedBy: user.username });
      } catch (err) {
        log.error('metadata insert failed; removing stored file', { rid, id, err: err.code || err.message });
        await files.remove(id, rid);
        throw new HttpError(503, 'video database unavailable, upload rolled back');
      }

      log.info('video uploaded', { rid, id, user: user.username, bytes: stored.size, ms: Date.now() - t0 });
      sendJSON(res, 201, { id, title: meta.title, size: stored.size, sha256: stored.sha256 });
    }],
  ];

  return createWebApp({
    service: 'upload-web', log, auth, cookieSecure, routes,
    staticDir: [path.join(__dirname, '..', 'public'), path.join(__dirname, '..', '..', 'web-common', 'public')],
    readiness: async (rid) => ({
      mysql: await repo.ping().then(() => 'up', () => 'down'),
      auth: (await auth.ready(rid)) ? 'up' : 'down',
      file_service: (await files.ready(rid)) ? 'up' : 'down',
    }),
  });
}

function toDto(r) {
  return { id: r.id, title: r.title, description: r.description, contentType: r.content_type,
    size: Number(r.size_bytes), uploadedBy: r.uploaded_by, createdAt: r.created_at };
}

module.exports = { createUploadApp };
