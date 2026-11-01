/**
 * Accounts, profiles, connections, blocks, reports, and the authorization rules
 * around them (phase 2 of the implementation plan).
 *
 * Everything here is asserted against a real server answering real HTTP on
 * loopback. No response is stubbed, and no assertion is "the function was
 * called" — each one checks what the caller actually received or, where it
 * matters, what is in the database.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { boot, CAPABILITY, SKIP, SKIP_REASON } from './helpers';

const PASSWORD = 'correct-horse-battery';

describe.runIf(!SKIP)('NovaLink Live accounts', () => {
  let harness = null;

  afterEach(async () => {
    if (harness) await harness.close();
    harness = null;
  });

  it(`is running on a capable runtime (Node ${CAPABILITY.node})`, () => {
    // Recorded as an assertion so a green run can never be mistaken for coverage
    // on a runtime that skipped the whole file.
    expect(CAPABILITY.supported, SKIP_REASON).toBe(true);
  });

  it('registers an account and hands back a usable credential', async () => {
    harness = await boot();
    const alice = await harness.register('alice_dev');
    expect(alice.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(alice.token.length).toBeGreaterThanOrEqual(32);

    const me = await alice.client.get('/api/me');
    expect(me.__status).toBe(200);
    expect(me.user.username).toBe('alice_dev');
    expect(me.user).not.toHaveProperty('passwordHash');
    expect(me.user).not.toHaveProperty('password_hash');
    expect(me.privacy.presenceVisibleTo).toBe('contacts');
    expect(me.privacy.contactRequestsFrom).toBe('everyone');
    expect(me.server.limits.maxMessageChars).toBeGreaterThan(0);
    expect(me.server.rtc.iceServers.length).toBeGreaterThan(0);
    expect(me.server.rtc.turnConfigured).toBe(false);
    expect(me.server.webSocketPath).toBe('/link');
  });

  it('defaults the display name to the handle instead of refusing the form', async () => {
    harness = await boot();
    // This is the shape a real registration screen submits when somebody leaves
    // the name field empty; it must not come back as a 400.
    const bare = await harness.anon.post('/api/register', { username: 'name_optional', password: PASSWORD });
    expect(bare.__status).toBe(201);
    expect(bare.user.displayName).toBe('name_optional');
    expect(bare.user.bio).toBe('');
  });

  it('never leaks a password hash or a stored token to any client', async () => {
    harness = await boot();
    const response = await harness.anon.post('/api/register', { username: 'no_leaks', password: PASSWORD, displayName: 'No Leaks' });
    expect(response.__status).toBe(201);
    const text = JSON.stringify(response);
    expect(text).not.toContain('scrypt$');
    expect(text.toLowerCase()).not.toContain(PASSWORD.toLowerCase());
    // The token is returned exactly once, at creation. What the database holds is
    // its SHA-256, so a stolen database file is not a list of live sessions.
    const row = harness.store.get('SELECT token_hash FROM sessions WHERE user_id = ?', response.user.id);
    expect(row.token_hash).not.toBe(response.token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const user = harness.store.get('SELECT password_hash FROM users WHERE id = ?', response.user.id);
    expect(user.password_hash.startsWith('scrypt$')).toBe(true);
  });

  it('compares usernames case-insensitively and rejects weak input', async () => {
    harness = await boot();
    const mixed = await harness.anon.post('/api/register', { username: 'CaseSensitive', password: PASSWORD });
    expect(mixed.__status).toBe(201);
    // Stored lowercased: the unique index is NOCASE, and a handle that differs
    // only by case must not be able to impersonate another developer.
    expect(mixed.user.username).toBe('casesensitive');

    const clash = await harness.anon.post('/api/register', { username: 'CASESENSITIVE', password: PASSWORD });
    expect(clash.__status).toBe(409);
    expect(clash.error.code).toBe('username_taken');

    const weak = await harness.anon.post('/api/register', { username: 'weak_sauce', password: 'short' });
    expect(weak.__status).toBe(400);
    expect(weak.error.code).toBe('weak_password');

    for (const bad of ['a', 'has space', 'trailing-', 'd!ngerous']) {
      const response = await harness.anon.post('/api/register', { username: bad, password: PASSWORD });
      expect(response.__status, `"${bad}" should be refused`).toBe(400);
      expect(response.error.code).toBe('invalid_username');
    }
  });

  it('signs in, and says the same thing about a wrong password as an unknown user', async () => {
    harness = await boot();
    const alice = await harness.register('signin_alice');
    const ok = await harness.anon.post('/api/login', { username: 'signin_alice', password: PASSWORD });
    expect(ok.__status).toBe(200);
    expect(ok.user.id).toBe(alice.id);

    const wrongPassword = await harness.anon.post('/api/login', { username: 'signin_alice', password: 'not-the-right-horse' });
    const unknownUser = await harness.anon.post('/api/login', { username: 'nobody_here', password: PASSWORD });
    expect(wrongPassword.__status).toBe(401);
    expect(unknownUser.__status).toBe(401);
    // A login form must not become an account-enumeration endpoint.
    expect(wrongPassword.error).toEqual(unknownUser.error);
  });

  it('locks a credential-stuffing burst and refuses the next attempt', async () => {
    harness = await boot({ env: { LINK_RATE_AUTH_PER_MIN: '3', LINK_AUTH_FAIL_LIMIT: '3' } });
    await harness.register('stuff_target');
    const attempts = [];
    for (let i = 0; i < 6; i += 1) {
      attempts.push(await harness.anon.post('/api/login', { username: 'stuff_target', password: `guessed-${i}-long-enough` }));
    }
    expect(attempts[0].__status).toBe(401);
    expect(attempts.some((a) => a.__status === 429)).toBe(true);
    const refused = attempts.find((a) => a.__status === 429);
    expect(['account_locked', 'rate_limited']).toContain(refused.error.code);

    // Even the correct password is refused while the bucket is closed, which is
    // the point: the lockout has to cost the attacker time.
    const right = await harness.anon.post('/api/login', { username: 'stuff_target', password: PASSWORD });
    expect(right.__status).toBe(429);
  });

  it('requires a credential on protected routes and ignores a credential that is not one', async () => {
    harness = await boot();
    const anonymous = await harness.anon.get('/api/me');
    expect(anonymous.__status).toBe(401);
    const forged = await harness.anon.get('/api/me', { headers: { authorization: 'Bearer not-a-real-session-token-at-all' } });
    expect(forged.__status).toBe(401);
    expect(forged.error.code).toBe('session_expired');
  });

  it('never trusts a user id supplied by the caller', async () => {
    harness = await boot();
    const alice = await harness.register('trust_no_one');
    const bob = await harness.register('trust_target');
    await harness.becomeFriends(alice, bob);

    // The attack the brief names explicitly: a renderer (or a compromised tab)
    // claiming to be somebody else.
    const opened = await alice.client.post('/api/conversations', {
      otherUserId: bob.id,
      userId: bob.id,
      as: bob.id,
      actor: bob.id,
    });
    expect(opened.__status).toBe(201);
    expect(opened.conversation.members.map((member) => member.id).sort()).toEqual([alice.id, bob.id].sort());

    const posted = await alice.client.post(`/api/conversations/${opened.conversation.id}/messages`, {
      userId: bob.id,
      senderId: bob.id,
      body: 'claimed to be bob',
    });
    expect(posted.__status).toBe(201);
    expect(posted.message.senderId).toBe(alice.id);
    expect(posted.message.senderUsername).toBe('trust_no_one');
  });

  it('updates a profile, and clips anything over the documented limit', async () => {
    harness = await boot();
    const alice = await harness.register('profile_alice');
    const patched = await alice.client.patch('/api/me', { displayName: 'Alice K.', bio: 'Electron and SQLite' });
    expect(patched.user.displayName).toBe('Alice K.');
    expect(patched.user.bio).toBe('Electron and SQLite');

    const tooLong = await alice.client.patch('/api/me', { bio: 'x'.repeat(500) });
    expect(tooLong.__status).toBe(400);
    expect(tooLong.error.code).toBe('too_long_bio');
  });

  it('validates privacy settings instead of storing whatever arrives', async () => {
    harness = await boot();
    const alice = await harness.register('privacy_alice');
    const updated = await alice.client.put('/api/me/privacy', {
      appearOffline: true,
      presenceVisibleTo: 'nobody',
      readReceiptsEnabled: false,
    });
    expect(updated.__status).toBe(200);
    expect(updated.privacy.appearOffline).toBe(true);
    expect(updated.privacy.presenceVisibleTo).toBe('nobody');
    expect(updated.privacy.readReceiptsEnabled).toBe(false);

    const nonsense = await alice.client.put('/api/me/privacy', { presenceVisibleTo: 'sometimes' });
    expect(nonsense.__status).toBe(400);
    const notABoolean = await alice.client.put('/api/me/privacy', { appearOffline: 'yes-please' });
    expect(notABoolean.__status).toBe(400);
  });

  it('searches by username and honours "do not contact me"', async () => {
    harness = await boot();
    const alice = await harness.register('findable_alice');
    await harness.register('hidden_bob');

    const found = await alice.client.get('/api/users/search', { query: '?q=findable' });
    expect(found.items.map((user) => user.username)).toContain('findable_alice');
    expect(found.items.find((user) => user.username === 'hidden_bob')).toBeUndefined();

    // Two characters is the documented floor: a one-letter query would dump the
    // whole directory.
    const short = await alice.client.get('/api/users/search', { query: '?q=f' });
    expect(short.items).toEqual([]);

    const hidden = await harness.login('hidden_bob');
    await hidden.client.put('/api/me/privacy', { contactRequestsFrom: 'nobody' });
    const after = await alice.client.get('/api/users/search', { query: '?q=hidden' });
    expect(after.items).toEqual([]);

    const refused = await alice.client.post('/api/requests', { username: 'hidden_bob' });
    expect(refused.__status).toBe(403);
    expect(refused.error.code).toBe('requests_closed');
  });

  it('walks the connection lifecycle: request, accept, remove', async () => {
    harness = await boot();
    const alice = await harness.register('conn_alice');
    const bob = await harness.register('conn_bob');

    const pending = await alice.client.post('/api/requests', { username: 'conn_bob', message: 'fellow IDE nerd' });
    expect(pending.__status).toBe(201);
    expect(pending.request.state).toBe('pending');
    // The note the requester wrote is stored, not validated and thrown away.
    expect(pending.request.note).toBe('fellow IDE nerd');

    const incoming = await bob.client.get('/api/requests');
    expect(incoming.requests.incoming).toHaveLength(1);
    expect(incoming.requests.incoming[0].requester.username).toBe('conn_alice');
    expect(incoming.requests.incoming[0].note).toBe('fellow IDE nerd');

    // A request sits in the requester's outgoing list too, so a UI can show
    // "waiting for reply" without guessing.
    const outgoing = await alice.client.get('/api/requests');
    expect(outgoing.requests.outgoing).toHaveLength(1);

    // Only the person asked can answer it.
    const notYours = await alice.client.post(`/api/requests/${pending.request.id}/accept`, {});
    expect(notYours.__status).toBe(403);

    // Sending the same request again does not create a second one: the server
    // answers 200 with the same pending state instead of a duplicate row.
    const twice = await alice.client.post('/api/requests', { username: 'conn_bob' });
    expect(twice.__status).toBe(200);
    expect(twice.state).toBe('pending');
    expect(twice.request).toBeNull();
    expect((await alice.client.get('/api/requests')).requests.outgoing).toHaveLength(1);

    const accepted = await bob.client.post(`/api/requests/${pending.request.id}/accept`, {});
    expect(accepted.__status).toBe(200);
    expect(accepted.request.state).toBe('accepted');

    const contacts = await alice.client.get('/api/contacts');
    expect(contacts.items.map((contact) => contact.username)).toContain('conn_bob');
    const reverse = await bob.client.get('/api/contacts');
    expect(reverse.items.map((contact) => contact.username)).toContain('conn_alice');

    const already = await alice.client.post('/api/requests', { username: 'conn_bob' });
    expect(already.state).toBe('already_connected');

    const removed = await alice.client.del(`/api/contacts/${bob.id}`);
    expect(removed.__status).toBe(200);
    const after = await alice.client.get('/api/contacts');
    expect(after.items).toEqual([]);

    // Removing the connection is what stops the direct message, not removing a
    // row from a list.
    const dm = await alice.client.post('/api/conversations', { otherUserId: bob.id });
    expect(dm.__status).toBe(403);
    expect(dm.error.code).toBe('not_connected');
  });

  it('rejects a request, tells the requester, and still allows a second try', async () => {
    harness = await boot();
    const alice = await harness.register('reject_alice');
    const bob = await harness.register('reject_bob');

    const sent = await alice.client.post('/api/requests', { username: 'reject_bob' });
    const rejected = await bob.client.post(`/api/requests/${sent.request.id}/reject`, {});
    expect(rejected.request.state).toBe('rejected');

    const still = await alice.client.get('/api/requests');
    expect(still.requests.outgoing).toEqual([]);

    const dm = await alice.client.post('/api/conversations', { otherUserId: bob.id });
    expect(dm.__status).toBe(403);

    // Re-adding somebody you fell out with has to work: there is one request row
    // per pair, so a second try rewrites it instead of colliding with the first.
    // The colliding INSERT used to surface as a 500.
    const retried = await alice.client.post('/api/requests', { username: 'reject_bob', message: 'second try, politer' });
    expect(retried.__status).toBe(201);
    expect(retried.request.id).toBe(sent.request.id);
    expect(retried.request.note).toBe('second try, politer');

    const accepted = await bob.client.post(`/api/requests/${retried.request.id}/accept`, {});
    expect(accepted.__status).toBe(200);
    expect((await alice.client.post('/api/conversations', { otherUserId: bob.id })).__status).toBe(201);
  });

  it('blocks in both directions, and a report tells nobody but the server', async () => {
    harness = await boot();
    const alice = await harness.register('block_alice');
    const bob = await harness.register('block_bob');
    await harness.becomeFriends(alice, bob);
    const opened = await alice.client.post('/api/conversations', { otherUserId: bob.id });
    const thread = opened.conversation.id;
    await alice.client.post(`/api/conversations/${thread}/messages`, { body: 'before the falling out' });
    await bob.client.post(`/api/conversations/${thread}/messages`, { body: 'you were annoying' });

    // Bob watches the door close in real time, not only on the next page load.
    const bobSocket = await harness.connectSocket(bob);
    expect(bobSocket.ready.type).toBe('ready');

    const blocked = await bob.client.post('/api/block', { userId: alice.id });
    expect(blocked.__status).toBe(200);
    // Bob's own devices are synced so his UI is correct without a reload. The
    // event names the person he closed the door on, and goes to nobody else.
    expect((await bobSocket.waitFor('connection.blocked')).userId).toBe(alice.id);
    const list = await bob.client.get('/api/blocked');
    expect(list.items.map((item) => item.username)).toContain('block_alice');

    // Blocking is symmetric in effect: the blocker closed the channel, so neither
    // half of the pair can push new traffic through it.
    const fromBlocked = await alice.client.post(`/api/conversations/${thread}/messages`, { body: 'let me in' });
    expect(fromBlocked.__status).toBe(403);
    expect(fromBlocked.error.code).toBe('blocked');
    const fromBlocker = await bob.client.post(`/api/conversations/${thread}/messages`, { body: 'and nothing from you either' });
    expect(fromBlocker.__status).toBe(403);
    expect(fromBlocker.error.code).toBe('blocked');

    // The refusals happened before any insert, so the thread is not quietly
    // filling up with undeliverable spam.
    const history = await alice.client.get(`/api/conversations/${thread}/messages`);
    expect(history.items.map((item) => item.body)).toEqual(['before the falling out', 'you were annoying']);

    // The connection went with the block, so the thread cannot be reopened or
    // re-entered by request either.
    const reopened = await alice.client.post('/api/conversations', { otherUserId: bob.id });
    expect(reopened.__status).toBe(403);
    expect(reopened.error.code).toBe('blocked');
    const reRequested = await alice.client.post('/api/requests', { username: 'block_bob' });
    expect(reRequested.__status).toBe(403);
    expect(reRequested.error.code).toBe('blocked');

    // Reactions obey the same rule as messages, on either person's words: a closed
    // thread is closed, not merely undeliverable.
    const fromBob = history.items.find((item) => item.senderId === bob.id);
    const fromAlice = history.items.find((item) => item.senderId === alice.id);
    const reaction = await alice.client.post(`/api/messages/${fromBob.id}/reactions`, { emoji: '👍' });
    expect(reaction.__status).toBe(403);
    expect(reaction.error.code).toBe('blocked');
    const ownReaction = await alice.client.post(`/api/messages/${fromAlice.id}/reactions`, { emoji: '😡' });
    expect(ownReaction.__status).toBe(403);
    expect(ownReaction.error.code).toBe('blocked');

    // History is not collateral damage: both halves can still read what was said.
    expect((await bob.client.get(`/api/conversations/${thread}/messages`)).items).toHaveLength(2);

    // A report is a record for whoever runs the server, not a message channel. The
    // reported developer's world is untouched, and nothing arrives on their socket.
    const reported = await alice.client.post('/api/report', { userId: bob.id, reason: 'harassment', detail: 'Unwanted contact after the block.' });
    expect(reported.__status).toBe(201);
    expect(reported.report.state).toBe('open');
    expect(bobSocket.log().filter((message) => /report/i.test(message.type))).toEqual([]);
    expect((await bob.client.get('/api/requests')).requests.incoming).toEqual([]);
    expect((await bob.client.get('/api/contacts')).items).toEqual([]);
    const stored = harness.store.get('SELECT reporter_id, reported_id, reason, state FROM reports WHERE id = ?', reported.report.id);
    expect([stored.reporter_id, stored.reported_id, stored.reason, stored.state]).toEqual([alice.id, bob.id, 'harassment', 'open']);

    const nonsenseReason = await alice.client.post('/api/report', { userId: bob.id, reason: 'i_did_not_like_it' });
    expect(nonsenseReason.__status).toBe(400);
    expect(nonsenseReason.error.code).toBe('invalid_reason');
    const selfReport = await alice.client.post('/api/report', { userId: alice.id, reason: 'spam' });
    expect(selfReport.__status).toBe(404);

    // Unblocking removes the block but does not restore the contact - that would
    // re-open a channel somebody closed without them asking for it again.
    const unblocked = await bob.client.del(`/api/block/${alice.id}`);
    expect(unblocked.__status).toBe(200);
    expect((await bob.client.get('/api/blocked')).items).toEqual([]);
    const stillClosed = await alice.client.post(`/api/conversations/${thread}/messages`, { body: 'are we talking again?' });
    expect(stillClosed.__status).toBe(403);
    expect(stillClosed.error.code).toBe('not_connected');

    // Once they are contacts again the same old thread carries traffic, which also
    // proves the thread was never deleted - only closed.
    await harness.becomeFriends(alice, bob);
    const resumed = await alice.client.post(`/api/conversations/${thread}/messages`, { body: 'sorry about that' });
    expect(resumed.__status).toBe(201);
    expect(resumed.deliveredTo).toBe(1);
    expect((await bobSocket.waitFor('message', (message) => message.message?.body === 'sorry about that')).conversationId).toBe(thread);
  });

  it('does not announce a block to the person who was blocked', async () => {
    harness = await boot();
    const alice = await harness.register('quiet_alice');
    const bob = await harness.register('quiet_bob');
    const carol = await harness.register('quiet_carol');
    await harness.becomeFriends(alice, bob);
    await harness.becomeFriends(alice, carol);
    const bobThread = (await alice.client.post('/api/conversations', { otherUserId: bob.id })).conversation.id;

    const aliceSocket = await harness.connectSocket(alice);
    await harness.connectSocket(carol);
    const before = aliceSocket.log().length;

    await bob.client.post('/api/block', { userId: alice.id });

    // First prove her channel is alive and delivering, otherwise "nothing
    // arrived" would only prove the socket was dead. Carol is still a contact.
    const carolThread = (await carol.client.post('/api/conversations', { otherUserId: alice.id })).conversation.id;
    await carol.client.post(`/api/conversations/${carolThread}/messages`, { body: 'did you hear anything?' });
    await aliceSocket.waitFor('message', (message) => message.message?.body === 'did you hear anything?');

    const since = aliceSocket.log().slice(before);
    expect(since.length).toBeGreaterThan(0);
    // A block is a boundary, not a broadcast: no connection event reaches her.
    expect(since.filter((message) => /block|connection\./.test(message.type))).toEqual([]);
    // She finds out the only way she is entitled to: her own next send is refused.
    const refused = await alice.client.post(`/api/conversations/${bobThread}/messages`, { body: 'hello?' });
    expect(refused.__status).toBe(403);
    expect(refused.error.code).toBe('blocked');
  });

  it('answers an unknown route with an error body and no stack trace', async () => {
    harness = await boot();
    const missing = await harness.anon.get('/api/not-a-route');
    expect(missing.__status).toBe(404);
    expect(missing.error.code).toBe('not_found');
    expect(JSON.stringify(missing)).not.toContain('at ');

    const wrongMethod = await harness.anon.put('/api/register', { username: 'x' });
    expect(wrongMethod.__status).toBe(405);
  });

  it('refuses to create accounts when the server is closed, and accepts an invite code', async () => {
    harness = await boot({ env: { LINK_REGISTRATION_OPEN: '0', LINK_INVITE_CODE: 'team-nova' } });
    const closed = await harness.anon.post('/api/register', { username: 'shut_out', password: PASSWORD });
    expect(closed.__status).toBe(403);
    expect(closed.error.code).toBe('invite_required');

    const inWithCode = await harness.anon.post('/api/register', { username: 'invited_dev', password: PASSWORD, inviteCode: 'team-nova' });
    expect(inWithCode.__status).toBe(201);
  });

  it('revokes every session when the password changes', async () => {
    harness = await boot();
    const alice = await harness.register('rotate_alice');
    const second = await harness.login('rotate_alice');
    const before = await alice.client.get('/api/me');
    expect(before.sessions.length).toBeGreaterThanOrEqual(2);

    const changed = await alice.client.put('/api/me/password', { currentPassword: PASSWORD, newPassword: 'a-brand-new-long-passphrase' });
    expect(changed.__status).toBe(200);

    const stale = await alice.client.get('/api/me');
    expect(stale.__status).toBe(401);
    expect(stale.error.code).toBe('session_expired');
    const alsoStale = await second.client.get('/api/me');
    expect(alsoStale.__status).toBe(401);

    const relogged = await harness.login('rotate_alice', { password: 'a-brand-new-long-passphrase' });
    const wrongCurrent = await relogged.client.put('/api/me/password', { currentPassword: PASSWORD, newPassword: 'another-long-passphrase' });
    expect(wrongCurrent.__status).toBe(403);
    expect(wrongCurrent.error.code).toBe('wrong_password');
  });

  it('counts a request body while it arrives instead of trusting Content-Length', async () => {
    harness = await boot({ env: { LINK_MAX_JSON_BYTES: '2048' } });
    const alice = await harness.register('fat_alice');
    const bob = await harness.register('fat_bob');
    await harness.becomeFriends(alice, bob);
    const conversation = await alice.client.post('/api/conversations', { otherUserId: bob.id });

    const huge = await alice.client.post(`/api/conversations/${conversation.conversation.id}/messages`, { body: 'x'.repeat(60000) });
    expect(huge.__status).toBe(413);
    expect(huge.error.code).toBe('payload_too_large');

    // Refusing the request must not have written the message first.
    const history = await bob.client.get(`/api/conversations/${conversation.conversation.id}/messages`);
    expect(history.items).toEqual([]);
  });

  it('serves /health without a credential, and counts accounts', async () => {
    harness = await boot();
    const health = await harness.anon.get('/health');
    expect(health.__status).toBe(200);
    expect(health.ok).toBe(true);
    expect(health.users).toBe(0);
    await harness.register('counted_user');
    const after = await harness.anon.get('/health');
    expect(after.users).toBe(1);
  });
});

describe.runIf(SKIP)('NovaLink Live accounts', () => {
  it(`skipped on this runtime: ${SKIP_REASON}`, () => {
    expect(SKIP).toBe(true);
  });
});
