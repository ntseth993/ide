'use strict';
/**
 * Accounts: registration, login, sessions, profiles, privacy settings.
 *
 * The identity rule for the whole server lives in `resolve()`: a request is
 * attributed to whoever its SESSION TOKEN belongs to, never to a user id in the
 * request body. Every other module takes a user id that came from here.
 */
const {
  ApiError, username: validUsername, text, optionalId, choice, boolean: validBoolean, integer,
} = require('./validate');
const {
  hashPassword, verifyPassword, newId, newSessionToken, hashToken, passwordProblem,
} = require('./credentials');

const PRESENCE_VISIBLE = ['contacts', 'everyone', 'nobody'];
const REQUESTS_ALLOWED_FROM = ['everyone', 'nobody'];

const DEFAULT_PRIVACY = {
  presence_visible_to: 'contacts',
  contact_requests_from: 'everyone',
  appear_offline: 0,
  show_last_active: 1,
  read_receipts_enabled: 1,
  calls_enabled: 1,
  attachments_enabled: 1,
};

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio || '',
    avatarId: row.avatar_id || null,
    createdAt: Number(row.created_at_ms),
    lastActiveAt: Number(row.last_active_ms) || null,
  };
}

function rowToPrivacy(row) {
  const source = { ...DEFAULT_PRIVACY, ...(row || {}) };
  return {
    presenceVisibleTo: source.presence_visible_to,
    contactRequestsFrom: source.contact_requests_from,
    appearOffline: Boolean(source.appear_offline),
    showLastActive: Boolean(source.show_last_active),
    readReceiptsEnabled: Boolean(source.read_receipts_enabled),
    callsEnabled: Boolean(source.calls_enabled),
    attachmentsEnabled: Boolean(source.attachments_enabled),
  };
}

function createAccounts({ store, config, logger, limiter, now = Date.now }) {
  const USER_COLUMNS = 'id, username, display_name, bio, avatar_id, created_at_ms, last_active_ms, deleted_at_ms';

  function findUserById(id) {
    return store.get(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? AND deleted_at_ms IS NULL`, id);
  }

  function privacyRow(userId) {
    return store.get('SELECT * FROM user_privacy WHERE user_id = ?', userId);
  }

  function ensurePrivacyRow(userId) {
    store.run(`INSERT INTO user_privacy (user_id, presence_visible_to, contact_requests_from, appear_offline,
                show_last_active, read_receipts_enabled, calls_enabled, attachments_enabled, updated_at_ms)
               VALUES (?, 'contacts', 'everyone', 0, 1, 1, 1, 1, ?)
               ON CONFLICT(user_id) DO NOTHING`, userId, now());
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  function register({ username, password, displayName, bio, inviteCode, deviceLabel } = {}, { ip } = {}) {
    if (!config.registrationOpen) {
      if (!config.inviteCode) throw new ApiError(503, 'registration_closed', 'This NovaLink Live server is not accepting new accounts.');
      if (String(inviteCode || '') !== config.inviteCode) {
        throw new ApiError(403, 'invite_required', 'This server requires an invite code to create an account.');
      }
    }
    const handle = validUsername(username);
    // A display name is optional: falling back to the handle has to be possible,
    // so the field is read as optional here rather than throwing first.
    const name = text(displayName, { field: 'display name', max: 80, required: false }) || handle;
    const intro = text(bio, { field: 'bio', max: 280, required: false });
    const problem = passwordProblem(password, config.passwordMinLength);
    if (problem) throw new ApiError(400, 'weak_password', problem);

    const taken = store.get('SELECT id FROM users WHERE username = ?', handle);
    if (taken) throw new ApiError(409, 'username_taken', 'That username is already registered.');

    const id = newId();
    const timestamp = now();
    store.transaction(() => {
      store.run(`INSERT INTO users (id, username, display_name, bio, password_hash, created_at_ms, last_active_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id, handle, name, intro, hashPassword(password), timestamp, timestamp);
      store.run(`INSERT INTO user_privacy (user_id, presence_visible_to, contact_requests_from, appear_offline,
                    show_last_active, read_receipts_enabled, calls_enabled, attachments_enabled, updated_at_ms)
                 VALUES (?, 'contacts', 'everyone', 0, 1, 1, 1, 1, ?)`, id, timestamp);
    });

    logger.info?.('account registered', { userId: id, username: handle, ip: ip || '' });
    return { user: rowToUser(store.get(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, id)), ...startSession(id, deviceLabel) };
  }

  // ---------------------------------------------------------------------------
  // Login / sessions
  // ---------------------------------------------------------------------------

  function startSession(userId, deviceLabel) {
    const token = newSessionToken();
    const id = newId();
    const timestamp = now();
    store.run(`INSERT INTO sessions (id, user_id, token_hash, device_label, created_at_ms, last_seen_ms, expires_at_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, userId, hashToken(token), text(deviceLabel, { field: 'device label', max: 60, required: false }),
      timestamp, timestamp, timestamp + config.sessionTtlMs);
    return { token, sessionId: id };
  }

  function login({ username, password, deviceLabel } = {}, { ip } = {}) {
    const handle = validUsername(username);
    const bucketKey = `${ip || 'unknown'}|${handle}`;
    const locked = limiter.lockedFor(bucketKey);
    if (locked) {
      throw new ApiError(429, 'account_locked', `Too many failed sign-ins. Try again in ${Math.ceil(locked / 1000)}s.`);
    }
    if (!limiter.take('auth', bucketKey).allowed) {
      throw new ApiError(429, 'rate_limited', 'Too many sign-in attempts. Slow down.');
    }

    const row = store.get(`SELECT id, password_hash FROM users WHERE username = ? AND deleted_at_ms IS NULL`, handle);
    // Verify something even when the username is unknown, so a missing row is not
    // measurably faster than a wrong password.
    const ok = row ? verifyPassword(password, row.password_hash) : verifyPassword(password, hashPassword('not-the-stored-value'));
    if (!row || !ok) {
      const stillLocked = limiter.recordFailure(bucketKey, {
        limit: config.rateLimits.authFailLimit,
        windowMs: config.rateLimits.authFailWindowMs,
      });
      logger.warn?.('sign-in failed', { username: handle, ip: ip || '', locked: stillLocked > 0 });
      throw new ApiError(401, 'invalid_credentials', 'That username or password is wrong.');
    }
    limiter.clearFailures(bucketKey);
    ensurePrivacyRow(row.id);
    const session = startSession(row.id, deviceLabel);
    touch(row.id);
    logger.info?.('signed in', { userId: row.id, sessionId: session.sessionId });
    return { user: rowToUser(findUserById(row.id)), ...session };
  }

  /** @returns {{user: object, session: object} | null} */
  function resolve(token) {
    const value = String(token || '');
    if (value.length < 16) return null;
    const session = store.get(
      `SELECT s.id, s.user_id, s.device_label, s.expires_at_ms, s.revoked_at_ms, s.last_seen_ms
         FROM sessions s WHERE s.token_hash = ?`,
      hashToken(value),
    );
    if (!session || session.revoked_at_ms) return null;
    if (Number(session.expires_at_ms) < now()) return null;
    const user = findUserById(session.user_id);
    if (!user) return null;
    // Write amplification guard: a heartbeat on every API call would make the
    // "last seen on this device" data cost more than it is worth.
    if (now() - Number(session.last_seen_ms) > 60_000) {
      store.run('UPDATE sessions SET last_seen_ms = ? WHERE id = ?', now(), session.id);
    }
    return {
      user,
      session: { id: session.id, userId: session.user_id, deviceLabel: session.device_label },
      privacy: rowToPrivacy(privacyRow(user.id)),
    };
  }

  function logout(sessionId) {
    store.run('UPDATE sessions SET revoked_at_ms = ? WHERE id = ? AND revoked_at_ms IS NULL', now(), optionalId(sessionId, 'session id') || '');
    return { ok: true };
  }

  function revokeAllSessions(userId, { exceptId } = {}) {
    if (exceptId) {
      store.run('UPDATE sessions SET revoked_at_ms = ? WHERE user_id = ? AND id <> ? AND revoked_at_ms IS NULL', now(), userId, exceptId);
    } else {
      store.run('UPDATE sessions SET revoked_at_ms = ? WHERE user_id = ? AND revoked_at_ms IS NULL', now(), userId);
    }
  }

  function listSessions(userId) {
    return store.all(
      `SELECT id, device_label, created_at_ms, last_seen_ms FROM sessions
        WHERE user_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ? ORDER BY last_seen_ms DESC`,
      userId, now(),
    ).map((row) => ({
      id: row.id,
      deviceLabel: row.device_label || 'device',
      createdAt: Number(row.created_at_ms),
      lastSeenAt: Number(row.last_seen_ms),
    }));
  }

  function touch(userId) {
    store.run('UPDATE users SET last_active_ms = ? WHERE id = ?', now(), userId);
  }

  // ---------------------------------------------------------------------------
  // Profile and privacy
  // ---------------------------------------------------------------------------

  function updateProfile(userId, patch = {}) {
    const fields = [];
    const values = [];
    if (patch.displayName !== undefined) { fields.push('display_name = ?'); values.push(text(patch.displayName, { field: 'display name', max: 80 })); }
    if (patch.bio !== undefined) { fields.push('bio = ?'); values.push(text(patch.bio, { field: 'bio', max: 280, required: false })); }
    if (patch.avatarId !== undefined) { fields.push('avatar_id = ?'); values.push(patch.avatarId ? optionalId(patch.avatarId, 'avatar id') : null); }
    if (patch.identityKey !== undefined) {
      // Public key for future end-to-end sealing; opaque here, so only length is checked.
      fields.push('identity_key = ?');
      values.push(patch.identityKey ? text(patch.identityKey, { field: 'identity key', max: 200 }) : null);
    }
    if (fields.length) {
      store.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, ...values, userId);
    }
    return rowToUser(findUserById(userId));
  }

  function changePassword(userId, { currentPassword, newPassword } = {}) {
    const row = store.get('SELECT password_hash FROM users WHERE id = ?', userId);
    if (!row) throw new ApiError(404, 'no_such_user', 'Your account could not be found.');
    if (!verifyPassword(currentPassword, row.password_hash)) {
      throw new ApiError(403, 'wrong_password', 'Your current password is not correct.');
    }
    const problem = passwordProblem(newPassword, config.passwordMinLength);
    if (problem) throw new ApiError(400, 'weak_password', problem);
    store.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(newPassword), userId);
    // A password change means every other device must prove itself again.
    revokeAllSessions(userId);
    logger.info?.('password changed; all sessions revoked', { userId });
    return { ok: true };
  }

  function updatePrivacy(userId, patch = {}) {
    ensurePrivacyRow(userId);
    const columns = [];
    const values = [];
    const push = (column, value) => { columns.push(`${column} = ?`); values.push(value); };

    if (patch.presenceVisibleTo !== undefined) push('presence_visible_to', choice(patch.presenceVisibleTo, PRESENCE_VISIBLE, 'presence visibility'));
    if (patch.contactRequestsFrom !== undefined) push('contact_requests_from', choice(patch.contactRequestsFrom, REQUESTS_ALLOWED_FROM, 'contact requests'));
    if (patch.appearOffline !== undefined) push('appear_offline', validBoolean(patch.appearOffline, 'appear offline'));
    if (patch.showLastActive !== undefined) push('show_last_active', validBoolean(patch.showLastActive, 'show last active'));
    if (patch.readReceiptsEnabled !== undefined) push('read_receipts_enabled', validBoolean(patch.readReceiptsEnabled, 'read receipts'));
    if (patch.callsEnabled !== undefined) push('calls_enabled', validBoolean(patch.callsEnabled, 'calls'));
    if (patch.attachmentsEnabled !== undefined) push('attachments_enabled', validBoolean(patch.attachmentsEnabled, 'attachments'));
    if (columns.length) {
      push('updated_at_ms', now());
      store.run(`UPDATE user_privacy SET ${columns.join(', ')} WHERE user_id = ?`, ...values, userId);
    }
    return rowToPrivacy(privacyRow(userId));
  }

  function getPrivacy(userId) {
    ensurePrivacyRow(userId);
    return rowToPrivacy(privacyRow(userId));
  }

  // ---------------------------------------------------------------------------
  // Directory
  // ---------------------------------------------------------------------------

  /**
   * Search by username handle.
   *
   * Accounts that have set "no one may send me contact requests" are excluded:
   * being findable is otherwise a way around the setting, since a stranger could
   * still discover the account exists and message it directly.
   * Only display-safe columns leave this function.
   */
  function searchUsers(term, { limit = 25 } = {}) {
    const needle = String(term || '').trim().toLowerCase();
    if (needle.length < 2) return [];
    const capped = integer(limit, { field: 'limit', min: 1, max: 50, fallback: 25 });
    const pattern = `%${needle.replace(/[%_\\]/g, '\\$&')}%`;
    return store.all(
      `SELECT u.id, u.username, u.display_name, u.bio, u.avatar_id, u.created_at_ms, u.last_active_ms
         FROM users u
         JOIN user_privacy p ON p.user_id = u.id
        WHERE u.deleted_at_ms IS NULL
          AND p.contact_requests_from = 'everyone'
          AND lower(u.username) LIKE ? ESCAPE '\\'
        ORDER BY (lower(u.username) = ?) DESC, u.display_name ASC
        LIMIT ?`,
      pattern, needle, capped,
    );
  }

  /** A single profile for a contact card, or null if it does not exist. */
  function profileOf(userId) {
    return rowToUser(findUserById(optionalId(userId, 'user id') || ''));
  }

  return {
    register,
    login,
    resolve,
    logout,
    touch,
    findUserById,
    rowToUser,
    rowToPrivacy,
    listSessions,
    revokeAllSessions,
    updateProfile,
    changePassword,
    updatePrivacy,
    getPrivacy,
    searchUsers,
    profileOf,
    DEFAULT_PRIVACY,
  };
}

module.exports = { createAccounts, rowToUser, rowToPrivacy, DEFAULT_PRIVACY, PRESENCE_VISIBLE, REQUESTS_ALLOWED_FROM };
