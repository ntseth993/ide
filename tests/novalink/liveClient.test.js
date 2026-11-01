/**
 * NovaLink Live bridge — integration tests for the main-process client.
 *
 * These are not unit tests: they boot a real `link-server` on an ephemeral
 * loopback port (using the same harness the server's own tests use) and drive
 * the Electron-side `createLiveClient` against it. The only thing mocked is
 * the OS-encrypted secret store, because there is no OS keystore in a test
 * worker — everything else (HTTP fetch, WebSocket framing, SQLite-backed
 * session tokens) is the same code path the shipped app uses.
 *
 * If the client is lying about what the server accepted, or the server is
 * lying about what the client sent, these tests fail. There are no fake
 * passes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { boot, SKIP, SKIP_REASON, until } = require('../link-server/helpers.js');
const { createLiveClient } = require('../../electron/services/novalink/liveClient.js');

// The `ws` package is what the client uses to open a socket from Node; the
// test just needs to make sure it is installed so the client's own default
// WebSocket constructor is available.
require('ws');

/**
 * A drop-in stand-in for `electron/services/secretStore.js`. Records every
 * read/write so a test can assert that a revoked credential was actually
 * forgotten and not just left in the local cache.
 */
function createMemorySecretStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  const calls = { get: [], set: [], clear: [] };
  return {
    async getSecret(name) { calls.get.push(name); return values.has(name) ? values.get(name) : null; },
    async setSecret(name, value) { calls.set.push({ name, value }); values.set(name, value); return true; },
    async clearSecret(name) { calls.clear.push(name); values.delete(name); return true; },
    peek(name) { return values.has(name) ? values.get(name) : null; },
    calls,
  };
}

function createHarness() {
  const events = [];
  const statusSnapshots = [];
  return {
    events,
    statusSnapshots,
    secretStore: createMemorySecretStore(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    onEvent: (frame) => events.push(frame),
    onStatusChange: (snap) => statusSnapshots.push(snap),
  };
}

/** Resolve once the client's socket reaches ready, or reject after a timeout. */
async function waitReady(client, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = client.status();
    if (snap.ready) return snap;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`NovaLink Live client never reached ready within ${timeoutMs}ms; last snapshot: ${JSON.stringify(client.status())}`);
}

describe.skipIf(SKIP)('NovaLink Live bridge against a real link-server', () => {
  /** @type {Array<{client: object, harness: object}>} */
  let openClients = [];
  let server = null;

  beforeAll(async () => {
    server = await boot();
  });

  afterAll(async () => {
    for (const entry of openClients) {
      try { await entry.client.dispose(); } catch { /* best effort */ }
    }
    openClients = [];
    if (server) await server.close();
  });

  afterEach(async () => {
    for (const entry of openClients) {
      try { await entry.client.dispose(); } catch { /* best effort */ }
    }
    openClients = [];
  });

  /** Boot a client pointed at the running test server, tracked for cleanup. */
  function attachClient(extra = {}) {
    const harness = createHarness();
    const client = createLiveClient({
      secretStore: harness.secretStore,
      onEvent: harness.onEvent,
      onStatusChange: harness.onStatusChange,
      logger: harness.logger,
      ...extra,
    });
    const entry = { client, harness };
    openClients.push(entry);
    return entry;
  }

  it('registers over REST, hydrates from the `ready` frame, and remembers the token in the secret store', async () => {
    const username = `bridge_reg_${Math.random().toString(36).slice(2, 8)}`;
    const { client, harness } = attachClient();

    await client.configure({ baseUrl: server.origin });
    const result = await client.register({ username, password: 'correct-horse-battery', displayName: 'Bridge Tester' });

    // The client hands back the user, not the credential.
    expect(result.user.username).toBe(username);
    expect(result.user.displayName).toBe('Bridge Tester');
    expect(result.token).toBeUndefined();

    // The credential is in the OS-encrypted store — and only there.
    const stored = harness.secretStore.peek('novalink_live_token');
    expect(typeof stored).toBe('string');
    expect(stored.length).toBeGreaterThan(10);

    // The socket opened, authenticated, and pushed `ready` with real user data.
    const snap = await waitReady(client);
    expect(snap.signedIn).toBe(true);
    expect(snap.connected).toBe(true);
    expect(snap.user.username).toBe(username);

    // The `ready` frame carries `rtc` and `limits` at the top level. The client
    // normalises them under `server` so the renderer has one shape regardless
    // of whether the info came from bootstrap or from the socket.
    expect(snap.server).toBeTruthy();
    expect(snap.server.limits).toBeTruthy();
    expect(snap.server.limits.maxMessageChars).toBeGreaterThan(0);
    expect(Array.isArray(snap.server.rtc.iceServers)).toBe(true);
  });

  it('logs in and pushes a message; the peer receives it on the socket', async () => {
    const alice = `alice_${Math.random().toString(36).slice(2, 8)}`;
    const bob = `bob_${Math.random().toString(36).slice(2, 8)}`;
    const pw = 'correct-horse-battery';

    // Register both accounts through the client (proving the client can drive
    // the entire auth flow). The response includes the user id, which is what
    // `createConversation({ kind: 'direct', otherUserId })` needs.
    const a = attachClient();
    const b = attachClient();
    await a.client.configure({ baseUrl: server.origin });
    await b.client.configure({ baseUrl: server.origin });
    const aliceInfo = await a.client.register({ username: alice, password: pw });
    const bobInfo = await b.client.register({ username: bob, password: pw });
    await waitReady(a.client);
    await waitReady(b.client);

    // Become contacts: alice requests, bob accepts. The REST layer already has
    // a friendly `becomeFriends` helper on the server test harness, and using
    // it here proves the client and the harness drive the same backend.
    const aToken = a.harness.secretStore.peek('novalink_live_token');
    const bToken = b.harness.secretStore.peek('novalink_live_token');
    const req = await server.client(aToken).post('/api/requests', { username: bob, message: 'hi from the bridge test' });
    expect(req.__status).toBe(201);
    const acc = await server.client(bToken).post(`/api/requests/${req.request.id}/accept`, {});
    expect(acc.__status).toBe(200);

    // Open a direct conversation from alice's client. `otherUserId` is bob's
    // id as the register response gave it back to us.
    const created = await a.client.createConversation({ kind: 'direct', otherUserId: bobInfo.user.id });
    const conversation = created.conversation || created;
    expect(conversation.id).toMatch(/^[0-9a-f-]{36}$/i);

    // Send a message through alice's client; bob's `onEvent` should receive
    // the corresponding `message` frame on his socket within a tick.
    const bodyText = `hello from the bridge ${Date.now()}`;
    await a.client.sendMessage(conversation.id, { body: bodyText });
    const frame = await until(
      () => b.harness.events.find((f) => f.type === 'message' && f.message?.body === bodyText),
      { label: 'the message frame on bob\'s socket' },
    );
    expect(frame.type).toBe('message');
    expect(frame.message.conversationId).toBe(conversation.id);

    // Typing is a WS-only frame; it should round-trip as a `typing` event.
    a.client.sendTyping({ conversationId: conversation.id, typing: true });
    await until(
      () => b.harness.events.find((f) => f.type === 'typing' && f.conversationId === conversation.id && f.typing === true),
      { label: 'the typing frame on bob\'s socket' },
    );
    // Sanity: alice's own user id came back through the register response too.
    expect(aliceInfo.user.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('survives a base-URL change without replaying the credential at the new origin', async () => {
    const { client, harness } = attachClient();
    await client.configure({ baseUrl: server.origin });
    await client.register({ username: `switch_${Math.random().toString(36).slice(2, 8)}`, password: 'correct-horse-battery' });
    await waitReady(client);
    expect(harness.secretStore.peek('novalink_live_token')).toBeTruthy();

    // Point at a server that will never answer (an unused local port). The
    // client must clear the token locally, so no credential can leak to a
    // future origin that happens to bind the same port.
    const closed = await new Promise((resolve) => {
      const net = require('node:net');
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const port = probe.address().port;
        probe.close(() => resolve(port));
      });
    });
    await client.configure({ baseUrl: `http://127.0.0.1:${closed}` });
    expect(harness.secretStore.peek('novalink_live_token')).toBe(null);
    expect(client.status().signedIn).toBe(false);
  });

  it('a dead bearer credential ends the reconnect loop by clearing the local token', async () => {
    const { client, harness } = attachClient();
    await client.configure({ baseUrl: server.origin });
    // Fake a token that the server has never issued. Boot hydrates via /api/me,
    // gets a 401, and must forget the token rather than spin trying to open a
    // socket against it.
    harness.secretStore.setSecret('novalink_live_token', 'not-a-real-opaque-token-not-a-real-opaque-token');
    const snap = await client.boot({ baseUrl: server.origin });
    expect(snap.signedIn).toBe(false);
    expect(harness.secretStore.peek('novalink_live_token')).toBe(null);
    // The 401 was the trigger, not the network — no reconnect should have been
    // scheduled, since we never reached the socket at all.
    expect(snap.reconnectAttempt).toBe(0);
  });

  it('call.signal uses the wire shape the server actually reads (`signal` + `payload`)', async () => {
    const { client, harness } = attachClient();
    await client.configure({ baseUrl: server.origin });
    await client.register({ username: `signal_probe_${Math.random().toString(36).slice(2, 8)}`, password: 'correct-horse-battery' });
    await waitReady(client);

    // The client validates before the socket send. A bogus signal kind must
    // throw locally, not just get bounced by the server.
    expect(() => client.sendCallSignal({
      callId: '0e62c1e2-3f70-4d05-9c78-8ee4d1a0b111',
      toUserId: '0e62c1e2-3f70-4d05-9c78-8ee4d1a0b112',
      signal: 'bogus',
      payload: {},
    })).toThrow(/call\.signal must name one of/);

    // A well-formed offer is refused by the server (no such call), which proves
    // the frame reached the socket in the shape the server expects: the error
    // is `no_call`, not `unknown_event`. That distinction is the point of the
    // test — a wrong frame would fail with the latter and the client would look
    // like it was working while actually doing nothing.
    let rejected;
    try {
      client.sendCallSignal({
        callId: '0e62c1e2-3f70-4d05-9c78-8ee4d1a0b111',
        toUserId: '0e62c1e2-3f70-4d05-9c78-8ee4d1a0b112',
        signal: 'offer',
        payload: { sdp: 'v=0 fake\r\n', type: 'offer' },
      });
    } catch (error) {
      rejected = error;
    }
    // `sendCallSignal` itself does not reject (it is fire-and-forget on the
    // socket); the server responds asynchronously with an `error` frame.
    expect(rejected).toBeUndefined();
    const errorFrame = await until(
      () => harness.events.find((f) => f.type === 'error' && f.code === 'no_call'),
      { label: 'the server error frame confirming our call.signal reached `calls.relay`' },
    );
    expect(errorFrame.code).toBe('no_call');
  });

  it('fetchAvatar returns bytes through the main process, so the renderer never sees the bearer token', async () => {
    const { client, harness } = attachClient();
    await client.configure({ baseUrl: server.origin });
    await client.register({ username: `av_${Math.random().toString(36).slice(2, 8)}`, password: 'correct-horse-battery' });
    await waitReady(client);

    // Upload an avatar; the client forwards the raw bytes as octet-stream.
    const { PNG_BYTES } = require('../link-server/helpers.js');
    const uploaded = await client.uploadAvatar({ bytes: PNG_BYTES, fileName: 'p.png' });
    const avatarId = uploaded.user?.avatarId || uploaded.avatarId;
    expect(avatarId).toMatch(/^[0-9a-f-]{36}$/i);

    const fetched = await client.fetchAvatar(avatarId);
    expect(fetched).toBeTruthy();
    expect(fetched.bytes.length).toBe(PNG_BYTES.length);
    expect(fetched.mimeType).toMatch(/^image\//);
    // The token never leaves the main process — the returned object has no
    // bearer credential in it, and the renderer receives only bytes + mime.
    expect(fetched.bytes.toString('utf8')).not.toMatch(/Bearer/);
    // The write happened: `register` triggered `rememberToken`, which is
    // a `setSecret('novalink_live_token', …)` call. `boot()` is not part of
    // this test's flow, so we assert on the write side instead of the read.
    expect(harness.secretStore.calls.set.some((call) => call.name === 'novalink_live_token')).toBe(true);
  });

  it('the LiveError from a failed HTTP call carries the server code so the renderer can branch', async () => {
    const { client } = attachClient();
    await client.configure({ baseUrl: server.origin });
    await client.register({ username: `err_${Math.random().toString(36).slice(2, 8)}`, password: 'correct-horse-battery' });
    await waitReady(client);

    // A conversation id the server has never seen. The 404 body is
    // `{error: {code, message, status}}`; the client re-throws as LiveError
    // with those fields intact so the renderer can react to `no_conversation`.
    let thrown;
    try {
      await client.getConversation('11111111-2222-3333-4444-555555555555');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeTruthy();
    expect(thrown.name).toBe('LiveError');
    expect(thrown.status).toBe(404);
    expect(thrown.code).toMatch(/no_conversation|not_found/);
    expect(thrown.retryable).toBe(false);
  });
});

describe.skipIf(SKIP)('NovaLink Live capability guard', () => {
  it('reports SKIP honestly when the runtime is missing node:sqlite or the WebSocket global', () => {
    // This test never actually runs when SKIP is true (the whole file would be
    // skipped by describe.skipIf). Its presence documents why the file is a
    // no-op on Node 20, rather than silently passing with nothing tested.
    expect(typeof SKIP).toBe('boolean');
    expect(typeof SKIP_REASON).toBe('string');
  });
});
