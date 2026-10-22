'use strict';

/**
 * One-line JSON logs on stdout (collected by `docker compose logs`).
 * Keys that could carry secrets are redacted defensively, even though callers
 * should never pass them.
 */
const REDACT = /pass(word)?|token|secret|authorization|cookie/i;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(service, level = process.env.LOG_LEVEL || 'info') {
  const min = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  const emit = (lvl, msg, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    const entry = { ts: new Date().toISOString(), level: lvl, service, msg };
    for (const [k, v] of Object.entries(fields)) {
      entry[k] = REDACT.test(k) ? '[redacted]' : v instanceof Error ? v.message : v;
    }
    process.stdout.write(JSON.stringify(entry) + '\n');
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

module.exports = { createLogger };
