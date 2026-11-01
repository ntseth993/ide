'use strict';
/**
 * The live hub: authenticated sockets, event fan-out, and heartbeat.
 *
 * Design decisions that matter for correctness:
 *
 *   - The token is NEVER in the URL. Query strings end up in access logs, proxy
 *     logs and browser history, so the client authenticates with a first frame
 *     after the handshake and an unauthenticated socket is closed at 10s.
 *   - Presence is not derived from connect/disconnect alone; the hub records
 *     liveness, and `presence.js` decides what that means.
 *   - Delivery is at-most-once over the socket by design. A client that misses
 *     an event pages the database for the same data, which is the only reason a
 *     dropped socket is an inconvenience instead of a lost message.
 *   - Every outbound frame is checked against the recipient's privacy at send
 *     time, so a setting change stops events immediately rather than at the next
 *     reconnect.
 */
const { ApiError, text, requiredId } = require('./validate');

const AUTH_TIMEOUT_MS = 10_000;
const AUTH_FRAME = 'auth';

function createHub({ accounts, presence, config, logger, limiter, onEvent, onAuthed, onClosed, onPresenceDrift, now = Date.now } = {}) {
  /** @type {Map<string, object>} sessionId -> { socket, userId, authenticated } */
  const bySession = new Map();

  function attachSocket(link, { ip } = {}) {
    const record = {
      link,
      ip: ip || 'unknown',
      authenticated: false,
      userId: null,
      session: null,
      connectedAt: now(),
    };
    link.on('message', (raw) => handleFrame(record, raw));
    link.on('close', (info) => {
      if (record.authenticated) {
        const detached = presence.detach(record.session.id);
        bySession.delete(record.session.id);
        if (detached) onClosed?.(record, info);
      }
      logger.debug?.('socket closed', { code: info.code, authenticated: record.authenticated });
    });
    const timer = setTimeout(() => {
      if (!record.authenticated) link.close(1008, 'authentication timeout');
    }, AUTH_TIMEOUT_MS);
    timer.unref?.();
    return record;
  }

  function handleFrame(record, raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      record.link.close(1007, 'frames must be JSON');
      return;
    }
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      record.link.close(1002, 'a frame must be an object with a type');
      return;
    }

    if (!record.authenticated) {
      if (message.type !== AUTH_FRAME) {
        record.link.close(1008, 'authenticate before sending anything else');
        return;
      }
      authenticate(record, message);
      return;
    }

    // Any inbound frame is proof of life, and proof the machine is awake.
    presence.beat(record.session.id);
    const key = `${record.userId}|${record.session.id}`;
    if (!limiter.take('events', key).allowed) {
      record.link.send({ type: 'error', code: 'rate_limited', message: 'Too many events. Slow down.' });
      return;
    }
    try {
      onEvent?.(record, message);
    } catch (error) {
      const known = error instanceof ApiError;
      record.link.send({
        type: 'error',
        ref: message.id || null,
        code: known ? error.code : 'internal_error',
        message: known ? error.message : 'The server could not handle that event.',
      });
      if (!known) logger.error?.('event handler failed', { userId: record.userId, error: String(error.message || error) });
    }
  }

  function authenticate(record, message) {
    const resolved = accounts.resolve(message.token);
    if (!resolved) {
      // Close rather than answer: an unauthenticated socket should learn nothing
      // about why, and the client already has the same answer from the REST layer.
      record.link.close(1008, 'session rejected');
      logger.warn?.('socket authentication rejected', { ip: record.ip });
      return;
    }
    const session = { id: resolved.session.id, userId: resolved.user.id, deviceLabel: resolved.session.deviceLabel };
    // A second socket for the same session id means a restored tab or a duplicate
    // process. The older one is retired so presence counts devices, not ghosts.
    const previous = bySession.get(session.id);
    if (previous) {
      previous.link.close(1012, 'session replaced');
      bySession.delete(session.id);
    }

    record.authenticated = true;
    record.userId = session.userId;
    record.session = session;
    bySession.set(session.id, record);

    const link = record.link;
    presence.attach({ session, deviceLabel: text(message.deviceLabel, { field: 'device label', max: 60, required: false }) || session.deviceLabel });

    link.send({
      type: 'ready',
      serverTime: now(),
      user: accounts.rowToUser(resolved.user),
      privacy: resolved.privacy,
      sessions: accounts.listSessions(session.userId),
      rtc: { iceServers: config.rtc.iceServers, turnConfigured: config.rtc.turnConfigured },
      limits: { maxMessageChars: config.limits.maxMessageChars, maxFileBytes: config.limits.maxFileBytes },
    });
    logger.info?.('socket authenticated', { userId: session.userId, sessionId: session.id });
    onAuthed?.(record, message);
  }

  /**
   * Deliver one event to every live socket of one user.
   * @returns {number} how many sockets received it
   */
  function sendTo(userId, event) {
    const sessions = presence.sessionsOf(userId);
    let delivered = 0;
    for (const sessionId of sessions) {
      const record = bySession.get(sessionId);
      if (!record) continue;
      if (record.link.send(event)) delivered += 1;
    }
    return delivered;
  }

  function sendToMany(userIds, event, { except } = {}) {
    const counts = {};
    for (const userId of new Set(userIds)) {
      if (userId === except) continue;
      counts[userId] = sendTo(userId, event);
    }
    return counts;
  }

  function sendSelf(record, event) {
    record.link.send(event);
  }

  /**
   * Heartbeat: ping everything, drop what stopped answering.
   * The silence budget is `deadMs` measured from the last inbound byte, and
   * `pingMs` only decides how often the server probes - a socket is not executed
   * for one pong that arrived a few milliseconds late on a busy machine. That is
   * still how a laptop that slept, a dropped network and a half-closed connection
   * all get noticed.
   */
  function sweep() {
    const deadline = now() - config.presence.deadMs;
    for (const record of bySession.values()) {
      const link = record.link;
      if (link.readyState !== 'open') continue;
      if (link.lastSeenAt < deadline) {
        logger.warn?.('socket silent past the dead line; dropping', {
          userId: record.userId,
          sessionId: record.session.id,
          silentMs: now() - link.lastSeenAt,
        });
        link.close(1001, 'connection lost');
        continue;
      }
      link.ping();
    }
    // A socket that is open but has stopped producing user activity quietly turns
    // "online" into "away" on the next read, which is a change nobody asked about -
    // so it is announced here rather than left for the next page refresh.
    for (const userId of presence.drifted()) onPresenceDrift?.(userId);
    // A session row that presence still thinks is live but no socket owns would
    // keep a user looking online forever, so reconcile the two views.
    for (const userId of presence.usersOnline()) {
      for (const sessionId of presence.sessionsOf(userId)) {
        if (!bySession.has(sessionId)) presence.detach(sessionId);
      }
    }
  }

  let timer = null;
  function start() {
    timer = setInterval(sweep, config.presence.pingMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    for (const record of [...bySession.values()]) record.link.close(1001, 'server shutting down');
    bySession.clear();
  }

  /** Force every live socket of one user closed (password change, account deletion). */
  function disconnectUser(userId, reason = 'disconnected') {
    for (const sessionId of presence.sessionsOf(userId)) {
      const record = bySession.get(sessionId);
      if (record) record.link.close(1000, reason);
    }
  }

  /**
   * Close one session's socket. Signing out of a laptop must not log the same
   * account out of their desktop, so this takes the session id the credential
   * resolved to rather than the user id.
   */
  function dropSession(sessionId, reason = 'disconnected') {
    const record = bySession.get(requiredId(sessionId, 'session id'));
    if (!record) return false;
    record.link.close(1000, reason);
    return true;
  }

  return {
    attachSocket,
    sendTo,
    sendToMany,
    sendSelf,
    sweep,
    start,
    stop,
    disconnectUser,
    dropSession,
    liveCount: () => bySession.size,
    AUTH_FRAME,
    AUTH_TIMEOUT_MS,
  };
}

module.exports = { createHub, AUTH_TIMEOUT_MS };
