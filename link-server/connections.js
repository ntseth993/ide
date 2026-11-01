'use strict';
/**
 * Connections: contact requests, accept/reject/remove, block, report.
 *
 * Also the home of the two questions every other module asks before it does
 * anything on someone's behalf:
 *
 *   areConnected(a, b)  — is b in a's approved contact list (symmetric)?
 *   isBlocked(a, b)     — has either side blocked the other? (one row is enough
 *                         to stop traffic in BOTH directions, which is what a
 *                         blocked user expects)
 *
 * Blocking is deliberately stronger than removing a contact: it also dissolves
 * the connection both ways and cancels any pending request, because "we removed
 * each other" should not leave a stale accepted row behind.
 */
const { ApiError, text, requiredId } = require('./validate');
const { newId } = require('./credentials');

const REQUEST_STATES = ['pending', 'accepted', 'rejected', 'canceled', 'blocked', 'expired'];

function createConnections({ store, accounts, logger, now = Date.now }) {
  function row(request) {
    return {
      id: request.id,
      requesterId: request.requester_id,
      addresseeId: request.addressee_id,
      state: request.state,
      /** The requester's own words, meant for the addressee. */
      note: request.note || '',
      createdAt: Number(request.created_at_ms),
      resolvedAt: request.resolved_at_ms ? Number(request.resolved_at_ms) : null,
      requester: accounts.rowToUser({
        id: request.requester_id,
        username: request.requester_username,
        display_name: request.requester_display_name,
        bio: '',
        avatar_id: null,
        created_at_ms: 0,
        last_active_ms: 0,
      }),
      addressee: accounts.rowToUser({
        id: request.addressee_id,
        username: request.addressee_username,
        display_name: request.addressee_display_name,
        bio: '',
        avatar_id: null,
        created_at_ms: 0,
        last_active_ms: 0,
      }),
    };
  }

  const REQUEST_SELECT = `
    SELECT r.id, r.requester_id, r.addressee_id, r.state, r.note, r.created_at_ms, r.resolved_at_ms,
           ru.username AS requester_username, ru.display_name AS requester_display_name,
           au.username AS addressee_username, au.display_name AS addressee_display_name
      FROM connection_requests r
      JOIN users ru ON ru.id = r.requester_id
      JOIN users au ON au.id = r.addressee_id`;

  function areConnected(userId, otherId) {
    return Boolean(store.get('SELECT 1 AS hit FROM connections WHERE user_id = ? AND contact_id = ?', userId, otherId));
  }

  function isBlocked(userId, otherId) {
    return Boolean(store.get(
      'SELECT 1 AS hit FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)',
      userId, otherId, otherId, userId,
    ));
  }

  function blockedBy(userId, otherId) {
    // True when `otherId` is the one who did the blocking.
    return Boolean(store.get('SELECT 1 AS hit FROM blocks WHERE user_id = ? AND blocked_id = ?', otherId, userId));
  }

  function contactsOf(userId) {
    return store.all(
      `SELECT u.id, u.username, u.display_name, u.bio, u.avatar_id, u.last_active_ms, c.created_at_ms AS since
         FROM connections c
         JOIN users u ON u.id = c.contact_id
        WHERE c.user_id = ? AND u.deleted_at_ms IS NULL
        ORDER BY u.display_name COLLATE NOCASE ASC`,
      userId,
    ).map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      bio: row.bio || '',
      avatarId: row.avatar_id || null,
      lastActiveAt: Number(row.last_active_ms) || null,
      since: Number(row.since),
    }));
  }

  function pendingRequests(userId) {
    const rows = store.all(
      `${REQUEST_SELECT} WHERE r.state = 'pending' AND (r.addressee_id = ? OR r.requester_id = ?)
        ORDER BY r.created_at_ms DESC LIMIT 100`,
      userId, userId,
    );
    return rows.map(row);
  }

  /**
   * Send a contact request. Refuses if either side blocked the other, if a
   * request already exists, or if the target has closed their door.
   */
  function request({ fromUserId, toUserId, toUsername, message } = {}) {
    const targetId = toUserId ? requiredId(toUserId, 'user id') : null;
    const target = targetId
      ? accounts.findUserById(targetId)
      : store.get('SELECT id, username, display_name FROM users WHERE username = ? AND deleted_at_ms IS NULL', String(toUsername || '').toLowerCase());
    if (!target) throw new ApiError(404, 'no_such_user', 'No account with that username exists.');
    if (target.id === fromUserId) throw new ApiError(400, 'self_request', 'You cannot add yourself as a contact.');
    if (isBlocked(fromUserId, target.id)) throw new ApiError(403, 'blocked', 'You cannot send a contact request to this person.');

    const privacy = accounts.getPrivacy(target.id);
    if (privacy.contactRequestsFrom === 'nobody') {
      throw new ApiError(403, 'requests_closed', 'This person is not accepting contact requests.');
    }
    if (areConnected(fromUserId, target.id)) return { alreadyConnected: true, request: null };

    const existing = store.get(
      'SELECT id, requester_id, addressee_id, state FROM connection_requests WHERE state = ? AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))',
      'pending', fromUserId, target.id, target.id, fromUserId,
    );
    if (existing) return { alreadyConnected: false, request: null, reused: true };

    const note = text(message, { field: 'message', max: 280, required: false });
    const id = newId();
    // The unique index is (requester_id, addressee_id) for the life of the pair, so
    // a request that was rejected, canceled or blocked is rewritten as pending
    // rather than inserted beside itself. A plain INSERT here threw
    // `UNIQUE constraint failed` and reached the developer as a 500 the second time
    // anybody re-added a contact they had fallen out with.
    store.run(
      `INSERT INTO connection_requests (id, requester_id, addressee_id, state, note, created_at_ms, resolved_at_ms)
       VALUES (?, ?, ?, 'pending', ?, ?, NULL)
       ON CONFLICT(requester_id, addressee_id) DO UPDATE
         SET state = 'pending', note = excluded.note, created_at_ms = excluded.created_at_ms, resolved_at_ms = NULL`,
      id, fromUserId, target.id, note, now(),
    );
    // Looked up by the pair, because a re-request keeps the original row's id.
    const written = store.get(
      `${REQUEST_SELECT} WHERE r.requester_id = ? AND r.addressee_id = ?`,
      fromUserId, target.id,
    );
    // `note` is the requester's own words; it is shown to the addressee only, and
    // `pendingFor` hands a row to nobody outside the pair.
    return {
      alreadyConnected: false,
      note,
      request: row(written),
    };
  }

  function resolveRequest({ userId, requestId, accept } = {}) {
    const request = store.get(
      `SELECT id, requester_id, addressee_id, state FROM connection_requests WHERE id = ?`,
      requiredId(requestId, 'request id'),
    );
    if (!request) throw new ApiError(404, 'no_such_request', 'That request no longer exists.');
    if (request.addressee_id !== userId) throw new ApiError(403, 'not_your_request', 'Only the person asked can answer a contact request.');
    if (request.state !== 'pending') throw new ApiError(409, 'request_resolved', 'That request was already answered.');
    if (isBlocked(request.requester_id, userId)) throw new ApiError(403, 'blocked', 'You cannot accept a request from this person.');

    const timestamp = now();
    store.transaction(() => {
      store.run('UPDATE connection_requests SET state = ?, resolved_at_ms = ? WHERE id = ?', accept ? 'accepted' : 'rejected', timestamp, request.id);
      if (accept) {
        store.run('INSERT INTO connections (user_id, contact_id, created_at_ms) VALUES (?, ?, ?) ON CONFLICT(user_id, contact_id) DO NOTHING', request.requester_id, request.addressee_id, timestamp);
        store.run('INSERT INTO connections (user_id, contact_id, created_at_ms) VALUES (?, ?, ?) ON CONFLICT(user_id, contact_id) DO NOTHING', request.addressee_id, request.requester_id, timestamp);
      }
    });
    logger.info?.('contact request resolved', { userId, requesterId: request.requester_id, accept });
    return store.get(`${REQUEST_SELECT} WHERE r.id = ?`, request.id);
  }

  function removeContact({ userId, otherUserId } = {}) {
    const other = requiredId(otherUserId, 'user id');
    // Symmetric: a connection is a pair, and either half of the pair may end it.
    store.run('DELETE FROM connections WHERE (user_id = ? AND contact_id = ?) OR (user_id = ? AND contact_id = ?)', userId, other, other, userId);
    store.run(
      "UPDATE connection_requests SET state = 'canceled', resolved_at_ms = ? WHERE state = 'pending' AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))",
      now(), userId, other, other, userId,
    );
    return { ok: true };
  }

  function block({ userId, otherUserId } = {}) {
    const other = requiredId(otherUserId, 'user id');
    const timestamp = now();
    store.transaction(() => {
      store.run('INSERT INTO blocks (user_id, blocked_id, created_at_ms) VALUES (?, ?, ?) ON CONFLICT(user_id, blocked_id) DO NOTHING', userId, other, timestamp);
      store.run('DELETE FROM connections WHERE (user_id = ? AND contact_id = ?) OR (user_id = ? AND contact_id = ?)', userId, other, other, userId);
      store.run(
        "UPDATE connection_requests SET state = 'blocked', resolved_at_ms = ? WHERE state = 'pending' AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))",
        timestamp, userId, other, other, userId,
      );
      // Any conversation the two share keeps its history; what changes is that
      // no new traffic flows between this pair (chat.js re-checks blocks on every
      // send, so a block that happens later is honoured immediately).
    });
    logger.info?.('contact blocked', { userId, blockedId: other });
    return { ok: true };
  }

  function unblock({ userId, otherUserId } = {}) {
    store.run('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?', userId, requiredId(otherUserId, 'user id'));
    return { ok: true };
  }

  function blockedList(userId) {
    return store.all(
      `SELECT b.blocked_id AS id, u.username, u.display_name, b.created_at_ms
         FROM blocks b JOIN users u ON u.id = b.blocked_id
        WHERE b.user_id = ? ORDER BY b.created_at_ms DESC`,
      userId,
    ).map((row) => ({ id: row.id, username: row.username, displayName: row.display_name, since: Number(row.created_at_ms) }));
  }

  const REPORT_REASONS = ['harassment', 'spam', 'malware', 'impersonation', 'hate', 'other'];

  function report({ userId, otherUserId, reason, detail } = {}) {
    const other = requiredId(otherUserId, 'user id');
    if (!accounts.findUserById(other) || other === userId) {
      throw new ApiError(404, 'no_such_user', 'There is no other account to report.');
    }
    const why = String(reason || '').trim().toLowerCase();
    if (!REPORT_REASONS.includes(why)) throw new ApiError(400, 'invalid_reason', `reason must be one of: ${REPORT_REASONS.join(', ')}.`);
    const note = text(detail, { field: 'detail', max: 1000, required: false });
    const id = newId();
    store.run(
      'INSERT INTO reports (id, reporter_id, reported_id, reason, detail, state, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, userId, other, why, note, 'open', now(),
    );
    logger.warn?.('user reported', { reportId: id, reporterId: userId, reportedId: other, reason: why });
    return { id, state: 'open' };
  }

  function isRequestPendingBetween(a, b) {
    return Boolean(store.get(
      "SELECT 1 AS hit FROM connection_requests WHERE state = 'pending' AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))",
      a, b, b, a,
    ));
  }

  return {
    REQUEST_STATES,
    REPORT_REASONS,
    areConnected,
    isBlocked,
    blockedBy,
    contactsOf,
    pendingRequests,
    request,
    resolveRequest,
    removeContact,
    block,
    unblock,
    blockedList,
    report,
    isRequestPendingBetween,
    row,
    REQUEST_SELECT,
  };
}

module.exports = { createConnections };
