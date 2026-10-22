'use strict';

/**
 * mysql2 connection pool. The driver is passed in by the app, whose own
 * node_modules holds it: Node resolves require() relative to the *calling file*,
 * and this shared file lives in /app/web-common, outside the app's node_modules.
 * The pool reconnects on demand, so the apps recover by themselves when
 * MySQL comes back after an outage.
 */
function createPool(mysql, { host, port, user, password, database, connectionLimit = 10 }) {
  return mysql.createPool({
    host, port, user, password, database,
    connectionLimit,
    waitForConnections: true,
    queueLimit: 100,
    connectTimeout: 3000,
    enableKeepAlive: true,
    dateStrings: false,
  });
}

module.exports = { createPool };
