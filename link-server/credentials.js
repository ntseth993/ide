'use strict';
/**
 * Password hashing and session tokens.
 *
 * Passwords: scrypt (memory-hard, in Node's own crypto — no npm dependency and
 * no native build on the deploy host). The stored form is self-describing
 * (`scrypt$N$r$p$salt$hash`) so parameters can be raised later without a
 * migration that invalidates every login, and verification of an old hash still
 * works.
 *
 * Sessions: the token handed to the client is 32 random bytes. The database
 * stores only SHA-256 of it. A stolen database dump therefore contains no usable
 * credential — an attacker would still have to guess a live token, and comparing
 * by hash is an exact indexed lookup rather than a scan.
 */
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 32, saltBytes: 16 };
// maxmem must cover 128 * N * r bytes (16 MB here) or scrypt throws on Node.
const SCRYPT_OPTS = { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(SCRYPT.saltBytes);
  const derived = crypto.scryptSync(String(password), salt, SCRYPT.keyLength, SCRYPT_OPTS);
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Verify a password against a stored hash. Returns false for a malformed hash
 * rather than throwing: a corrupted row must not turn into a 500 at login.
 */
function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltText, hashText] = parts;
  try {
    const salt = Buffer.from(saltText, 'base64');
    const expected = Buffer.from(hashText, 'base64');
    const derived = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * Number(n) * Number(r) * 2,
    });
    return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

function newId() {
  return crypto.randomUUID();
}

function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Does this password deserve to be stored at all?
 * Length is checked against server configuration; the rest are cheap checks that
 * stop the obviously-terrible cases without guessing the user's policy.
 */
function passwordProblem(password, minLength) {
  const value = String(password ?? '');
  if (value.length < minLength) return `Your password must be at least ${minLength} characters.`;
  if (value.length > 200) return 'Your password must be 200 characters or fewer.';
  if (/^(.)\1+$/.test(value)) return 'Your password cannot be one repeated character.';
  if (/^(password|passw0rd|qwerty|letmein|admin|123456)/i.test(value)) return 'That password is on every attacker list; choose another.';
  return null;
}

module.exports = {
  SCRYPT,
  hashPassword,
  verifyPassword,
  newId,
  newSessionToken,
  hashToken,
  passwordProblem,
};
