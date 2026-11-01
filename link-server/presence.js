'use strict';
/**
 * Presence: who is reachable right now, and who is allowed to know that.
 *
 * Why startup/shutdown events are not enough (the spec is right to insist):
 * a closed socket is only news if the process notices it, a sleeping laptop
 * keeps its socket open, a network handover can leave a half-dead connection
 * for minutes, and "appears online" must survive the user opening a second
 * window. So presence here is derived from three signals, none of them an
 * app-lifecycle event:
 *
 *   1. socket liveness      — the server pings every `pingMs`; a socket that has
 *                             not answered within `deadMs` is torn down
 *   2. client heartbeats    — each client reports its own idle state ('online'
 *                             on activity, 'away' after N minutes without input),
 *                             which is the only way to catch a suspended machine
 *   3. server-side idle     — a live socket that has said nothing for
 *                             `awayMinutes` is demoted to 'away' even if the
 *                             client forgot to say so
 *
 * Privacy is applied at read time, never at write time: the internal state is
 * exact, and `presenceOf()` decides what a particular viewer may see, so
 * changing a setting takes effect for future reads without touching history.
 */
const STATUS_RANK = { offline: 0, away: 1, busy: 2, online: 3 };

function createPresence({ accounts, connections, config, logger, now = Date.now } = {}) {
  /** @type {Map<string, object>} sessionId -> live socket record */
  const live = new Map();
  /** @type {Map<string, Set<string>>} userId -> sessionIds */
  const byUser = new Map();
  /**
   * The aggregate status each online user was last reported with. Idle demotion
   * happens on its own when the clock passes the away window, so this is what lets
   * the server notice a change nobody was told about - without it, a contact's
   * directory would say "away" while their open socket still shows a green dot.
   */
  const reported = new Map();

  /**
   * Record a live session. The socket itself stays in `hub.js` - presence only
   * needs to know that a session exists and when it last proved it was awake,
   * which keeps one owner for each thing and stops a closed socket being reachable
   * from two places at once.
   */
  function attach({ session, deviceLabel }) {
    const record = {
      sessionId: session.id,
      userId: session.userId,
      deviceLabel: deviceLabel || session.deviceLabel || 'device',
      status: 'online',
      connectedAt: now(),
      lastActivityAt: now(),
      clientStatus: 'online',
    };
    live.set(session.id, record);
    if (!byUser.has(session.userId)) byUser.set(session.userId, new Set());
    byUser.get(session.userId).add(session.id);
    reported.set(session.userId, rawStatus(session.userId));
    logger.info?.('presence attached', { userId: session.userId, sessionId: session.id });
    return record;
  }

  function detach(sessionId) {
    const record = live.get(sessionId);
    if (!record) return null;
    live.delete(sessionId);
    const set = byUser.get(record.userId);
    if (set) {
      set.delete(sessionId);
      // The last device going offline is reported by whoever closed the socket, so
      // this map stops tracking the user rather than carrying a stale entry forever.
      if (!set.size) {
        byUser.delete(record.userId);
        reported.delete(record.userId);
      } else {
        reported.set(record.userId, rawStatus(record.userId));
      }
    }
    logger.info?.('presence detached', { userId: record.userId, sessionId });
    return record;
  }

  /** A client told us it is idle/active/focused. */
  function setClientStatus(sessionId, status) {
    const record = live.get(sessionId);
    if (!record) return null;
    record.clientStatus = status;
    record.status = status;
    record.lastActivityAt = now();
    // The client has just told us its state and the caller notifies the audience,
    // so record it as reported: the next sweep must not repeat the same news.
    reported.set(record.userId, rawStatus(record.userId));
    return record;
  }

  /** Any inbound frame counts as proof the machine is awake and driving. */
  function beat(sessionId) {
    const record = live.get(sessionId);
    if (!record) return;
    record.lastActivityAt = now();
  }

  function isOnline(userId) {
    return Boolean(byUser.get(userId)?.size);
  }

  /** The best-guess aggregate across this user's live devices. */
  function rawStatus(userId) {
    const sessions = byUser.get(userId);
    if (!sessions || !sessions.size) return 'offline';
    const awayCutoff = now() - config.presence.awayMinutes * 60_000;
    let best = 'offline';
    for (const sessionId of sessions) {
      const record = live.get(sessionId);
      if (!record) continue;
      // A socket that is open but silent is not "online" in the sense a human
      // means; it is away. This is the suspended-laptop case.
      const candidate = record.lastActivityAt < awayCutoff && record.clientStatus === 'online'
        ? 'away'
        : record.clientStatus;
      if (STATUS_RANK[candidate] > STATUS_RANK[best]) best = candidate;
    }
    return best;
  }

  /**
   * What `viewerId` is allowed to know about `userId`.
   * @returns {{status: string, lastActiveAt: number|null, deviceCount: number}}
   */
  function presenceOf(userId, viewerId) {
    const privacy = accounts.getPrivacy(userId);
    const devices = byUser.get(userId)?.size || 0;
    const status = rawStatus(userId);

    const visibleToEveryone = privacy.presenceVisibleTo === 'everyone';
    const visibleToViewer = viewerId
      ? (connections.areConnected(userId, viewerId) || viewerId === userId)
      : false;
    const maySeeStatus = viewerId === userId
      || visibleToEveryone
      || (privacy.presenceVisibleTo === 'contacts' && visibleToViewer);

    // "Appear offline" wins over everything except the user's own view: a contact
    // must not be able to tell that the user is connected but hiding.
    const hiding = Boolean(privacy.appearOffline) && viewerId !== userId;
    const shownStatus = !maySeeStatus || hiding ? 'offline' : status;

    // Last-active is part of the same disclosure as status. "Offline since two
    // minutes ago" is just as much a presence signal as "online".
    const maySeeLastActive = maySeeStatus && privacy.showLastActive && !hiding;
    const lastActive = maySeeLastActive ? Number(accounts.findUserById(userId)?.last_active_ms || 0) : 0;

    return {
      status: shownStatus,
      lastActiveAt: maySeeLastActive && lastActive ? lastActive : null,
      deviceCount: viewerId === userId ? devices : 0,
    };
  }

  /**
   * Users whose aggregate status has changed since the last time anyone was told,
   * for the users who are still connected. Going fully offline is not reported
   * here: that always arrives with the socket close, which has its own event.
   * @returns {string[]} user ids the audience should be re-notified about
   */
  function drifted() {
    const changed = [];
    for (const userId of byUser.keys()) {
      const status = rawStatus(userId);
      if (reported.get(userId) === status) continue;
      reported.set(userId, status);
      changed.push(userId);
    }
    return changed;
  }

  function presenceForMany(userIds, viewerId) {
    const out = {};
    for (const userId of userIds) out[userId] = presenceOf(userId, viewerId);
    return out;
  }

  return {
    attach,
    detach,
    beat,
    setClientStatus,
    isOnline,
    rawStatus,
    drifted,
    presenceOf,
    presenceForMany,
    liveCount: () => live.size,
    usersOnline: () => [...byUser.keys()],
    sessionsOf: (userId) => [...(byUser.get(userId) || [])],
    STATUS_RANK,
  };
}

module.exports = { createPresence, STATUS_RANK };
