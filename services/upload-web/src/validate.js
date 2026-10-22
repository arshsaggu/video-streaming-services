'use strict';
const { Transform } = require('node:stream');
const { HttpError } = require('../../web-common/http-utils');

const ALLOWED_TYPES = {
  'video/mp4': (b) => isoBmff(b),
  'video/quicktime': (b) => isoBmff(b),
  'video/webm': (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
  'video/ogg': (b) => b.toString('latin1', 0, 4) === 'OggS',
};

function isoBmff(b) {
  const box = b.toString('latin1', 4, 8);
  return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(box);
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function decodeHeader(v) {
  if (v === undefined) return '';
  try {
    return decodeURIComponent(String(v));
  } catch {
    throw new HttpError(422, 'metadata headers must be URI-encoded');
  }
}

/** Validates the upload request's metadata (sent as headers so the body can be the raw video stream). */
function validateUploadMeta(headers, maxBytes) {
  const fields = [];
  const contentType = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_TYPES[contentType]) fields.push('content-type');

  const len = Number(headers['content-length']);
  if (!Number.isInteger(len) || len <= 0) fields.push('content-length');
  else if (len > maxBytes) throw new HttpError(413, `file too large (max ${Math.floor(maxBytes / 1048576)} MB)`);

  const title = decodeHeader(headers['x-video-title']).trim();
  if (title.length < 1 || title.length > 120 || CONTROL_CHARS.test(title)) fields.push('title');

  const description = decodeHeader(headers['x-video-description']).trim();
  if (description.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description)) fields.push('description');

  if (fields.length) throw new HttpError(422, 'invalid upload', { fields });
  return { contentType, contentLength: len, title, description };
}

/**
 * Pass-through stream that checks the file's magic bytes against the declared
 * MIME type before letting any data through - a renamed .exe labelled
 * "video/mp4" is rejected after the first few bytes.
 */
function magicByteGuard(contentType) {
  const check = ALLOWED_TYPES[contentType];
  let head = Buffer.alloc(0);
  let verified = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (verified) return cb(null, chunk);
      head = Buffer.concat([head, chunk]);
      if (head.length < 12) return cb();
      if (!check(head)) return cb(new HttpError(415, `file content is not a valid ${contentType}`));
      verified = true;
      const out = head;
      head = null;
      cb(null, out);
    },
    flush(cb) {
      if (!verified) return cb(new HttpError(415, 'file too small to be a video'));
      cb();
    },
  });
}

module.exports = { validateUploadMeta, magicByteGuard, ALLOWED_TYPES };
