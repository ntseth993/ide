'use strict';
/**
 * Level filter for the server log.
 *
 * The rule this file exists to enforce: a NovaLink Live log may contain ids,
 * counts, statuses and route names. It must never contain message bodies,
 * uploaded file contents, passwords, session tokens or ICE credentials, because
 * logs get shipped to aggregators and read by people who are not the message
 * recipients.
 */
const LEVELS = { none: 0, error: 1, warn: 2, info: 3, debug: 4 };

// Keys whose values must never be printed, whatever the caller passed.
const REDACTED_KEYS = /^(password|passwordhash|token|sessiontoken|authorization|cookie|credential|turncredential|secret|code|avatar|body|text|content|snippet|evidence)$/i;

function createLogger(level = 'info', sink = null) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = sink || ((line) => process.stdout.write(line));

  function clean(meta) {
    if (meta === null || typeof meta !== 'object') return meta;
    if (Array.isArray(meta)) return meta.map(clean);
    const out = {};
    for (const [key, value] of Object.entries(meta)) {
      if (REDACTED_KEYS.test(key)) out[key] = '[redacted]';
      else if (value instanceof Date) out[key] = value.toISOString();
      else if (typeof value === 'object') out[key] = clean(value);
      else out[key] = value;
    }
    return out;
  }

  function emit(name, severity, message, meta) {
    if (threshold < severity) return;
    const parts = [`[${new Date().toISOString()}]`, name.toUpperCase(), message];
    if (meta && Object.keys(meta).length) parts.push(JSON.stringify(clean(meta)));
    try {
      write(`${parts.join(' ')}\n`);
    } catch { /* a broken log must not take the server down */ }
  }

  const make = (name, severity) => (message, meta) => emit(name, severity, message, meta);
  return {
    level,
    error: make('error', LEVELS.error),
    warn: make('warn', LEVELS.warn),
    info: make('info', LEVELS.info),
    debug: make('debug', LEVELS.debug),
    child() { return this; },
  };
}

module.exports = { createLogger, LEVELS, REDACTED_KEYS };
