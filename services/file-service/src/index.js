'use strict';
const fs = require('node:fs');
const { createFileServer } = require('./server');

// Same one-line JSON format as the other services.
function log(level, msg, fields = {}) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, service: 'file-service', msg, ...fields }) + '\n');
}
const logger = { info: (m, f) => log('info', m, f), warn: (m, f) => log('warn', m, f), error: (m, f) => log('error', m, f) };

function readSecret(name) {
  const file = process.env[`${name}_FILE`];
  return (file ? fs.readFileSync(file, 'utf8') : process.env[name] || '').trim();
}

function main() {
  const internalToken = readSecret('INTERNAL_TOKEN');
  if (internalToken.length < 32) throw new Error('INTERNAL_TOKEN(_FILE) must be set and at least 32 characters');
  const maxMb = Number.parseInt(process.env.MAX_FILE_MB || '500', 10);
  if (!(maxMb > 0)) throw new Error('MAX_FILE_MB must be a positive integer');
  const readBufferKb = Number.parseInt(process.env.READ_BUFFER_KB || '1024', 10);
  const storageDir = process.env.STORAGE_DIR || '/data/videos';
  const port = Number.parseInt(process.env.PORT || '8080', 10);

  const server = createFileServer({
    storageDir, internalToken, maxBytes: maxMb * 1024 * 1024, readBufferBytes: readBufferKb * 1024, log: logger,
  });
  server.listen(port, process.env.HOST || '0.0.0.0', () =>
    logger.info('listening', { port, storage: storageDir, max_mb: maxMb, read_buffer_kb: readBufferKb }));

  const shutdown = (signal) => {
    logger.info('shutting down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

try {
  main();
} catch (err) {
  logger.error('startup failed', { err: err.message });
  process.exit(1);
}
