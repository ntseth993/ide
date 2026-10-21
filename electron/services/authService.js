/**
 * Local account & token service.
 *
 * NovaCode is a desktop app with no cloud backend, so "sign in" here is a
 * self-contained, offline account: entering an email mints a per-account API
 * token and a starting token budget (1,000,000,000 tokens) that the IDE meters
 * locally as AI requests are made. The account is the gate for usage; the
 * actual model calls still go to whichever provider the user connects.
 *
 * Accounts persist as JSON in userData. The token is a random, opaque string —
 * it is a local identifier/budget handle, NOT a credential that authenticates
 * against a remote service.
 */
const fsp = require('fs').promises;
const crypto = require('crypto');

const STARTING_QUOTA = 1_000_000_000; // 1000M tokens granted on sign-in.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function issueToken() {
  return `nova_${crypto.randomBytes(24).toString('base64url')}`;
}

function publicAccount(record) {
  if (!record) return null;
  return {
    email: record.email,
    name: record.name || record.email,
    token: record.token,
    provider: record.provider || 'email',
    avatar: record.avatar || null,
    plan: record.plan || 'Starter',
    tokensQuota: record.tokensQuota,
    tokensUsed: record.tokensUsed,
    tokensRemaining: Math.max(0, record.tokensQuota - record.tokensUsed),
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt || null,
  };
}

function createAuthService({ filePath, logger, startingQuota = STARTING_QUOTA }) {
  let cache = null;

  async function readAll() {
    if (cache) return cache;
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      cache = {
        version: 1,
        accounts: parsed && typeof parsed.accounts === 'object' ? parsed.accounts : {},
        currentEmail: typeof parsed?.currentEmail === 'string' ? parsed.currentEmail : null,
      };
    } catch {
      cache = { version: 1, accounts: {}, currentEmail: null };
    }
    return cache;
  }

  async function writeAll() {
    await fsp.writeFile(filePath, JSON.stringify(cache, null, 2), 'utf8');
  }

  /** Sign in (or create) an account for an email and make it current. */
  async function signIn({ email, name, provider, avatar } = {}) {
    const clean = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(clean)) {
      throw new Error('Enter a valid email address to sign in.');
    }
    const store = await readAll();
    let record = store.accounts[clean];
    if (!record) {
      const rawLocal = String(email).trim().split('@')[0] || clean.split('@')[0];
      record = {
        email: clean,
        name: String(name || '').trim().slice(0, 80) || rawLocal,
        token: issueToken(),
        provider: String(provider || 'email').slice(0, 40) || 'email',
        avatar: avatar ? String(avatar).slice(0, 500) : null,
        plan: 'Starter',
        tokensQuota: startingQuota,
        tokensUsed: 0,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      };
      store.accounts[clean] = record;
      logger?.info?.('account created', { email: clean, provider: record.provider });
    } else {
      if (name) record.name = String(name).trim().slice(0, 80) || record.name;
      if (provider) record.provider = String(provider).slice(0, 40) || record.provider;
      if (avatar) record.avatar = String(avatar).slice(0, 500);
    }
    store.currentEmail = clean;
    await writeAll();
    return publicAccount(record);
  }

  /** The currently signed-in account, or null. */
  async function getAccount() {
    const store = await readAll();
    if (!store.currentEmail) return null;
    return publicAccount(store.accounts[store.currentEmail] || null);
  }

  /**
   * Previously-used emails for the browser "choose an account" screen.
   * Returns only display-safe fields (no tokens), most-recently-used first.
   */
  async function listAccounts() {
    const store = await readAll();
    return Object.values(store.accounts)
      .map((record) => ({ email: record.email, name: record.name || record.email }))
      .sort((a, b) => {
        const ra = store.accounts[a.email];
        const rb = store.accounts[b.email];
        const ta = new Date(ra.lastUsedAt || ra.createdAt || 0).getTime();
        const tb = new Date(rb.lastUsedAt || rb.createdAt || 0).getTime();
        return tb - ta;
      });
  }

  /** Sign out of the current account (the record and token are kept). */
  async function signOut() {
    const store = await readAll();
    store.currentEmail = null;
    await writeAll();
    return { ok: true };
  }

  /**
   * Charge `tokens` against the current account's budget.
   * @returns {Promise<{ ok: boolean, remaining?: number, account?: object, error?: string }>}
   */
  async function consume({ tokens } = {}) {
    const amount = Math.max(0, Math.round(Number(tokens) || 0));
    const store = await readAll();
    const record = store.currentEmail ? store.accounts[store.currentEmail] : null;
    if (!record) return { ok: false, error: 'You are signed out. Sign in to use the assistant.' };
    if (amount === 0) return { ok: true, remaining: record.tokensQuota - record.tokensUsed, account: publicAccount(record) };
    if (record.tokensUsed + amount > record.tokensQuota) {
      return { ok: false, error: 'Token budget exhausted for this account.', account: publicAccount(record) };
    }
    record.tokensUsed += amount;
    record.lastUsedAt = new Date().toISOString();
    await writeAll();
    return { ok: true, remaining: record.tokensQuota - record.tokensUsed, account: publicAccount(record) };
  }

  /** Cheap pre-flight check used before starting a run. */
  async function hasQuota() {
    const store = await readAll();
    const record = store.currentEmail ? store.accounts[store.currentEmail] : null;
    if (!record) return { ok: false, error: 'You are signed out. Sign in to use the assistant.' };
    if (record.tokensUsed >= record.tokensQuota) {
      return { ok: false, error: 'Token budget exhausted for this account.' };
    }
    return { ok: true };
  }

  return { signIn, getAccount, listAccounts, signOut, consume, hasQuota, STARTING_QUOTA };
}

module.exports = { createAuthService, issueToken, STARTING_QUOTA };
