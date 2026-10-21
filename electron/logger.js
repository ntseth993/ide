/**
 * Structured logger for the Electron main process.
 *
 * Writes one JSON object per line to a daily file inside the user data
 * directory and mirrors to the console. Secret-looking values are redacted
 * before anything is written. Kept Electron-free (call init() with a
 * directory) so services can be exercised in unit tests.
 */
const fs = require('fs');
const path = require('path');

let logFilePath = null;

const SECRET_PATTERN = /(api[_-]?key|authorization|password|token|secret)(["']?\s*[:=]\s*)(["']?)[^"',\s}]+/gi;

function redact(value) {
  if (typeof value !== 'string') return value;
  return value.replace(SECRET_PATTERN, (_match, key, separator, quote) => `${key}${separator}${quote}[redacted]`);
}

function init(userDataDir) {
  try {
    const dir = path.join(userDataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    logFilePath = path.join(dir, `novacode-${stamp}.log`);
  } catch (error) {
    logFilePath = null;
    console.warn('[novacode] logger disabled:', error.message);
  }
}

function write(level, message, meta) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message: redact(String(message)),
  };
  if (meta !== undefined) {
    entry.meta = redact(JSON.stringify(meta));
  }
  const line = JSON.stringify(entry);
  if (logFilePath) {
    try {
      fs.appendFileSync(logFilePath, `${line}\n`);
    } catch {
      /* logging must never crash the app */
    }
  }
  const scope = '[novacode]';
  if (level === 'error') console.error(scope, line);
  else if (level === 'warn') console.warn(scope, line);
  else console.log(scope, line);
}

module.exports = {
  init,
  redact,
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
};
