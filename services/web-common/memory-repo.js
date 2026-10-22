'use strict';

/** In-memory repository with the same interface; used by tests and the local harness. */
function memoryVideoRepo(shared = []) {
  const rows = shared;
  let down = false;
  const check = () => {
    if (down) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  };
  return {
    rows,
    setDown(v) { down = v; },
    async insert(v) {
      check();
      rows.push({ id: v.id, title: v.title, description: v.description, content_type: v.contentType,
        size_bytes: v.size, sha256: v.sha256, uploaded_by: v.uploadedBy, created_at: new Date() });
    },
    async listByUploader(username, limit = 50) {
      check();
      return rows.filter((r) => r.uploaded_by === username).slice(-limit).reverse();
    },
    async list(limit = 50, offset = 0) {
      check();
      return [...rows].reverse().slice(offset, offset + limit);
    },
    async get(id) {
      check();
      return rows.find((r) => r.id === id) || null;
    },
    async count() {
      check();
      return rows.length;
    },
    async remove(id) {
      check();
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
    },
    async ping() { check(); },
  };
}

module.exports = { memoryVideoRepo };
