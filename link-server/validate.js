'use strict';
/**
 * Input validation and the error type every layer throws.
 *
 * Two rules make this file worth having instead of scattering regexes:
 *
 *  1. Nothing from a client is used before it has been through here. The
 *     renderer's user id is never trusted (the session token identifies the
 *     caller), and every string arrives clipped to a documented length so a
 *     hostile client cannot make the server store a 40 MB "display name".
 *  2. An ApiError carries a message that is safe to show a developer. Never
 *     interpolate a driver message, a file path, a token or an upstream body
 *     into it — those go to the log, which is not shown to peers.
 */

class ApiError extends Error {
  /**
   * @param {number} status  HTTP status
   * @param {string} code    stable machine-readable code (the client branches on this)
   * @param {string} message developer-safe text
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    // The code is what a client branches on, so it is normalised rather than
    // trusted: the field labels that build codes are written for humans, and
    // "invalid_call mode" is a machine key with a space in it.
    this.code = String(code || 'unknown').trim().replace(/[\s-]+/g, '_').toLowerCase();
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, status: this.status } };
  }
}

const bad = (code, message) => new ApiError(400, code, message);
const forbidden = (code, message) => new ApiError(403, code, message);
const notFound = (code, message) => new ApiError(404, code, message);

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

// A handle must start and end with a letter or digit. `alice_`, `alice.` and
// `alice-` are easy to misread as the same person while the NOCASE index treats
// them as three accounts, which is the shape an impersonation report needs.
const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{0,28}[a-z0-9]$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMOJI_RE = /^\p{Extended_Pictographic}(\uFE0F)?(\u200D\p{Extended_Pictographic}(\uFE0F)?)*$/u;
const LANGUAGE_RE = /^[a-z][a-z0-9+#.-]{0,31}$/i;

/** Usernames are compared case-insensitively, so they are stored lowercased. */
function username(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!USERNAME_RE.test(raw)) {
    throw bad('invalid_username', 'Usernames must be 2-30 characters, start and end with a letter or digit, and use only . _ - in between.');
  }
  return raw;
}

/**
 * A required or optional string field.
 * Control characters and the Unicode bidirectional overrides are removed: an
 * invisible U+202E inside a display name is a spoofing bug, not typography.
 */
function text(value, { field, max, required = true } = {}) {
  const raw = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  // The control characters here are the point, not an accident: this line exists
  // to take them out of text that came from a client.
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2060-\u2064]/g, '');
  if (!cleaned.trim()) {
    if (required) throw bad(`missing_${field || 'field'}`, `${field || 'This field'} is required.`);
    return '';
  }
  if (max && cleaned.length > max) {
    throw bad(`too_long_${field || 'field'}`, `${field || 'This field'} must be ${max} characters or fewer.`);
  }
  return cleaned;
}

function requiredId(value, field = 'id') {
  const raw = String(value ?? '').trim();
  if (!ID_RE.test(raw)) throw bad(`invalid_${field}`, `${field} must be a uuid.`);
  return raw;
}

function optionalId(value, field = 'id') {
  if (value === undefined || value === null || value === '') return null;
  return requiredId(value, field);
}

function emoji(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 32 || !EMOJI_RE.test(raw)) {
    throw bad('invalid_emoji', 'A reaction must be a single emoji.');
  }
  return raw;
}

function optionalLanguage(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim().toLowerCase();
  if (!LANGUAGE_RE.test(raw)) throw bad('invalid_language', 'Code language ids must look like "js", "python", "typescript".');
  return raw;
}

function status(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!['online', 'away', 'busy', 'offline'].includes(raw)) {
    throw bad('invalid_status', 'Status must be online, away, busy or offline.');
  }
  return raw;
}

function choice(value, allowed, field) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!allowed.includes(raw)) {
    throw bad(`invalid_${field}`, `${field} must be one of: ${allowed.join(', ')}.`);
  }
  return raw;
}

function boolean(value, field) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  throw bad(`invalid_${field}`, `${field} must be true or false.`);
}

function integer(value, { field, min, max, fallback }) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw bad(`missing_${field}`, `${field} is required.`);
  }
  const n = Number(value);
  if (!Number.isInteger(n)) throw bad(`invalid_${field}`, `${field} must be a whole number.`);
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

/**
 * A filename as it will be DISPLAYED. Never used to build a path — storage uses
 * a generated uuid, so a name like `../../.ssh/id_rsa` or `powershell.exe`
 * cannot escape the store or imply executability. It is still cleaned because
 * the name is rendered in the recipient's UI and offered as a save default.
 */
function displayNameForFile(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw bad('missing_file_name', 'A file name is required.');
  // Strip any directory component a client tried to smuggle in, then control
  // characters and Windows-reserved names.
  // eslint-disable-next-line no-control-regex
  const base = raw.split(/[\\/]/).pop().replace(/[\u0000-\u001F<>:"|?*]/g, '').trim();
  const clipped = base.slice(0, 180);
  if (!clipped) throw bad('invalid_file_name', 'The file name is not usable.');
  const stem = clipped.split('.')[0]?.toUpperCase();
  if (['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'LPT1', 'LPT2', 'LPT3'].includes(stem)) {
    return `_${clipped}`;
  }
  return clipped;
}

module.exports = {
  ApiError,
  bad,
  forbidden,
  notFound,
  USERNAME_RE,
  ID_RE,
  username,
  text,
  requiredId,
  optionalId,
  emoji,
  optionalLanguage,
  status,
  choice,
  boolean,
  integer,
  displayNameForFile,
};
