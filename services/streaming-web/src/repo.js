'use strict';

/** Read-only video metadata repository. Uses the `stream_svc` account, which only has SELECT. */
function mysqlVideoRepo(pool) {
  const cols = 'id, title, description, content_type, size_bytes, uploaded_by, created_at';
  return {
    async list(limit = 50, offset = 0) {
      const [rows] = await pool.query(`SELECT ${cols} FROM videos ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
        [limit, offset]);
      return rows;
    },
    async count() {
      const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM videos');
      return Number(row.n);
    },
    async get(id) {
      const [rows] = await pool.execute(`SELECT ${cols} FROM videos WHERE id = ?`, [id]);
      return rows[0] || null;
    },
    async ping() {
      await pool.query('SELECT 1');
    },
  };
}

module.exports = { mysqlVideoRepo };
