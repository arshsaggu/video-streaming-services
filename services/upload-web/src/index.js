'use strict';
const http = require('node:http');
const { readSecret, env, intEnv, boolEnv } = require('../../web-common/config');
const { createLogger } = require('../../web-common/logger');
const { createAuthClient } = require('../../web-common/auth-client');
const { createFileClient } = require('../../web-common/file-client');
const { createPool } = require('../../web-common/mysql');
const { mysqlVideoRepo } = require('./repo');
const { createUploadApp } = require('./app');

const log = createLogger('upload-web');

function main() {
  // Performance improvement #2: reuse TCP connections to internal services.
  const keepAlive = boolEnv('HTTP_KEEPALIVE', true);
  const agent = new http.Agent({ keepAlive, maxSockets: 64, keepAliveMsecs: 10000 });

  // Loaded here (not in web-common) so Node finds it in this app's node_modules.
  const pool = createPool(require('mysql2/promise'), {
    host: env('DB_HOST', 'mysql'), port: intEnv('DB_PORT', 3306), user: env('DB_USER', 'upload_svc'),
    password: readSecret('DB_PASSWORD'), database: env('DB_NAME', 'media'), connectionLimit: intEnv('DB_POOL', 10),
  });

  const app = createUploadApp({
    log,
    auth: createAuthClient({ baseUrl: env('AUTH_URL', 'http://auth-service:8000'), agent,
      cacheTtlMs: intEnv('AUTH_CACHE_TTL_MS', 30000), log }),
    files: createFileClient({ baseUrl: env('FILE_SERVICE_URL', 'http://file-service:8080'),
      token: readSecret('INTERNAL_TOKEN', { minLength: 32 }), agent, log }),
    repo: mysqlVideoRepo(pool),
    maxBytes: intEnv('MAX_UPLOAD_MB', 500) * 1024 * 1024,
    cookieSecure: boolEnv('COOKIE_SECURE', false),
  });

  const server = http.createServer(app);
  server.requestTimeout = 0;          // large uploads may take minutes
  server.headersTimeout = 15000;      // ...but slow-loris style header trickling is cut off
  server.keepAliveTimeout = 65000;
  const port = intEnv('PORT', 3000);
  server.listen(port, () => log.info('listening', { port, keepAlive }));

  const shutdown = (sig) => {
    log.info('shutting down', { signal: sig });
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

try {
  main();
} catch (err) {
  log.error('startup failed', { err: err.message });
  process.exit(1);
}
