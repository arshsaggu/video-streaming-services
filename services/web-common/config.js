'use strict';
const fs = require('node:fs');

/** Read a secret from <NAME>_FILE (Docker secret). Plain <NAME> is accepted only for local tests. */
function readSecret(name, { required = true, minLength = 1 } = {}) {
  const file = process.env[`${name}_FILE`];
  let value = file ? fs.readFileSync(file, 'utf8').trim() : process.env[name];
  if (required && (!value || value.length < minLength)) {
    throw new Error(`${name}(_FILE) must be set (min length ${minLength})`);
  }
  return value;
}

function env(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

function intEnv(name, def) {
  const n = Number.parseInt(env(name, String(def)), 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function boolEnv(name, def) {
  return String(env(name, String(def))).toLowerCase() === 'true';
}

module.exports = { readSecret, env, intEnv, boolEnv };
