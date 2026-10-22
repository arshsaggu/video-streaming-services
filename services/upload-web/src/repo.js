'use strict';

/** Video metadata repository (MySQL, `media.videos`). Uses the least-privilege `upload_svc` account. */
function mysqlVideoRepo(pool) {
  return {
    async insert(v) {
      await pool.execute(
        'INSERT INTO videos (id, title, description, content_type, size_bytes, sha256, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [v.id, v.title, v.description, v.contentType, v.size, v.sha256, v.uploadedBy],
      );
    },
    async listByUploader(username, limit = 50) {
      const [rows] = await pool.query(
        'SELECT id, title, description, content_type, size_bytes, uploaded_by, created_at FROM videos WHERE uploaded_by = ? ORDER BY created_at DESC LIMIT ?',
        [username, limit],
      );
      return rows;
    },
    async remove(id) {
      await pool.execute('DELETE FROM videos WHERE id = ?', [id]);
    },
    async ping() {
      await pool.query('SELECT 1');
    },
  };
}

module.exports = { mysqlVideoRepo };
