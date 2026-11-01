'use strict';
/**
 * WebSocket events: the small set of things that are sent over the live socket
 * rather than as HTTP requests, plus the notifier everything else uses.
 *
 * The split is deliberate:
 *
 *   - Commands that must be durable (send a message, add a reaction, upload a
 *     file, start a call) are REST calls. A retried HTTP request has well-defined
 *     semantics, and a request that fails has a status code the client can act
 *     on. Doing those over the socket would mean reinventing that, badly.
 *   - Things that are only worth delivering while a human is watching go over the
 *     socket: presence, typing, read position, and WebRTC signalling. Losing a
 *     typing indicator costs nothing; losing an ICE candidate costs a call.
 *
 * Nothing in here trusts the socket. Membership, blocks and privacy settings are
 * re-checked on every event by the modules it calls into.
 */
const { ApiError, requiredId, status: validStatus, integer } = require('./validate');

const CLIENT_EVENTS = ['ping', 'presence', 'typing', 'message.read', 'call.signal'];

function createEvents({ accounts, connections, presence, chat, calls, hub, logger, now = Date.now }) {
  /**
   * Send one event to a set of users, each getting their OWN view of it.
   * Presence in particular must never be broadcast as a single payload, because
   * what user A may see about user B is not what user C may see.
   */
  function notify(type, userIds, payload, { except } = {}) {
    const delivered = hub.sendToMany(userIds, { type, ts: now(), ...payload }, { except });
    return delivered;
  }

  /** Presence for `subjectId`, recomputed per viewer at send time. */
  function notifyPresence(subjectId, audience) {
    for (const viewerId of audience) {
      if (viewerId === subjectId) continue;
      hub.sendTo(viewerId, { type: 'presence', userId: subjectId, ...presence.presenceOf(subjectId, viewerId) });
    }
  }

  function contactsAudience(userId) {
    return connections.contactsOf(userId).map((contact) => contact.id);
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  function handlePing(record, message) {
    record.link.send({ type: 'pong', ref: message.id || null, serverTime: now() });
  }

  /**
   * A client telling us its own state. This is the signal that catches a machine
   * that woke up, went to sleep, or lost focus — none of which a socket can see.
   */
  function handlePresence(record, message) {
    const next = validStatus(message.status);
    presence.setClientStatus(record.session.id, next);
    accounts.touch(record.userId);
    notifyPresence(record.userId, contactsAudience(record.userId));
  }

  function handleTyping(record, message) {
    const conversationId = requiredId(message.conversationId, 'conversation id');
    chat.requireMember(conversationId, record.userId);
    const recipients = chat.recipientsFor(conversationId, record.userId);
    const contact = accounts.rowToUser(accounts.findUserById(record.userId));
    notify('typing', recipients, {
      conversationId,
      userId: record.userId,
      name: contact?.displayName || 'Someone',
      typing: message.typing !== false,
    });
    // Typing indicators are deliberately not stored anywhere.
  }

  function handleRead(record, message) {
    const conversationId = requiredId(message.conversationId, 'conversation id');
    const seq = integer(message.seq, { field: 'seq', min: 0, max: Number.MAX_SAFE_INTEGER });
    const result = chat.markRead({ userId: record.userId, conversationId, seq });
    if (!result.changed) return;
    // Receipts go only to the people the reader's own setting permits:
    // chat.markRead leaves the recipient list empty when receipts are off, so an
    // opt-out is honoured here rather than being a UI suggestion.
    if (result.recipients.length) {
      notify('message.read', result.recipients, { conversationId, userId: record.userId, seq: result.seq });
    }
    hub.sendSelf(record, { type: 'unread', total: chat.unreadTotal(record.userId) });
  }

  /**
   * Relay one WebRTC signal between two participants of a live call.
   *
   * The frame is `{ type: "call.signal", callId, toUserId, signal, payload }`. The
   * kind of signal is `signal`, never a second `type`, because `type` is already
   * this envelope; `calls.relay` re-checks membership, blocks and the call's state
   * on the way through, so a valid-looking frame from somebody who is not in the
   * call gets an error and not a peer's SDP.
   */
  function handleCallSignal(record, message) {
    const callId = requiredId(message.callId, 'call id');
    const relayed = calls.relay({
      fromUserId: record.userId,
      callId,
      toUserId: message.toUserId,
      signal: message.signal,
      payload: message.payload,
    });
    const delivered = hub.sendTo(relayed.toUserId, { type: 'call.signal', ...relayed.event });
    if (!delivered) {
      // The peer's socket vanished between the online check and the send. Tell
      // the caller instead of letting them stare at "connecting…".
      hub.sendSelf(record, { type: 'call.peer_unreachable', callId, toUserId: relayed.toUserId });
    }
  }

  const HANDLERS = {
    ping: handlePing,
    presence: handlePresence,
    typing: handleTyping,
    'message.read': handleRead,
    'call.signal': handleCallSignal,
  };

  function onEvent(record, message) {
    const handler = HANDLERS[message.type];
    if (!handler) throw new ApiError(400, 'unknown_event', `This server does not handle a "${message.type}" event.`);
    handler(record, message);
  }

  /** Allow external modules (e.g. adminHub) to register additional frame handlers. */
  function addEventHandler(frameType, handler) {
    HANDLERS[frameType] = handler;
    CLIENT_EVENTS.push(frameType);
  }

  // ---------------------------------------------------------------------------
  // Socket lifecycle
  // ---------------------------------------------------------------------------

  function onAuthed(record) {
    const audience = contactsAudience(record.userId);
    notifyPresence(record.userId, audience);
    hub.sendSelf(record, { type: 'unread', total: chat.unreadTotal(record.userId) });
    // Re-attach a call that survived a reconnect: the media may still be up on the
    // peer side, and dropping the call because a window lost power is not good.
    // `reconnect` (rather than a read-only `currentFor`) is what puts a person who
    // never chose to leave back into the call, so that their next ICE candidate is
    // not refused by `call_left` and their peer is not stuck looking at an empty room.
    const live = calls.reconnect(record.userId);
    if (live) {
      hub.sendSelf(record, { type: 'call.active', ...live.live });
      if (live.rejoined && live.audience.length) {
        hub.sendToMany(live.audience, { type: 'call.joined', call: live.live.call, userId: record.userId }, { except: record.userId });
      }
    }
    logger.info?.('session live', { userId: record.userId, contacts: audience.length });
  }

  function onClosed(record) {
    const audience = contactsAudience(record.userId);
    notifyPresence(record.userId, audience);
    const outcomes = calls.onSocketClosed(record.userId) || [];
    for (const outcome of outcomes) {
      if (!outcome.audience?.length) continue;
      // The outcome names its own event. Hard-coding `call.ended` here would tear
      // down a live call panel for everybody else just because one peer dropped.
      hub.sendToMany(
        outcome.audience,
        {
          type: outcome.event,
          call: outcome.call,
          userId: record.userId,
          reason: outcome.call.endReason || (outcome.ended ? 'connection lost' : 'left'),
        },
        { except: record.userId },
      );
    }
    accounts.touch(record.userId);
  }

  /** Something happened to user A that their contacts should re-derive. */
  function onProfileChanged(userId) {
    notifyPresence(userId, contactsAudience(userId));
  }

  return {
    CLIENT_EVENTS,
    onEvent,
    onAuthed,
    onClosed,
    notify,
    notifyPresence,
    onProfileChanged,
    contactsAudience,
    addEventHandler,
  };
}

module.exports = { createEvents, CLIENT_EVENTS };
