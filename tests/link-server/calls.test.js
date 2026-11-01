/**
 * WebRTC signalling and call lifecycle (phase 5).
 *
 * The server does not carry media, so "the call works" cannot be tested here.
 * What can be tested - and what the brief actually promises - is the part the
 * server is responsible for:
 *
 *   - ringing reaches a live socket and is reported as unreachable when it does
 *     not;
 *   - an unanswered call dies on its own, on the server's clock, not because a
 *     client remembered to say so;
 *   - offers, answers and ICE candidates arrive at the right peer unchanged, with
 *     the frame envelope intact, and reach nobody who is not in the call;
 *   - a call that loses a person to a dropped socket is recoverable, and one that
 *     nobody comes back for is eventually written off;
 *   - blocks, privacy settings and membership are checked before anything stored.
 *
 * Every assertion is read back from a real socket or from SQLite. Nothing here
 * proves that two machines can hear each other: that needs a TURN relay and a
 * network that is not loopback, and the tests below are explicit about which
 * claims the relay is and is not configured for.
 */
import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { boot, CAPABILITY, SKIP, SKIP_REASON, until, rawClient } from './helpers';

/** Long enough for the server's own 5s ring/return timeout, plus CI slack. */
const LONG = 20_000;

describe.runIf(!SKIP)('NovaLink Live calls', () => {
  let harness = null;

  afterEach(async () => {
    if (harness) await harness.close();
    harness = null;
  });

  /**
   * Two contacts and a direct conversation between them.
   * `liveBob: false` leaves the callee with no socket, so a test can give them a
   * raw one instead - and a real socket plus a raw one for the same session would
   * replace each other, which is a different story than the one being told.
   */
  async function pair(prefix, { liveBob = true } = {}) {
    const alice = await harness.register(`${prefix}_alice`);
    const bob = await harness.register(`${prefix}_bob`);
    await harness.becomeFriends(alice, bob);
    const bobSocket = liveBob ? await harness.connectSocket(bob) : null;
    const aliceSocket = await harness.connectSocket(alice);
    const thread = (await alice.client.post('/api/conversations', { otherUserId: bob.id })).conversation.id;
    return { alice, bob, aliceSocket, bobSocket, thread };
  }

  /** Alice and two contacts in one group conversation; carol's socket is optional. */
  async function trio(prefix, { liveCarol = false } = {}) {
    const alice = await harness.register(`${prefix}_alice`);
    const bob = await harness.register(`${prefix}_bob`);
    const carol = await harness.register(`${prefix}_carol`);
    await harness.becomeFriends(alice, bob);
    await harness.becomeFriends(alice, carol);
    const bobSocket = await harness.connectSocket(bob);
    const aliceSocket = await harness.connectSocket(alice);
    const carolSocket = liveCarol ? await harness.connectSocket(carol) : null;
    const thread = (await alice.client.post('/api/conversations', {
      kind: 'group',
      memberIds: [bob.id, carol.id],
      title: 'standup',
    })).conversation.id;
    return { alice, bob, carol, aliceSocket, bobSocket, carolSocket, thread };
  }

  /** Alice, bob and carol, plus a fourth so a group can outlive its organizer. */
  async function quad(prefix) {
    const group = await trio(prefix);
    const dave = await harness.register(`${prefix}_dave`);
    await harness.becomeFriends(group.alice, dave);
    const daveSocket = await harness.connectSocket(dave);
    const thread = (await group.alice.client.post('/api/conversations', {
      kind: 'group',
      memberIds: [group.bob.id, group.carol.id, dave.id],
      title: 'four',
    })).conversation.id;
    return { ...group, dave, daveSocket, thread };
  }

  async function dial({ alice, thread }, mode = 'audio') {
    const response = await alice.client.post(`/api/conversations/${thread}/calls`, { mode });
    expect(response.__status).toBe(201);
    return response;
  }

  /** One signalling frame, exactly as a client would write it. */
  function signal(socket, { callId, toUserId, signal: kind, payload }) {
    const id = crypto.randomUUID();
    socket.send({ id, type: 'call.signal', callId, toUserId, signal: kind, payload });
    return id;
  }

  /** One frame in, one error code out - on a socket that must stay usable. */
  async function expectError(socket, frame, code) {
    const id = signal(socket, frame);
    const error = await socket.waitFor('error', { matches: (f) => f.ref === id, timeout: 5000 });
    expect(error.code).toBe(code);
    expect(error.message).toBeTruthy();
    return error;
  }

  /** A client whose connection can be killed without saying goodbye. */
  async function rawOnline(account) {
    const raw = rawClient(harness.port);
    await raw.sendText(JSON.stringify({ type: 'auth', token: account.token, deviceLabel: 'raw' }));
    await until(() => harness.instance.presence.isOnline(account.id), { label: `${account.username} to come online over the raw socket` });
    return raw;
  }

  async function rawOffline(account) {
    await until(() => !harness.instance.presence.isOnline(account.id), { label: `${account.username} to be marked offline` });
  }

  function callRow(callId) {
    return harness.store.get('SELECT state, end_reason, ended_at_ms, created_at_ms FROM calls WHERE id = ?', callId);
  }

  it('rings a call onto the callee’s live socket and records it in the database', async () => {
    // The one honest preamble: a suite this timing-sensitive is worthless if the
    // runtime cannot run it, so say which capabilities were checked.
    expect(CAPABILITY.supported, SKIP_REASON).toBe(true);
    harness = await boot();
    const { alice, bob, aliceSocket, bobSocket, thread } = await pair('ring');

    const response = await dial({ alice, thread });
    expect(response.call).toMatchObject({ conversationId: thread, initiatorId: alice.id, mode: 'audio', state: 'ringing' });
    expect(response.ringing).toEqual([bob.id]);
    // Nobody is offline in this scenario, so nothing may be reported unreachable.
    expect(response.unreachable).toEqual([]);
    // The brief refuses to assume peer-to-peer connectivity works, and this server
    // has no relay configured, so the caller must be told instead of left guessing.
    expect(response.relayWarning).toMatch(/No TURN relay/i);

    const incoming = await bobSocket.waitFor('call.incoming', (frame) => frame.call?.id === response.call.id);
    expect(incoming.conversationId).toBe(thread);
    expect(incoming.from).toMatchObject({ id: alice.id, username: 'ring_alice' });
    // Being the caller is not being rung.
    expect(aliceSocket.all('call.incoming')).toEqual([]);

    expect(callRow(response.call.id).state).toBe('ringing');
    expect(harness.instance.calls.participants(response.call.id))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ userId: alice.id, state: 'joined' }),
        expect.objectContaining({ userId: bob.id, state: 'invited' }),
      ]));
  });

  it('writes off an unanswered call on the server clock, without being told to', async () => {
    harness = await boot();
    const { alice, bob, aliceSocket, bobSocket, thread } = await pair('missed');
    const response = await dial({ alice, thread });

    // No accept, no decline, no hang-up: the only thing that happens is time.
    const ended = await bobSocket.waitFor('call.ended', {
      matches: (frame) => frame.call?.id === response.call.id,
      timeout: harness.config.rtc.callTimeoutMs + 5000,
    });
    expect(ended.call.state).toBe('missed');
    expect(ended.reason).toBe('no_answer');
    const forCaller = await aliceSocket.waitFor('call.ended', (frame) => frame.call?.state === 'missed');
    expect(forCaller.call.id).toBe(response.call.id);

    const row = callRow(response.call.id);
    expect(row).toMatchObject({ state: 'missed', end_reason: 'no answer' });
    expect(Number(row.ended_at_ms)).toBeGreaterThan(Number(row.created_at_ms));
    for (const participant of harness.instance.calls.participants(response.call.id)) {
      expect(participant.state).toBe('left');
    }
    // A call that is over cannot be answered afterwards.
    const late = await bob.client.post(`/api/calls/${response.call.id}/accept`, {});
    expect(late.__status).toBe(409);
    expect(late.error.code).toBe('call_over');
  }, LONG);

  it('relays SDP and ICE candidates to the right peer unchanged, envelope intact', async () => {
    harness = await boot();
    const { alice, bob, aliceSocket, bobSocket, thread } = await pair('sdp');
    const response = await dial({ alice, thread });
    const callId = response.call.id;

    const accepted = await bob.client.post(`/api/calls/${callId}/accept`, {});
    expect(accepted.__status).toBe(200);
    expect(accepted.call.state).toBe('active');
    expect(accepted.call.answeredAt).toBeGreaterThan(0);
    expect(accepted.participants.find((p) => p.userId === bob.id).state).toBe('joined');

    const offer = { sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\nopaque-blob\r\n', type: 'offer' };
    signal(aliceSocket, { callId, toUserId: bob.id, signal: 'offer', payload: offer });
    const relayed = await bobSocket.waitFor('call.signal', (frame) => frame.signal === 'offer');
    // `type` is the envelope and `signal` is the kind of signalling message. Reading
    // the envelope as the kind means every offer on earth is refused, and writing
    // the kind back into `type` means the frame cannot be dispatched.
    expect(relayed.type).toBe('call.signal');
    expect(relayed.fromUserId).toBe(alice.id);
    expect(relayed.fromName).toBe('sdp_alice');
    expect(relayed.mode).toBe('audio');
    expect(relayed.payload.sdp).toBe(offer.sdp);
    expect(relayed.payload.type).toBe('offer');

    const candidates = {
      candidates: [
        { candidate: 'candidate:1 1 udp 2113937151 192.168.1.5 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
        { candidate: 'candidate:2 1 udp 16777215 203.0.113.7 50001 typ srflx', sdpMid: '0', sdpMLineIndex: 0 },
      ],
    };
    signal(aliceSocket, { callId, toUserId: bob.id, signal: 'candidate', payload: candidates });
    const ice = await bobSocket.waitFor('call.signal', (frame) => frame.signal === 'candidate');
    // Both candidates survive: dropping one is how a call silently fails to connect
    // over one particular network path.
    expect(ice.payload.candidates).toEqual(candidates.candidates);

    const answer = { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n', type: 'answer' };
    signal(bobSocket, { callId, toUserId: alice.id, signal: 'answer', payload: answer });
    const back = await aliceSocket.waitFor('call.signal', (frame) => frame.signal === 'answer');
    expect(back.fromUserId).toBe(bob.id);
    expect(back.payload.sdp).toBe(answer.sdp);

    // Device state travels as data, never as media: the server sees no stream.
    signal(bobSocket, { callId, toUserId: alice.id, signal: 'mute', payload: { audio: true, screen: false } });
    const mute = await aliceSocket.waitFor('call.signal', (frame) => frame.signal === 'mute');
    expect(mute.payload).toMatchObject({ audio: true, screen: false });

    // Nothing above was refused, which is the actual assertion that the relay is
    // authorising rather than silently dropping.
    expect(aliceSocket.all('error')).toEqual([]);
    expect(bobSocket.all('error')).toEqual([]);
  });

  it('refuses every unauthorised signalling frame and keeps the socket open', async () => {
    harness = await boot();
    const group = await trio('deny', { liveCarol: true });
    const { alice, bob, carol, aliceSocket, bobSocket, carolSocket } = group;
    const response = await dial(group);
    const callId = response.call.id;
    // A stranger to the conversation - not merely somebody who has not answered -
    // with a live socket of their own.
    const dave = await harness.register('deny_dave');
    const daveSocket = await harness.connectSocket(dave);

    // Somebody who shares no call with them must not be able to reach into it.
    await expectError(daveSocket, { callId, toUserId: alice.id, signal: 'offer', payload: { sdp: 'x', type: 'offer' } }, 'not_in_call');
    // A participant may not signal themselves.
    await expectError(aliceSocket, { callId, toUserId: alice.id, signal: 'offer', payload: { sdp: 'x', type: 'offer' } }, 'self_signal');
    // carol was rung and has not answered: she may receive an offer, but she cannot
    // start sending them before she has accepted.
    await expectError(carolSocket, { callId, toUserId: alice.id, signal: 'offer', payload: { sdp: 'x', type: 'offer' } }, 'call_not_answered');
    // An unknown kind is not passed through to a peer's RTCPeerConnection.
    await expectError(aliceSocket, { callId, toUserId: bob.id, signal: 'sdp', payload: {} }, 'invalid_signal');
    // Shape checks on the otherwise-opaque blobs: no empty SDP, no wrong type.
    await expectError(aliceSocket, { callId, toUserId: bob.id, signal: 'offer', payload: { sdp: '', type: 'offer' } }, 'bad_description');
    await expectError(aliceSocket, { callId, toUserId: bob.id, signal: 'offer', payload: { sdp: 'v=0', type: 'answer' } }, 'invalid_description_type');
    // A flood of candidates in one frame is refused rather than relayed as-is.
    const tooMany = Array.from({ length: 61 }, (_, i) => ({ candidate: `candidate:${i} udp 1 10.0.0.1 5000 typ host` }));
    await expectError(aliceSocket, { callId, toUserId: bob.id, signal: 'candidate', payload: { candidates: tooMany } }, 'bad_candidates');
    // A call id that does not exist is not a way to probe the relay.
    await expectError(aliceSocket, { callId: crypto.randomUUID(), toUserId: bob.id, signal: 'offer', payload: { sdp: 'v=0', type: 'offer' } }, 'no_call');

    // Bob walks out of the group call, and a person who left may not push an offer
    // back into it from the doorway.
    const declined = await bob.client.post(`/api/calls/${callId}/decline`, {});
    expect(declined.__status).toBe(200);
    expect(declined.ended).toBe(false);
    await expectError(bobSocket, { callId, toUserId: carol.id, signal: 'offer', payload: { sdp: 'v=0', type: 'offer' } }, 'call_left');
    // And nobody may signal into a call the target refused.
    await expectError(aliceSocket, { callId, toUserId: bob.id, signal: 'offer', payload: { sdp: 'v=0', type: 'offer' } }, 'peer_unavailable');
    // A frame naming a conversation the sender is not in cannot even get this far,
    // so the call id itself is not an authorisation check.

    // All of that was refused without damaging anything: the call is still ringing,
    // and carol is still in it.
    expect(callRow(callId).state).toBe('ringing');
    for (const socket of [aliceSocket, bobSocket, carolSocket, daveSocket]) {
      const id = crypto.randomUUID();
      socket.send({ type: 'ping', id });
      expect((await socket.waitFor('pong', (f) => f.ref === id)).ref).toBe(id);
    }

    // Once the call is over, signalling to it is over too.
    await alice.client.post(`/api/calls/${callId}/end`, {});
    await carolSocket.waitFor('call.ended', (f) => f.call?.id === callId);
    await expectError(aliceSocket, { callId, toUserId: carol.id, signal: 'offer', payload: { sdp: 'v=0', type: 'offer' } }, 'call_over');
  });

  it('stops a call before anything is written when blocks or privacy forbid it', async () => {
    harness = await boot();
    const { alice, bob, thread } = await pair('gate');
    const before = harness.store.get('SELECT COUNT(*) AS n FROM calls').n;

    await bob.client.put('/api/me/privacy', { callsEnabled: false });
    const off = await alice.client.post(`/api/conversations/${thread}/calls`, { mode: 'audio' });
    expect(off.__status).toBe(403);
    expect(off.error.code).toBe('calls_disabled');
    expect(harness.store.get('SELECT COUNT(*) AS n FROM calls').n).toBe(before);

    await bob.client.put('/api/me/privacy', { callsEnabled: true });
    await bob.client.post('/api/block', { userId: alice.id });
    const blocked = await alice.client.post(`/api/conversations/${thread}/calls`, { mode: 'audio' });
    expect(blocked.__status).toBe(403);
    expect(blocked.error.code).toBe('blocked');
    // Not one participant row either: a refused call must not be half-written.
    expect(harness.store.get('SELECT COUNT(*) AS n FROM call_participants').n).toBe(0);

    // A stranger cannot start a call into somebody else's conversation.
    const carol = await harness.register('gate_carol');
    const foreign = await carol.client.post(`/api/conversations/${thread}/calls`, { mode: 'audio' });
    expect(foreign.__status).toBe(404);
    expect(foreign.error.code).toBe('no_conversation');

    // And the mode is validated, not assumed.
    const weird = await alice.client.post(`/api/conversations/${thread}/calls`, { mode: 'hologram' });
    expect(weird.__status).toBe(400);
    expect(weird.error.code).toBe('invalid_call_mode');
  });

  it('allows one call per conversation, and a second call in another', async () => {
    harness = await boot();
    const { alice, thread } = await pair('solo');
    const carol = await harness.register('solo_carol');
    await harness.becomeFriends(alice, carol);
    const other = (await alice.client.post('/api/conversations', { otherUserId: carol.id })).conversation.id;

    const first = await dial({ alice, thread });
    const second = await alice.client.post(`/api/conversations/${thread}/calls`, { mode: 'video' });
    expect(second.__status).toBe(409);
    expect(second.error.code).toBe('call_in_progress');

    // The rule is per conversation, so a developer juggling two calls is refused on
    // the one that already has a call, not on both.
    const parallel = await alice.client.post(`/api/conversations/${other}/calls`, { mode: 'video' });
    expect(parallel.__status).toBe(201);
    expect(parallel.call.mode).toBe('video');
    expect(harness.store.get("SELECT COUNT(*) AS n FROM calls WHERE state IN ('ringing','active')").n).toBe(2);

    await alice.client.post(`/api/calls/${first.call.id}/end`, {});
    expect((await dial({ alice, thread }, 'audio')).call.mode).toBe('audio');
  });

  it('ends a direct call that is declined, and carries on for a group', async () => {
    harness = await boot();
    const direct = await pair('decl');
    const ringing = await dial(direct);
    const declined = await direct.bob.client.post(`/api/calls/${ringing.call.id}/decline`, {});
    expect(declined.__status).toBe(200);
    expect(declined.ended).toBe(true);
    expect(declined.call.state).toBe('declined');
    const notice = await direct.aliceSocket.waitFor('call.ended', (f) => f.call?.state === 'declined');
    expect(notice.reason).toBe('declined');

    const group = await quad('declg');
    const ringing2 = await dial(group);
    const no = await group.bob.client.post(`/api/calls/${ringing2.call.id}/decline`, {});
    expect(no.ended).toBe(false);
    expect(no.call.state).toBe('ringing');
    expect((await group.aliceSocket.waitFor('call.declined', (f) => f.userId === group.bob.id)).call.id).toBe(ringing2.call.id);

    // The other invitee can still answer, and answering starts the call.
    const accepted = await group.carol.client.post(`/api/calls/${ringing2.call.id}/accept`, {});
    expect(accepted.__status).toBe(200);
    expect(accepted.call.state).toBe('active');
    const answered = await group.aliceSocket.waitFor('call.answered', (f) => f.userId === group.carol.id);
    expect(answered.becameActive).toBe(true);
    expect(answered.from).toMatchObject({ id: group.carol.id });

    // Someone who already answered may not decline it afterwards.
    const late = await group.carol.client.post(`/api/calls/${ringing2.call.id}/decline`, {});
    expect(late.__status).toBe(409);
    expect(late.error.code).toBe('already_answered');
    const alsoJoined = await group.dave.client.post(`/api/calls/${ringing2.call.id}/accept`, {});
    expect(alsoJoined.call.state).toBe('active');

    // The organizer leaving a group call that still has two people in it does not
    // end it for them - only running out of people does.
    const organizerLeft = await group.alice.client.post(`/api/calls/${ringing2.call.id}/end`, {});
    expect(organizerLeft.ended).toBe(false);
    expect(organizerLeft.call.state).toBe('active');
    expect((await group.daveSocket.waitFor('call.participant_left', (f) => f.userId === group.alice.id)).call.state).toBe('active');
    const lastOne = await group.carol.client.post(`/api/calls/${ringing2.call.id}/end`, {});
    expect(lastOne.ended).toBe(true);
    expect(lastOne.call.state).toBe('ended');
    // The one person left is told it is over rather than stared at a dead panel.
    expect((await group.daveSocket.waitFor('call.ended', (f) => f.call?.state === 'ended')).userId).toBe(group.carol.id);
  });

  it('reports an offline callee as unreachable instead of ringing a dead socket', async () => {
    harness = await boot();
    const alice = await harness.register('dark_alice');
    const bob = await harness.register('dark_bob');
    await harness.becomeFriends(alice, bob);
    const aliceSocket = await harness.connectSocket(alice);
    const thread = (await alice.client.post('/api/conversations', { otherUserId: bob.id })).conversation.id;

    // bob has no socket at all, so there is nothing to ring.
    const response = await alice.client.post(`/api/conversations/${thread}/calls`, { mode: 'audio' });
    expect(response.__status).toBe(201);
    expect(response.ringing).toEqual([bob.id]);
    expect(response.unreachable).toEqual([bob.id]);
    expect(aliceSocket.all('call.incoming')).toEqual([]);
    const callId = response.call.id;

    // Only a live socket can be signalled, so an offer to bob is refused outright
    // rather than vanishing while the caller waits for a connection.
    await expectError(aliceSocket, { callId, toUserId: bob.id, signal: 'offer', payload: { sdp: 'v=0', type: 'offer' } }, 'peer_offline');

    // Giving up before anybody answers is the caller's own right, and nobody else's.
    const notYours = await bob.client.post(`/api/calls/${callId}/cancel`, {});
    expect(notYours.__status).toBe(403);
    expect(notYours.error.code).toBe('not_your_call');
    const canceled = await alice.client.post(`/api/calls/${callId}/cancel`, {});
    expect(canceled.__status).toBe(200);
    expect(canceled.call.state).toBe('canceled');
    expect((await aliceSocket.waitFor('call.ended', (f) => f.call?.state === 'canceled')).reason).toBe('canceled');
    // And a canceled call cannot be rung into again by the timeout that was armed.
    await new Promise((resolve) => setTimeout(resolve, harness.config.rtc.callTimeoutMs - 500));
    expect(callRow(callId).state).toBe('canceled');
  }, LONG);

  it('keeps a group call running when one peer drops, and does not announce it as over', async () => {
    harness = await boot();
    const group = await trio('dropg');
    const { alice, bob, carol, aliceSocket, bobSocket } = group;
    const response = await dial(group);
    const callId = response.call.id;
    await bob.client.post(`/api/calls/${callId}/accept`, {});
    await aliceSocket.waitFor('call.answered', (f) => f.userId === bob.id);

    // carol joins over a connection that can be killed without a close frame, which
    // is what a crashed process or a yanked cable looks like to a server.
    const carolRaw = await rawOnline(carol);
    signal(aliceSocket, { callId, toUserId: carol.id, signal: 'offer', payload: { sdp: 'v=0 group', type: 'offer' } });
    carolRaw.vanish();
    await rawOffline(carol);

    const left = await aliceSocket.waitFor('call.participant_left', (f) => f.userId === carol.id);
    expect(left.call.id).toBe(callId);
    expect(left.call.state).toBe('active');
    // The brief's "network failures" case: two people still talking must not be told
    // the call ended, and the row must not be finished.
    expect(aliceSocket.all('call.ended')).toEqual([]);
    expect(bobSocket.all('call.ended')).toEqual([]);
    expect(callRow(callId).state).toBe('active');
    expect(harness.instance.calls.participants(callId).find((p) => p.userId === carol.id).state).toBe('left');

    // Signalling between the survivors still works after somebody else dropped.
    signal(aliceSocket, { callId, toUserId: bob.id, signal: 'offer', payload: { sdp: 'v=0 survivor', type: 'offer' } });
    const frame = await bobSocket.waitFor('call.signal', (f) => f.fromUserId === alice.id);
    expect(frame.payload.sdp).toBe('v=0 survivor');
    // The peer who is gone is not silently re-added either.
    await expectError(bobSocket, { callId, toUserId: carol.id, signal: 'offer', payload: { sdp: 'v=0', type: 'offer' } }, 'peer_unavailable');

    await alice.client.post(`/api/calls/${callId}/end`, {});
    expect(callRow(callId).state).toBe('ended');
  });

  it('gives a dropped peer one timeout window to come back before writing the call off', async () => {
    harness = await boot();
    const { alice, bob, aliceSocket, thread } = await pair('blip', { liveBob: false });
    const bobRaw = await rawOnline(bob);
    const response = await dial({ alice, thread });
    const callId = response.call.id;
    expect(response.unreachable).toEqual([]);
    await bob.client.post(`/api/calls/${callId}/accept`, {});
    await aliceSocket.waitFor('call.answered', (f) => f.userId === bob.id);

    // bob's machine loses the network. Nothing else happens - no hang-up, no
    // timeout from the client.
    bobRaw.vanish();
    await rawOffline(bob);

    const left = await aliceSocket.waitFor('call.participant_left', {
      matches: (f) => f.userId === bob.id,
      timeout: 5000,
    });
    // A one-person call is not ended on the spot: the other half of a two-person
    // call may be back in seconds, with its media still up.
    expect(left.call.state).toBe('active');
    expect(callRow(callId).state).toBe('active');

    // Nobody came back, so the server finishes it itself.
    const ended = await aliceSocket.waitFor('call.ended', {
      matches: (f) => f.call?.id === callId,
      timeout: harness.config.rtc.callTimeoutMs + 5000,
    });
    expect(ended.call.state).toBe('ended');
    expect(ended.reason).toBe('connection lost');
    expect(callRow(callId)).toMatchObject({ state: 'ended', end_reason: 'connection lost' });
  }, LONG);

  it('puts a reconnecting developer back into the call they were dropped from', async () => {
    harness = await boot();
    const { alice, bob, aliceSocket, thread } = await pair('rejoin', { liveBob: false });
    const response = await dial({ alice, thread });
    const callId = response.call.id;

    // bob answers over a socket that can be killed without saying goodbye.
    const bobRaw = await rawOnline(bob);
    await bob.client.post(`/api/calls/${callId}/accept`, {});
    await aliceSocket.waitFor('call.answered', (f) => f.userId === bob.id);
    // Signalling works while the raw socket is up, so the drop below is the only
    // thing that changes the outcome.
    signal(aliceSocket, { callId, toUserId: bob.id, signal: 'offer', payload: { sdp: 'v=0 before the drop', type: 'offer' } });

    bobRaw.vanish();
    await rawOffline(bob);
    await aliceSocket.waitFor('call.participant_left', (f) => f.userId === bob.id);
    expect(harness.instance.calls.participants(callId).find((p) => p.userId === bob.id).state).toBe('left');

    // The same app, back up. Signing in again must restore the call rather than
    // leave bob looking at nothing while alice is still waiting for them.
    const bobSocket = await harness.connectSocket(bob);
    const active = await bobSocket.waitFor('call.active', (f) => f.call?.id === callId);
    expect(active.call.state).toBe('active');
    expect(active.participants.find((p) => p.userId === bob.id).state).toBe('joined');
    expect((await aliceSocket.waitFor('call.joined', (f) => f.userId === bob.id)).call.id).toBe(callId);

    // Signalling resumes in both directions, which is the whole point: a reconnect
    // that restored the row but not the participant's state would have every
    // candidate refused with `call_left` forever.
    const answerId = signal(bobSocket, { callId, toUserId: alice.id, signal: 'answer', payload: { sdp: 'v=0 from bob', type: 'answer' } });
    const answer = await aliceSocket.waitFor('call.signal', (f) => f.signal === 'answer' && f.fromUserId === bob.id);
    expect(answer.payload.sdp).toBe('v=0 from bob');
    expect(aliceSocket.all('error').filter((f) => f.ref === answerId)).toEqual([]);
    expect(bobSocket.all('error')).toEqual([]);

    // And the window armed when bob dropped must not still fire behind them.
    await new Promise((resolve) => setTimeout(resolve, harness.config.rtc.callTimeoutMs + 800));
    expect(callRow(callId).state).toBe('active');
    expect(aliceSocket.all('call.ended').filter((f) => f.call?.id === callId)).toEqual([]);
    expect(bobSocket.all('call.ended').filter((f) => f.call?.id === callId)).toEqual([]);
  }, LONG);

  it('does not leave anybody in a call that died with the server', async () => {
    harness = await boot();
    const { alice, bob, thread } = await pair('boot');
    const response = await dial({ alice, thread });
    await bob.client.post(`/api/calls/${response.call.id}/accept`, {});
    expect(callRow(response.call.id).state).toBe('active');

    // A restart clears presence, sockets and timers. Rows claiming a live call
    // would otherwise be handed back to the next client as a call it is not in.
    await harness.restart();
    expect(callRow(response.call.id)).toMatchObject({ state: 'failed', end_reason: 'server restarted' });

    const aliceAgain = await harness.login('boot_alice');
    const current = await aliceAgain.client.get('/api/calls/current');
    expect(current.__status).toBe(200);
    expect(current.call).toBe(null);
    const history = await aliceAgain.client.get(`/api/conversations/${thread}/calls`);
    expect(history.items[0]).toMatchObject({ id: response.call.id, state: 'failed' });
    expect(history.items[0].participants.map((p) => p.state)).toEqual(['left', 'left']);
    // Sign-in carries no phantom call, so the client shows nothing rather than a
    // call panel that can never connect.
    const socket = await harness.connectSocket(aliceAgain);
    expect(socket.all('call.active')).toEqual([]);
    expect(socket.ready.rtc).toMatchObject({ turnConfigured: false });
  });

  it('hands a configured TURN relay to the client, and pages call history by membership', async () => {
    // The only test in this file where a relay exists, so the loopback caveat is
    // explicit: nothing here can prove symmetric-NAT connectivity either way.
    harness = await boot({ env: { LINK_TURN_URL: 'turn:relay.example.com:3478', LINK_TURN_USERNAME: 'relay-user', LINK_TURN_CREDENTIAL: 'relay-secret' } });
    const { alice, bob, thread } = await pair('turn');
    const response = await dial({ alice, thread });
    expect(response.relayWarning).toBe(null);
    // The relay credential goes to an authenticated caller over its own socket and
    // is never baked into the app bundle. Without it the client cannot connect on a
    // symmetric-NAT network, which is most home and office networks.
    expect(alice.socket.ready.rtc).toMatchObject({ turnConfigured: true });
    expect(alice.socket.ready.rtc.iceServers).toEqual(expect.arrayContaining([
      expect.objectContaining({ urls: ['turn:relay.example.com:3478'], username: 'relay-user', credential: 'relay-secret' }),
    ]));

    const stranger = await harness.register('turn_carol');
    const paged = await alice.client.get(`/api/conversations/${thread}/calls`);
    expect(paged.items.map((item) => item.id)).toEqual([response.call.id]);
    expect(paged.items[0].participants).toHaveLength(2);
    const refused = await stranger.client.get(`/api/conversations/${thread}/calls`);
    expect(refused.__status).toBe(404);
    expect(refused.error.code).toBe('no_conversation');

    // The callee hanging up ends a two-person call, and records who said why.
    const ended = await bob.client.post(`/api/calls/${response.call.id}/end`, { reason: 'done' });
    expect(ended.call).toMatchObject({ state: 'ended', endReason: 'done' });
    const news = await alice.socket.waitFor('call.ended', (f) => f.call?.id === response.call.id);
    expect(news.userId).toBe(bob.id);
    // Ending it twice is not an error a client has to guard against.
    const twice = await bob.client.post(`/api/calls/${response.call.id}/end`, {});
    expect(twice.__status).toBe(200);
    expect(twice.ended).toBe(false);
  });
});

/**
 * A runtime without `node:sqlite` and a standards-compliant WebSocket client
 * cannot test any of this, so the skip is reported with its reason instead of
 * looking like a pass.
 */
describe.runIf(SKIP)('NovaLink Live calls', () => {
  it(`skipped on this runtime: ${SKIP_REASON}`, () => {
    expect(SKIP).toBe(true);
  });
});
