'use strict';
/**
 * WebRTC call lifecycle and signalling authorisation.
 *
 * The server never touches media. It does three things and nothing else:
 *
 *   1. decides who may ring whom  (membership, blocks, the callee's "calls
 *      enabled" setting, one active call per conversation)
 *   2. relays SDP offers/answers and ICE candidates between participants,
 *      checking on every relay that BOTH ends are participants of a live call
 *   3. records what happened, so a call that dropped is a missed/ended call in
 *      the history rather than a silent vanishing act
 *
 * Consequences worth stating plainly: without a configured TURN relay, peers
 * behind symmetric NATs cannot connect and the UI must say so; and because
 * signalling travels through this server while media does not, a call's privacy
 * depends on the peers' own DTLS-SRTP, not on anything here.
 */
const { ApiError, requiredId, choice, text, integer } = require('./validate');
const { newId } = require('./credentials');

const CALL_MODES = ['audio', 'video'];
const CALL_STATES = ['ringing', 'active', 'ended', 'missed', 'declined', 'failed', 'canceled'];
const PARTICIPANT_STATES = ['invited', 'joined', 'declined', 'left', 'missed'];

// A description or candidate list is small by nature; anything bigger is either
// a bug or someone probing the relay with a payload it should never carry.
const MAX_SIGNAL_CHARS = 32_000;
const MAX_CANDIDATES = 60;

function callRow(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    initiatorId: row.initiator_id,
    mode: row.mode,
    state: row.state,
    createdAt: Number(row.created_at_ms),
    answeredAt: row.answered_at_ms ? Number(row.answered_at_ms) : null,
    endedAt: row.ended_at_ms ? Number(row.ended_at_ms) : null,
    endReason: row.end_reason || '',
  };
}

function createCalls({ store, chat, connections, accounts, presence, config, logger, notifier, now = Date.now }) {
  /** @type {Map<string, NodeJS.Timeout>} */
  const ringTimers = new Map();
  /** @type {Map<string, NodeJS.Timeout>} callId -> "come back or it's over" */
  const emptyTimers = new Map();

  function participants(callId) {
    return store.all(
      `SELECT p.user_id, p.state, p.joined_at_ms, p.left_at_ms, u.username, u.display_name, u.avatar_id
         FROM call_participants p JOIN users u ON u.id = p.user_id
        WHERE p.call_id = ?`,
      callId,
    ).map((r) => ({
      userId: r.user_id,
      state: r.state,
      joinedAt: r.joined_at_ms ? Number(r.joined_at_ms) : null,
      leftAt: r.left_at_ms ? Number(r.left_at_ms) : null,
      username: r.username,
      displayName: r.display_name,
      avatarId: r.avatar_id || null,
    }));
  }

  function requireCall(callId) {
    const row = store.get('SELECT * FROM calls WHERE id = ?', requiredId(callId, 'call id'));
    if (!row) throw new ApiError(404, 'no_call', 'That call does not exist.');
    return row;
  }

  function requireParticipant(callId, userId) {
    const record = store.get('SELECT * FROM call_participants WHERE call_id = ? AND user_id = ?', callId, userId);
    if (!record) throw new ApiError(403, 'not_in_call', 'You are not a participant of that call.');
    return record;
  }

  function openCall(callId) {
    return ['ringing', 'active'].includes(requireCall(callId).state);
  }

  function clearTimer(callId) {
    const timer = ringTimers.get(callId);
    if (timer) clearTimeout(timer);
    ringTimers.delete(callId);
  }

  function clearEmptyTimer(callId) {
    const timer = emptyTimers.get(callId);
    if (timer) clearTimeout(timer);
    emptyTimers.delete(callId);
  }

  /**
   * Give a call that has dropped below two people one timeout window to fill up
   * again before it is written off.
   *
   * A socket dying is not a person leaving: a laptop that switched Wi-Fi, or a
   * process that was restarted, is back within seconds and the media on the other
   * side is often still up. Ending the row the instant one peer vanished would
   * punish exactly the flake this feature has to survive. A deliberate hang-up or
   * decline does not need this - nobody rejoins a call they chose to leave - so
   * those paths finish on the spot.
   */
  function waitForReturn(callId) {
    clearEmptyTimer(callId);
    const timer = setTimeout(() => {
      emptyTimers.delete(callId);
      const row = store.get('SELECT state FROM calls WHERE id = ?', callId);
      if (!row || !['ringing', 'active'].includes(row.state)) return;
      const back = participants(callId).filter((p) => ['invited', 'joined'].includes(p.state));
      if (back.length >= 2) return;
      const outcome = finish(callId, 'ended', 'connection lost');
      notifier?.('call.ended', outcome.audience, { call: outcome.call, reason: 'connection lost' });
      logger.info?.('call abandoned after a peer did not come back', { callId });
    }, config.rtc.callTimeoutMs);
    timer.unref?.();
    emptyTimers.set(callId, timer);
  }

  function finish(callId, state, reason) {
    clearTimer(callId);
    clearEmptyTimer(callId);
    const timestamp = now();
    store.run('UPDATE calls SET state = ?, ended_at_ms = ?, end_reason = ? WHERE id = ? AND state IN (?, ?)', state, timestamp, text(reason, { field: 'reason', max: 40, required: false }) || state, callId, 'ringing', 'active');
    store.run("UPDATE call_participants SET state = 'left', left_at_ms = ? WHERE call_id = ? AND state IN ('invited', 'joined')", timestamp, callId);
    const call = callRow(requireCall(callId));
    const audience = participants(callId).map((p) => p.userId);
    logger.info?.('call ended', { callId, state, participants: audience.length });
    return { call, audience, ended: true };
  }

  /**
   * Start a call into a conversation.
   * @returns {{call, ringing: string[], relayWarning: string|null}}
   */
  function dial({ callerId, conversationId, mode } = {}) {
    const conversation = chat.requireConversation(requiredId(conversationId, 'conversation id'));
    chat.requireMember(conversation.id, callerId);
    const kind = choice(mode, CALL_MODES, 'call mode');

    const members = chat.memberIds(conversation.id).filter((id) => id !== callerId);
    if (!members.length) throw new ApiError(400, 'no_one_to_call', 'Nobody else is in that conversation.');
    for (const member of members) {
      if (connections.isBlocked(callerId, member)) throw new ApiError(403, 'blocked', 'You cannot call this person.');
      if (connections.isBlocked(member, callerId)) throw new ApiError(403, 'blocked', 'This person is not accepting calls from you.');
      if (!accounts.getPrivacy(member).callsEnabled) {
        throw new ApiError(403, 'calls_disabled', `${accounts.rowToUser(accounts.findUserById(member))?.displayName || 'That contact'} has calls turned off.`);
      }
    }

    const existing = store.get(
      "SELECT id FROM calls WHERE conversation_id = ? AND state IN ('ringing', 'active')",
      conversation.id,
    );
    if (existing) throw new ApiError(409, 'call_in_progress', 'That conversation already has a call running.');

    const id = newId();
    const timestamp = now();
    store.transaction(() => {
      store.run(
        `INSERT INTO calls (id, conversation_id, initiator_id, mode, state, created_at_ms)
         VALUES (?, ?, ?, ?, 'ringing', ?)`,
        id, conversation.id, callerId, kind, timestamp,
      );
      store.run('INSERT INTO call_participants (call_id, user_id, state) VALUES (?, ?, ?)', id, callerId, 'joined');
      store.run('UPDATE call_participants SET joined_at_ms = ? WHERE call_id = ? AND user_id = ?', timestamp, id, callerId);
      for (const member of members) {
        store.run('INSERT INTO call_participants (call_id, user_id, state) VALUES (?, ?, ?)', id, member, 'invited');
      }
    });

    // Nobody answers before this fires, the call is over and marked missed.
    const timer = setTimeout(() => {
      ringTimers.delete(id);
      const row = store.get('SELECT state FROM calls WHERE id = ?', id);
      if (!row || row.state !== 'ringing') return;
      const outcome = finish(id, 'missed', 'no answer');
      notifier?.('call.ended', outcome.audience, { call: outcome.call, reason: 'no_answer' });
      logger.info?.('call missed', { callId: id });
    }, config.rtc.callTimeoutMs);
    timer.unref?.();
    ringTimers.set(id, timer);

    logger.info?.('call placed', { callId: id, conversationId: conversation.id, callerId, ringing: members.length });
    return {
      call: callRow(requireCall(id)),
      ringing: members,
      // Surfaced to the caller's UI so a failed connection can be explained
      // honestly instead of being blamed on the other person.
      relayWarning: config.rtc.turnConfigured ? null : 'No TURN relay is configured on this server, so some network pairs cannot connect.',
    };
  }

  function accept({ callId, userId } = {}) {
    const call = requireCall(callId);
    // `openCall`, not "still ringing": a group call keeps ringing after the first
    // answer, and an invitee who joins five minutes late is joining a call that is
    // already running. Requiring 'ringing' here would lock everybody but the first
    // responder out of the group call this feature promises.
    if (!openCall(call.id)) throw new ApiError(409, 'call_over', 'That call is no longer running.');
    const record = requireParticipant(call.id, userId);
    if (record.state === 'joined') return { call: callRow(call), audience: [] };
    const timestamp = now();
    store.run("UPDATE call_participants SET state = 'joined', joined_at_ms = ?, left_at_ms = NULL WHERE call_id = ? AND user_id = ?", timestamp, call.id, userId);
    const stillRinging = store.get("SELECT COUNT(*) AS n FROM call_participants WHERE call_id = ? AND state = 'invited'", call.id).n;
    const becameActive = call.state === 'ringing';
    if (becameActive) store.run("UPDATE calls SET state = 'active', answered_at_ms = ? WHERE id = ?", timestamp, call.id);
    if (!Number(stillRinging)) clearTimer(call.id);
    const fresh = callRow(requireCall(call.id));
    const audience = participants(call.id).map((p) => p.userId).filter((id) => id !== userId);
    logger.info?.('call accepted', { callId: call.id, userId });
    return { call: fresh, audience, becameActive };
  }

  function decline({ callId, userId } = {}) {
    const call = requireCall(callId);
    if (!openCall(call.id)) throw new ApiError(409, 'call_over', 'That call is already over.');
    const record = requireParticipant(call.id, userId);
    if (record.state !== 'invited') throw new ApiError(409, 'already_answered', 'You already answered that call.');
    store.run("UPDATE call_participants SET state = 'declined' WHERE call_id = ? AND user_id = ?", call.id, userId);

    // One person cannot hold a call, so "nobody else is in here" ends it - which is
    // the whole of the difference between a direct call (over the moment it is
    // declined) and a group call (which carries on for everyone who stayed).
    const remaining = participants(call.id).filter((p) => ['invited', 'joined'].includes(p.state));
    if (remaining.length < 2) return finish(call.id, 'declined', 'declined');
    return { call: callRow(requireCall(call.id)), audience: remaining.map((p) => p.userId), ended: false };
  }

  function hangUp({ callId, userId, reason } = {}) {
    const call = requireCall(callId);
    if (!openCall(call.id)) return { call: callRow(call), audience: [], ended: false };
    requireParticipant(call.id, userId);
    store.run("UPDATE call_participants SET state = 'left', left_at_ms = ? WHERE call_id = ? AND user_id = ?", now(), call.id, userId);
    const remaining = store.get("SELECT COUNT(*) AS n FROM call_participants WHERE call_id = ? AND state IN ('invited', 'joined')", call.id).n;
    // Leaving on purpose needs no grace window: with fewer than two people able to
    // talk, the call is simply over. The initiator hanging up no longer tears down a
    // group call that the rest of the conversation is still using.
    if (remaining < 2) {
      const outcome = finish(call.id, 'ended', reason || 'ended');
      return { ...outcome, ended: true };
    }
    return { call: callRow(requireCall(call.id)), audience: participants(call.id).map((p) => p.userId), ended: false };
  }

  /** The caller giving up before anybody answers. */
  function cancel({ callId, userId } = {}) {
    const call = requireCall(callId);
    if (call.initiator_id !== userId) throw new ApiError(403, 'not_your_call', 'Only the caller can cancel a ringing call.');
    if (call.state !== 'ringing') throw new ApiError(409, 'call_over', 'That call is already over.');
    return finish(call.id, 'canceled', 'canceled by caller');
  }

  /**
   * Relay one signalling message.
   *
   * The kind of signal travels in its own field, both here and in the event that
   * goes out. Reading the frame's `type` instead - which is the envelope every
   * frame carries, and is `call.signal` here - means the kind is never the value
   * the whitelist expects, and every offer, answer and candidate on earth is
   * refused. Losing an ICE candidate costs a call, so this shape is worth a
   * comment.
   *
   * @param {{fromUserId, callId, toUserId, signal, payload}} request
   */
  function relay({ fromUserId, callId, toUserId, signal, payload } = {}) {
    const call = requireCall(callId);
    if (!openCall(call.id)) throw new ApiError(409, 'call_over', 'That call is already over.');
    const target = requiredId(toUserId, 'user id');
    const mine = requireParticipant(call.id, fromUserId);
    const theirs = requireParticipant(call.id, target);
    if (target === fromUserId) throw new ApiError(400, 'self_signal', 'A signalling message needs two different participants.');
    if (connections.isBlocked(fromUserId, target)) throw new ApiError(403, 'blocked', 'You cannot signal this person.');

    // Having a row is not permission. Somebody who declined or walked out must not
    // be able to push an offer back into a call they left; coming back is what
    // `reconnect` does, and it goes through the socket handshake, not this relay.
    // An invitee who has not answered yet gets its own code, because the fix is
    // different: answer first, then signal.
    if (mine.state === 'invited') throw new ApiError(403, 'call_not_answered', 'Answer the call before sending signalling.');
    if (mine.state !== 'joined') throw new ApiError(403, 'call_left', 'You are not in that call any more.');
    // The far end may still be `invited`: a caller warming up ICE before an answer
    // is normal. A peer who declined or left is not a target.
    if (!['invited', 'joined'].includes(theirs.state)) {
      throw new ApiError(409, 'peer_unavailable', 'That person is not taking part in the call.');
    }
    const kind = choice(signal, ['offer', 'answer', 'candidate', 'hangup', 'renegotiate', 'mute', 'screen'], 'signal');

    // Shape checks only: the SDP blob is opaque to us and is never parsed.
    let data = payload;
    if (kind === 'candidate') {
      const list = Array.isArray(payload?.candidates) ? payload.candidates : [payload];
      if (!list.length || list.length > MAX_CANDIDATES) {
        throw new ApiError(400, 'bad_candidates', `A candidate batch holds 1-${MAX_CANDIDATES} entries.`);
      }
      data = {
        candidates: list.map((candidate) => ({
          candidate: text(candidate?.candidate, { field: 'candidate', max: 600 }),
          sdpMid: candidate?.sdpMid === undefined ? null : String(candidate.sdpMid).slice(0, 40),
          sdpMLineIndex: Number.isInteger(candidate?.sdpMLineIndex) ? candidate.sdpMLineIndex : null,
        })),
      };
    } else if (kind === 'offer' || kind === 'answer') {
      const description = String(payload?.sdp || '');
      if (!description || description.length > MAX_SIGNAL_CHARS) {
        throw new ApiError(400, 'bad_description', `An offer or answer must be 1-${MAX_SIGNAL_CHARS} characters.`);
      }
      data = { sdp: description, type: choice(payload?.type, [kind], 'description type') };
    } else if (kind === 'mute' || kind === 'screen') {
      data = {
        audio: payload?.audio === undefined ? null : Boolean(payload.audio),
        video: payload?.video === undefined ? null : Boolean(payload.video),
        screen: payload?.screen === undefined ? null : Boolean(payload.screen),
        reason: payload?.reason ? String(payload.reason).slice(0, 80) : null,
      };
    } else {
      data = {};
    }

    const sender = accounts.rowToUser(accounts.findUserById(fromUserId));
    if (!presence.isOnline(target)) {
      // The peer has no live socket. Say so rather than dropping the message into
      // a void: the client needs to show "unreachable", not "connecting forever".
      throw new ApiError(409, 'peer_offline', `${sender?.displayName || 'That person'} is no longer connected.`);
    }
    return {
      toUserId: target,
      event: {
        callId: call.id,
        fromUserId,
        fromName: sender?.displayName || 'Unknown',
        // `signal`, never `type`: the frame that carries this is `call.signal`, and
        // an event that overwrites its own envelope type cannot be dispatched.
        signal: kind,
        payload: data,
        mode: call.mode,
      },
    };
  }

  /** Live call for this user, so a reconnect can rejoin instead of starting over. */
  function currentFor(userId) {
    const row = store.get(
      `SELECT c.* FROM calls c
        JOIN call_participants p ON p.call_id = c.id
       WHERE p.user_id = ? AND c.state IN ('ringing', 'active')
       ORDER BY c.created_at_ms DESC LIMIT 1`,
      userId,
    );
    if (!row) return null;
    return { call: callRow(row), participants: participants(row.id) };
  }

  /**
   * A socket came back. Someone who never chose to leave is put back in: an active
   * call re-joins them, a call that is still ringing rings them again. Losing Wi-Fi
   * for four seconds must not quietly remove you from a meeting, and a client that
   * reconnected to nothing would have no way to get back in, because `accept` only
   * answers a ringing call.
   * @returns {{live: object, rejoined: boolean, audience: string[]}|null}
   */
  function reconnect(userId) {
    const live = currentFor(userId);
    if (!live) return null;
    const record = store.get('SELECT * FROM call_participants WHERE call_id = ? AND user_id = ?', live.call.id, userId);
    if (!record || !['left', 'missed'].includes(record.state)) return { live, rejoined: false, audience: [] };
    const back = live.call.state === 'ringing' ? 'invited' : 'joined';
    store.run(
      'UPDATE call_participants SET state = ?, joined_at_ms = ?, left_at_ms = NULL WHERE call_id = ? AND user_id = ?',
      back, back === 'joined' ? now() : null, live.call.id, userId,
    );
    // The person this window was waiting for has arrived.
    const others = participants(live.call.id).filter((p) => ['invited', 'joined'].includes(p.state));
    if (others.length >= 2) clearEmptyTimer(live.call.id);
    const fresh = { call: callRow(requireCall(live.call.id)), participants: participants(live.call.id) };
    logger.info?.('call participant reconnected', { callId: live.call.id, userId, state: back });
    return { live: fresh, rejoined: true, audience: fresh.participants.map((p) => p.userId).filter((id) => id !== userId) };
  }

  function historyOf(conversationId, userId, limit = 20) {
    chat.requireMember(conversationId, userId);
    const size = integer(limit, { field: 'limit', min: 1, max: 100, fallback: 20 });
    return store.all(
      'SELECT * FROM calls WHERE conversation_id = ? ORDER BY created_at_ms DESC LIMIT ?',
      conversationId, size,
    ).map((r) => ({ ...callRow(r), participants: participants(r.id) }));
  }

  function closeAll() {
    for (const timer of ringTimers.values()) clearTimeout(timer);
    ringTimers.clear();
    for (const timer of emptyTimers.values()) clearTimeout(timer);
    emptyTimers.clear();
  }

  /**
   * Mark a participant gone when their socket died mid-call.
   *
   * Each outcome carries the event the audience should get: a call that finished is
   * `call.ended`, and a call that simply lost one person is not - announcing the
   * wrong one tears down a working call panel, or leaves a spinning "connecting…"
   * behind when the last person went.
   */
  function onSocketClosed(userId) {
    const live = currentFor(userId);
    if (!live) return [];
    const outcomes = [];
    if (live.call.state === 'ringing' && live.call.initiator_id !== userId) {
      store.run("UPDATE call_participants SET state = 'missed' WHERE call_id = ? AND user_id = ?", live.call.id, userId);
      const others = participants(live.call.id).filter((p) => ['invited', 'joined'].includes(p.state));
      if (!others.length) {
        const outcome = finish(live.call.id, 'missed', 'no answer');
        outcomes.push({ ...outcome, event: 'call.ended' });
      } else {
        outcomes.push({
          call: callRow(requireCall(live.call.id)),
          audience: others.map((p) => p.userId),
          ended: false,
          event: 'call.missed',
        });
      }
      return outcomes;
    }
    store.run("UPDATE call_participants SET state = 'left', left_at_ms = ? WHERE call_id = ? AND user_id = ?", now(), live.call.id, userId);
    const remaining = participants(live.call.id).filter((p) => ['invited', 'joined'].includes(p.state));
    if (!remaining.length) {
      const outcome = finish(live.call.id, 'ended', 'connection lost');
      outcomes.push({ ...outcome, event: 'call.ended' });
    } else {
      if (remaining.length < 2) waitForReturn(live.call.id);
      outcomes.push({
        call: callRow(requireCall(live.call.id)),
        audience: remaining.map((p) => p.userId),
        ended: false,
        event: 'call.participant_left',
      });
    }
    return outcomes;
  }

  /**
   * This process is going away, and with it the only thing holding these calls
   * together: signalling, and whoever was about to answer. Leaving rows `active`
   * would have the next boot tell a reconnecting client that it is mid-call, and it
   * is not - its peer connection died with the socket.
   */
  function onShutdown() {
    const open = store.all("SELECT id FROM calls WHERE state IN ('ringing', 'active')");
    for (const row of open) {
      try {
        finish(row.id, 'failed', 'server restarted');
      } catch (error) {
        logger.error?.('call could not be closed on shutdown', { callId: row.id, error: error.message });
      }
    }
    closeAll();
    return { closed: open.length };
  }

  return {
    CALL_MODES,
    CALL_STATES,
    PARTICIPANT_STATES,
    dial,
    accept,
    decline,
    hangUp,
    cancel,
    relay,
    currentFor,
    reconnect,
    participants,
    requireCall,
    historyOf,
    finish,
    closeAll,
    onShutdown,
    onSocketClosed,
    callRow,
  };
}

module.exports = { createCalls, callRow, CALL_MODES, CALL_STATES };
