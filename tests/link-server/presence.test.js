/**
 * Presence (phase 2, the real-time half).
 *
 * The brief insists that presence must not come from app start/stop events alone.
 * These tests hold the server to that: a live socket, a client that reports its own
 * idle state, a socket that is open but silent, and a connection that dies without a
 * goodbye are four different situations, and each is checked from the point of view
 * of the person on the other end.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { boot, CAPABILITY, SKIP, SKIP_REASON, until, rawClient } from './helpers';

const require = createRequire(import.meta.url);
const { createHub } = require('../../link-server/hub');

describe.runIf(!SKIP)('NovaLink Live presence', () => {
  let harness = null;

  afterEach(async () => {
    if (harness) await harness.close();
    harness = null;
  });

  it('is running on a capable runtime (Node ' + CAPABILITY.node + ')', () => {
    expect(CAPABILITY.supported, SKIP_REASON).toBe(true);
  });

  it('shows a signed-in developer online to their contacts, on the wire and in the directory', async () => {
    harness = await boot();
    const alice = await harness.register('live_alice');
    const bob = await harness.register('live_bob');
    await harness.becomeFriends(alice, bob);

    // Bob is listening first: delivery over the socket is at-most-once, so a test
    // that connected him afterwards would be testing the missed event instead.
    const bobSocket = await harness.connectSocket(bob);
    const aliceSocket = await harness.connectSocket(alice);
    expect(aliceSocket.ready.type).toBe('ready');

    const pushed = await bobSocket.waitFor('presence', (frame) => frame.userId === alice.id);
    expect(pushed.status).toBe('online');

    const directory = await bob.client.get('/api/contacts');
    const seen = directory.items.find((contact) => contact.username === 'live_alice');
    expect(seen.status).toBe('online');
    expect(typeof seen.lastActiveAt).toBe('number');
    // Device counts are the account owner's own information, not a contact's.
    expect(seen.deviceCount).toBe(0);
    const own = await alice.client.get('/api/me');
    expect(own.presence).toMatchObject({ status: 'online', deviceCount: 1 });

    // And the server's own view of "how many people are connected right now".
    expect((await harness.anon.get('/health')).liveSockets).toBe(2);
  });

  it('believes a client that reports away or busy, and refuses a status that is not one', async () => {
    harness = await boot();
    const alice = await harness.register('status_alice');
    const bob = await harness.register('status_bob');
    await harness.becomeFriends(alice, bob);
    const bobSocket = await harness.connectSocket(bob);
    const aliceSocket = await harness.connectSocket(alice);
    await bobSocket.waitFor('presence', (frame) => frame.userId === alice.id);

    for (const reported of ['away', 'busy', 'online']) {
      aliceSocket.send({ type: 'presence', status: reported });
      const frame = await bobSocket.waitFor('presence', (message) => message.userId === alice.id && message.status === reported);
      expect(frame.userId).toBe(alice.id);
      expect((await bob.client.get('/api/contacts')).items.find((c) => c.username === 'status_alice').status).toBe(reported);
    }

    // A nonsense status is an error on the sender's socket, not a silent write and
    // not a change of state - and it does not kill the connection.
    const before = bobSocket.log().length;
    aliceSocket.send({ type: 'presence', status: 'asleep' });
    const refused = await aliceSocket.waitFor('error');
    expect(refused.code).toBe('invalid_status');
    expect(aliceSocket.readyState).toBe(globalThis.WebSocket.OPEN);
    expect(bobSocket.log().length).toBe(before);
  });

  it('demotes a socket that is open but silent, which is the suspended-laptop case', async () => {
    // awayMinutes is set to one second through the same override an operator would
    // use; nothing about the code path is different.
    harness = await boot({ config: { presence: { pingMs: 1000, deadMs: 60000, awayMinutes: 1 / 60 } } });
    const alice = await harness.register('idle_alice');
    const bob = await harness.register('idle_bob');
    await harness.becomeFriends(alice, bob);
    const bobSocket = await harness.connectSocket(bob);
    const aliceSocket = await harness.connectSocket(alice);
    await bobSocket.waitFor('presence', (frame) => frame.userId === alice.id && frame.status === 'online');

    // The socket keeps answering pings, so it is not dead - but a pong is not user
    // activity, and after the idle window "connected" has to become "away". The
    // demotion is pushed, not just visible on the next read: a contact watching a
    // green dot must not have to reload to learn the truth.
    const demoted = await bobSocket.waitFor('presence', (frame) => frame.userId === alice.id && frame.status === 'away', { timeout: 3000 });
    expect(demoted.userId).toBe(alice.id);
    const idle = await until(async () => {
      const contact = (await bob.client.get('/api/contacts')).items.find((c) => c.username === 'idle_alice');
      return contact.status === 'away' ? contact : null;
    }, { timeout: 1500, label: 'the idle socket to be read back as away' });
    expect(idle.status).toBe('away');
    expect(aliceSocket.readyState).toBe(globalThis.WebSocket.OPEN);
    // Away is a demotion, not a sign-out: the same socket is still counted live.
    expect((await harness.anon.get('/health')).liveSockets).toBe(2);
  });

  it('"appear offline" hides the truth from everyone but the account itself', async () => {
    harness = await boot();
    const alice = await harness.register('ghost_alice');
    const bob = await harness.register('ghost_bob');
    await harness.becomeFriends(alice, bob);
    const bobSocket = await harness.connectSocket(bob);
    await harness.connectSocket(alice);
    await bobSocket.waitFor('presence', (frame) => frame.userId === alice.id && frame.status === 'online');

    await alice.client.put('/api/me/privacy', { appearOffline: true });
    const hidden = await bobSocket.waitFor('presence', (frame) => frame.userId === alice.id && frame.status === 'offline');
    // A contact must not be able to tell "hiding" from "away": both are offline.
    expect(hidden.lastActiveAt).toBeNull();
    expect((await bob.client.get('/api/contacts')).items.find((c) => c.username === 'ghost_alice')).toMatchObject({
      status: 'offline',
      lastActiveAt: null,
    });

    // The account's own view is exact, because it needs to know what its devices
    // are really doing to render the settings screen honestly.
    const own = await alice.client.get('/api/me');
    expect(own.presence.status).toBe('online');
    expect(own.privacy.appearOffline).toBe(true);

    await alice.client.put('/api/me/privacy', { appearOffline: false });
    await bobSocket.waitFor('presence', (frame) => frame.userId === alice.id && frame.status === 'online');
  });

  it('applies presence visibility to strangers, and keeps last-active as part of the same disclosure', async () => {
    harness = await boot();
    const alice = await harness.register('visible_alice');
    const stranger = await harness.register('visible_stranger');
    const contact = await harness.register('visible_contact');
    await harness.becomeFriends(alice, contact);

    const aliceSocket = await harness.connectSocket(alice);
    const strangerSocket = await harness.connectSocket(stranger);
    await strangerSocket.waitFor('ready');
    expect(aliceSocket.readyState).toBe(globalThis.WebSocket.OPEN);

    // Default: contacts only. Alice's socket is definitely live, so a stranger
    // seeing "offline" is the privacy rule working rather than an absence of data.
    const strangerView = (await stranger.client.get('/api/users/' + alice.id)).user;
    expect(strangerView.status).toBe('offline');
    expect(strangerView.connected).toBe(false);
    const contactView = (await contact.client.get('/api/users/' + alice.id)).user;
    expect(contactView.status).toBe('online');

    // Open to everyone: a stranger can now see the IDE is running.
    await alice.client.put('/api/me/privacy', { presenceVisibleTo: 'everyone' });
    expect((await stranger.client.get('/api/users/' + alice.id)).user.status).toBe('online');

    // Closed to nobody: not even a contact sees more than offline.
    await alice.client.put('/api/me/privacy', { presenceVisibleTo: 'nobody' });
    expect((await contact.client.get('/api/users/' + alice.id)).user.status).toBe('offline');

    // Last-active is a presence signal too, so it is switched off on its own and
    // never leaks while status is hidden.
    await alice.client.put('/api/me/privacy', { presenceVisibleTo: 'contacts' });
    expect((await contact.client.get('/api/users/' + alice.id)).user.lastActiveAt).not.toBeNull();
    await alice.client.put('/api/me/privacy', { showLastActive: false });
    const silent = await contact.client.get('/api/users/' + alice.id);
    expect(silent.user.status).toBe('online');
    expect(silent.user.lastActiveAt).toBeNull();
  });

  it('counts devices, and signing out of one leaves the others working', async () => {
    harness = await boot();
    const alice = await harness.register('multi_alice');
    const bob = await harness.register('multi_bob');
    await harness.becomeFriends(alice, bob);
    const bobSocket = await harness.connectSocket(bob);

    const laptop = await harness.login('multi_alice', { deviceLabel: 'laptop' });
    const desktop = await harness.login('multi_alice', { deviceLabel: 'desktop' });
    const laptopSocket = await harness.connectSocket(laptop);
    const desktopSocket = await harness.connectSocket(desktop);
    await bobSocket.waitFor('presence', (frame) => frame.userId === alice.id && frame.status === 'online');

    // `sessions` is every credential the server is holding; `deviceCount` is only
    // what is connected at this second. A UI that confuses them shows ghosts.
    expect((await laptop.client.get('/api/me')).sessions).toHaveLength(3);
    expect((await laptop.client.get('/api/me')).presence.deviceCount).toBe(2);

    // Graceful goodbye from one device: still online, because the other is live.
    desktopSocket.close();
    await until(async () => desktopSocket.closedInfo, { label: 'the desktop socket to close' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await bob.client.get('/api/contacts')).items.find((c) => c.username === 'multi_alice').status).toBe('online');

    // Signing out is stronger than closing a window: the session row is gone, the
    // credential stops working, and only that device's socket is dropped.
    await laptopSocket.waitFor('ready');
    const signedOut = await desktop.client.post('/api/logout', {});
    expect(signedOut.__status).toBe(200);
    expect(laptopSocket.readyState).toBe(globalThis.WebSocket.OPEN);
    const staleToken = await desktop.client.get('/api/me');
    expect(staleToken.__status).toBe(401);
    expect(staleToken.error.code).toBe('session_expired');

    // The last device going is what makes the contact look offline - and bob is
    // told, rather than finding out on his next page load.
    const offline = bobSocket.waitFor('presence', (frame) => frame.userId === alice.id && frame.status === 'offline');
    await laptopSocket.close();
    const frame = await offline;
    expect(frame.userId).toBe(alice.id);
    expect((await bob.client.get('/api/contacts')).items.find((c) => c.username === 'multi_alice').status).toBe('offline');
    expect((await harness.anon.get('/health')).liveSockets).toBe(1);
  });

  it('notices a connection that died without saying goodbye', async () => {
    harness = await boot();
    const alice = await harness.register('yanked_alice');
    const bob = await harness.register('yanked_bob');
    await harness.becomeFriends(alice, bob);
    const bobSocket = await harness.connectSocket(bob);

    // A bare TCP client, because the platform client always says goodbye politely.
    const raw = rawClient(harness.port);
    const handshake = await raw.done;
    expect(handshake).toMatch(/^HTTP\/1\.1 101 /);
    await raw.sendText(JSON.stringify({ type: 'auth', token: alice.token, deviceLabel: 'yanked' }));
    await until(async () => (await harness.anon.get('/health')).liveSockets === 2, { label: 'the raw socket to be counted' });
    await bobSocket.waitFor('presence', (frame) => frame.userId === alice.id && frame.status === 'online');

    raw.vanish();

    // The server sees the TCP connection end, detaches the session and re-derives
    // presence. No app-lifecycle event was involved at any point.
    const offline = await bobSocket.waitFor('presence', (frame) => frame.userId === alice.id && frame.status === 'offline');
    expect(offline.status).toBe('offline');
    await until(async () => (await harness.anon.get('/health')).liveSockets === 1, { label: 'the dead session to be dropped' });
    expect((await bob.client.get('/api/contacts')).items.find((c) => c.username === 'yanked_alice').status).toBe('offline');
  });

  it('refuses to talk to a socket that has not authenticated', async () => {
    harness = await boot();
    const alice = await harness.register('authz_alice');

    // Anything before `auth` is a protocol violation, and the socket is closed
    // rather than answered: an unauthenticated peer gets no information.
    const rude = await harness.connectSocket(alice, { autoAuth: false });
    rude.send({ type: 'typing', conversationId: 'nope' });
    await until(async () => rude.closedInfo, { label: 'the socket to be closed' });
    expect(rude.closedInfo.code).toBe(1008);

    // A credential that is not one: closed the same way, with no reason given.
    const forged = await harness.connectSocket({ token: 'not-a-real-session-token-at-all-000000' }, { autoAuth: false });
    forged.send({ type: 'auth', token: 'not-a-real-session-token-at-all-000000' });
    await until(async () => forged.closedInfo, { label: 'the forged socket to be closed' });
    expect(forged.closedInfo.code).toBe(1008);

    // Once authenticated, an unknown event is an error frame and the socket lives.
    const aliceSocket = await harness.connectSocket(alice);
    aliceSocket.send({ type: 'do Something' });
    const unknown = await aliceSocket.waitFor('error');
    expect(unknown.code).toBe('unknown_event');
    expect(aliceSocket.readyState).toBe(globalThis.WebSocket.OPEN);

    // The one thing the socket answers by name, with the client's own ref echoed.
    aliceSocket.send({ type: 'ping', id: 'r-1' });
    expect((await aliceSocket.waitFor('pong')).ref).toBe('r-1');
  });
});

/**
 * The heartbeat policy, as a unit test - because the half-open case it protects
 * against (a connection that stops answering without ever sending a FIN) cannot be
 * produced on loopback, and "the socket was silent for deadMs" must not depend on
 * how fast the test machine happens to be.
 */
describe('NovaLink Live heartbeat policy', () => {
  const SESSION_ID = '11111111-1111-4111-8111-111111111111';
  const USER_ID = '22222222-2222-4222-8222-222222222222';

  class FakeLink {
    constructor(now) {
      this.listeners = {};
      this.readyState = 'open';
      this.isAlive = true;
      this.lastSeenAt = now();
      this.pings = 0;
      this.closeInfo = null;
      this.sent = [];
    }

    on(name, fn) {
      (this.listeners[name] ||= []).push(fn);
    }

    emit(name, value) {
      for (const fn of this.listeners[name] || []) fn(value);
    }

    send(value) {
      this.sent.push(value);
      return true;
    }

    ping() {
      this.pings += 1;
      return true;
    }

    close(code, reason) {
      this.readyState = 'closed';
      this.closeInfo = { code, reason };
      this.emit('close', { code, reason });
    }
  }

  function buildHub({ pingMs = 1000, deadMs = 3000 } = {}) {
    let clock = 1_000_000;
    const now = () => clock;
    const accounts = {
      resolve: () => ({
        session: { id: SESSION_ID, deviceLabel: 'fake' },
        user: { id: USER_ID },
        privacy: { presenceVisibleTo: 'contacts' },
      }),
      listSessions: () => [{ id: SESSION_ID, deviceLabel: 'fake' }],
      rowToUser: () => ({ id: USER_ID, username: 'fake_dev' }),
    };
    const detached = [];
    // Behaves like the real presence module: a session detaches once, and asking
    // again yields nothing. That is what makes "no ghost sessions" testable here.
    const liveSessions = new Set([SESSION_ID]);
    const presence = {
      attach: () => ({}),
      detach: (sessionId) => {
        if (!liveSessions.has(sessionId)) return null;
        liveSessions.delete(sessionId);
        detached.push(sessionId);
        return { sessionId };
      },
      beat: () => {},
      sessionsOf: () => [...liveSessions],
      usersOnline: () => (liveSessions.size ? [USER_ID] : []),
      // The drift detector belongs to presence; this fake has no clock of its own,
      // so it reports no change and the heartbeat assertions stay about the socket.
      drifted: () => [],
      liveCount: () => liveSessions.size,
    };
    const hub = createHub({
      store: {},
      accounts,
      presence,
      connections: {},
      limiter: { take: () => ({ allowed: true }) },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      config: {
        presence: { pingMs, deadMs, awayMinutes: 10 },
        rtc: { iceServers: [] },
        limits: { maxMessageChars: 8000, maxFileBytes: 1024 },
      },
      now,
    });
    const link = new FakeLink(now);
    hub.attachSocket(link);
    link.emit('message', JSON.stringify({ type: 'auth', token: 'anything' }));
    return { hub, link, now: () => clock, advance: (ms) => { clock += ms; }, detached, presence };
  }

  it('probes at pingMs and only drops after a full deadMs of silence', () => {
    const { hub, link, advance, now } = buildHub();
    expect(link.readyState).toBe('open');

    // A pong that arrives one probe later is a healthy connection. Dropping on the
    // first missed ping - which is what the first version did, because the flag was
    // cleared every pass - made deadMs a number nobody actually honoured, and a
    // busy machine could lose a session in one second of scheduling delay.
    for (let pass = 0; pass < 3; pass += 1) {
      advance(1000);
      link.lastSeenAt = now();
      hub.sweep();
    }
    expect(link.readyState).toBe('open');
    expect(link.pings).toBe(3);

    advance(1000);
    hub.sweep();
    expect(link.readyState).toBe('open');

    // Now the silence passes the deadline: the socket goes, with a reason a client
    // can show, and the presence record is detached rather than left as a ghost.
    advance(2500);
    hub.sweep();
    expect(link.closeInfo).toEqual({ code: 1001, reason: 'connection lost' });
  });

  it('treats its own probes as proof of nothing, and detaches a dead session exactly once', () => {
    const { hub, link, advance, detached, presence } = buildHub();
    const seenAt = link.lastSeenAt;
    // Pinging is not the client answering, so a full deadline of unanswered probes
    // must close the socket - and the presence record has to go with it, or the
    // account would look online forever behind a dead connection.
    for (let pass = 0; pass < 4; pass += 1) {
      advance(1000);
      hub.sweep();
    }
    expect(link.pings).toBe(3);
    expect(link.closeInfo).toEqual({ code: 1001, reason: 'connection lost' });
    expect(link.lastSeenAt).toBe(seenAt);
    expect(detached).toEqual([SESSION_ID]);
    expect(presence.liveCount()).toBe(0);
    // Sweeping afterwards must not resurrect it or detach a second time.
    hub.sweep();
    expect(detached).toEqual([SESSION_ID]);
  });
});
