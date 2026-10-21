/**
 * Renderer-side account store — the browser-mode fallback for sign-in.
 *
 * In Electron, sign-in opens the default browser and a loopback server mints
 * the token (see electron/services/authFlow.js). When NovaCode is previewed
 * outside Electron there is no main process, so we mirror the same account
 * shape locally in localStorage: an email yields a per-account token and the
 * 1,000M-token starter budget. This keeps the "Sign in" affordance working in
 * the browser preview instead of dead-ending on the missing desktop bridge.
 */

const STORE_KEY = 'novacode-accounts';
const STARTING_QUOTA = 1_000_000_000; // 1000M tokens granted on sign-in.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function issueToken() {
  const bytes = new Uint8Array(24);
  (globalThis.crypto?.getRandomValues
    ? globalThis.crypto.getRandomValues(bytes)
    : bytes.forEach((_, i) => (bytes[i] = Math.floor(Math.random() * 256))));
  return `nova_${base64url(bytes)}`;
}

function readStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return {
      accounts: parsed && typeof parsed.accounts === 'object' ? parsed.accounts : {},
      currentEmail: typeof parsed?.currentEmail === 'string' ? parsed.currentEmail : null,
    };
  } catch {
    return { accounts: {}, currentEmail: null };
  }
}

function writeStore(store) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* storage unavailable — session stays in-memory only */
  }
}

function publicAccount(record) {
  if (!record) return null;
  return {
    email: record.email,
    name: record.name || record.email,
    token: record.token,
    plan: record.plan || 'Starter',
    tokensQuota: record.tokensQuota,
    tokensUsed: record.tokensUsed,
    tokensRemaining: Math.max(0, record.tokensQuota - record.tokensUsed),
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt || null,
  };
}

/** Sign in (or create) an account for an email and make it current. */
export function signInLocal({ email, name } = {}) {
  const clean = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(clean)) {
    throw new Error('Enter a valid email address to sign in.');
  }
  const store = readStore();
  let record = store.accounts[clean];
  if (!record) {
    const rawLocal = String(email).trim().split('@')[0] || clean.split('@')[0];
    record = {
      email: clean,
      name: String(name || '').trim().slice(0, 80) || rawLocal,
      token: issueToken(),
      plan: 'Starter',
      tokensQuota: STARTING_QUOTA,
      tokensUsed: 0,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    store.accounts[clean] = record;
  } else if (name) {
    record.name = String(name).trim().slice(0, 80) || record.name;
  }
  store.currentEmail = clean;
  writeStore(store);
  return publicAccount(record);
}

/** The currently signed-in account, or null. */
export function getAccountLocal() {
  const store = readStore();
  if (!store.currentEmail) return null;
  return publicAccount(store.accounts[store.currentEmail] || null);
}

/** Sign out of the current account (the record and token are kept). */
export function signOutLocal() {
  const store = readStore();
  store.currentEmail = null;
  writeStore(store);
  return { ok: true };
}
