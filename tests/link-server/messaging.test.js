/**
 * Private messaging (phase 3) - the durable half of NovaLink Live.
 *
 * These tests are deliberately written as two real clients on two real sockets
 * against one real server, because the claims being checked are the ones that
 * only show up when both sides exist:
 *
 *   - a message is a row first and a notification second, so a recipient who was
 *     offline still gets it by paging history, and nobody loses a message to a
 *     dropped socket;
 *   - receipts say what actually happened on the wire rather than what the sender
 *     hoped for;
 *   - membership, blocks and read-receipt opt-outs are enforced per row, on both
 *     the REST path and the socket path.
 *
 * Nothing here stubs a success: every assertion is read back from the server.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { boot, SKIP, SKIP_REASON, until } from './helpers';

describe.runIf(!SKIP)('NovaLink Live messaging', () => {
  let harness = null;

  afterEach(async () => {
    if (harness) await harness.close();
    harness = null;
  });

  /** Two contacts with their sockets already open, listener first. */
  async function pair(prefix) {
    const alice = await harness.register(`${prefix}_alice`);
    const bob = await harness.register(`${prefix}_bob`);
    await harness.becomeFriends(alice, bob);
    // The recipient is connected before anything is sent: delivery over the socket
    // is at-most-once, so connecting afterwards would test the missed event.
    const bobSocket = await harness.connectSocket(bob);
    const aliceSocket = await harness.connectSocket(alice);
    const thread = (await alice.client.post('/api/conversations', { otherUserId: bob.id })).conversation.id;
    return { alice, bob, aliceSocket, bobSocket, thread };
  }

  it('delivers a message written by one developer to another, over the wire and in the database', async () => {
    harness = await boot();
    const { alice, bob, aliceSocket, bobSocket, thread } = await pair('wire');

    const sent = await alice.client.post(`/api/conversations/${thread}/messages`, { body: 'can you review the patch?' });
    expect(sent.__status).toBe(201);
    expect(sent.message).toMatchObject({ body: 'can you review the patch?', senderId: alice.id, conversationId: thread });
    expect(sent.message.seq).toBe(1);
    // One recipient, and it really was the socket that carried it: this number is
    // counted from frames the server handed to a live connection.
    expect(sent.deliveredTo).toBe(1);

    const pushed = await bobSocket.waitFor('message', (frame) => frame.message?.body === 'can you review the patch?');
    expect(pushed.conversationId).toBe(thread);
    expect(pushed.from).toMatchObject({ id: alice.id, username: 'wire_alice' });
    expect(pushed.message.senderName).toBe('wire_alice');

    // The sender is told it arrived, per recipient - and bob's own unread badge moves.
    const receipt = await aliceSocket.waitFor('message.delivered', (frame) => frame.messageId === sent.message.id);
    expect(receipt.userId).toBe(bob.id);
    // `unread` is also pushed at sign-in with a total of zero, so the badge is
    // matched on its value rather than on its type.
    expect((await bobSocket.waitFor('unread', (frame) => frame.total === 1)).total).toBe(1);
    expect((await bob.client.get('/api/conversations')).unread).toBe(1);

    // The row exists in SQLite, not only in the frame that was pushed.
    const row = harness.store.get('SELECT body, seq, sender_id, conversation_id FROM messages WHERE id = ?', sent.message.id);
    expect(row).toMatchObject({ body: 'can you review the patch?', seq: 1, sender_id: alice.id, conversation_id: thread });

    // And paging history from the other side finds the same message by the same id.
    const history = await bob.client.get(`/api/conversations/${thread}/messages`);
    expect(history.items.map((item) => item.id)).toEqual([sent.message.id]);
    expect(history.items[0].reactions).toEqual([]);
  });

  it('keeps the database as the truth when the recipient is not connected', async () => {
    harness = await boot();
    const alice = await harness.register('offline_alice');
    const bob = await harness.register('offline_bob');
    await harness.becomeFriends(alice, bob);
    const aliceSocket = await harness.connectSocket(alice);
    const thread = (await alice.client.post('/api/conversations', { otherUserId: bob.id })).conversation.id;

    // Nobody is listening: the send must still succeed, and must not claim delivery.
    const sent = await alice.client.post(`/api/conversations/${thread}/messages`, { body: 'written while you were out' });
    expect(sent.__status).toBe(201);
    expect(sent.deliveredTo).toBe(0);
    expect(aliceSocket.all('message.delivered')).toEqual([]);

    // Bob opens NovaCode afterwards. The socket pushes nothing he missed, so the
    // client pages history - and finds exactly what the sender wrote.
    const bobSocket = await harness.connectSocket(bob);
    const history = await bob.client.get(`/api/conversations/${thread}/messages`);
    expect(history.items.map((item) => item.body)).toEqual(['written while you were out']);
    expect((await bob.client.get('/api/conversations')).items.find((c) => c.id === thread).unread).toBe(1);
    expect((await bobSocket.waitFor('ready')).user.username).toBe('offline_bob');
  });

  it('stores a code snippet as formatted text with its language, and refuses a language that is not one', async () => {
    harness = await boot();
    const { alice, bob, bobSocket, thread } = await pair('code');

    const snippet = ['function debounce(fn, ms) {', '  let t;', '  return (...a) => clearTimeout(t) || (t = setTimeout(fn, ms, ...a));', '}'].join('\n');
    const sent = await alice.client.post(`/api/conversations/${thread}/messages`, { body: snippet, language: 'js' });
    expect(sent.__status).toBe(201);
    expect(sent.message.language).toBe('js');
    expect(sent.message.body).toBe(snippet);

    const pushed = await bobSocket.waitFor('message', (frame) => frame.message?.language === 'js');
    expect(pushed.message.body).toContain('function debounce');

    const page = (await bob.client.get(`/api/conversations/${thread}/messages`)).items[0];
    expect(page.language).toBe('js');
    expect(page.body).toBe(snippet);

    // A language id is a rendering hint the recipient trusts, so it is validated
    // rather than stored as whatever arrived.
    const junk = await alice.client.post(`/api/conversations/${thread}/messages`, { body: 'x'.repeat(20), language: 'not a language!' });
    expect(junk.__status).toBe(400);
    expect(junk.error.code).toBe('invalid_language');
  });

  it('refuses an empty message, an over-long one, and a reply aimed at another conversation', async () => {
    harness = await boot();
    const { alice, bob, thread } = await pair('rules');
    void bob;

    const empty = await alice.client.post(`/api/conversations/${thread}/messages`, { body: '   ' });
    expect(empty.__status).toBe(400);
    expect(empty.error.code).toBe('empty_message');

    const long = await alice.client.post(`/api/conversations/${thread}/messages`, { body: 'a'.repeat(harness.config.limits.maxMessageChars + 1) });
    expect(long.__status).toBe(400);
    expect(long.error.code).toBe('too_long_message');

    const first = await alice.client.post(`/api/conversations/${thread}/messages`, { body: 'a thread worth replying to' });
    expect(first.message.replyToId).toBeNull();

    // A reply that names a message in some other thread: the client would render a
    // quote of a message this conversation never held, so it is refused outright.
    const carol = await harness.register('rules_carol');
    await harness.becomeFriends(alice, carol);
    const group = (await alice.client.post('/api/conversations', { kind: 'group', memberIds: [carol.id], title: 'standup' })).conversation;
    const crossThread = await alice.client.post(`/api/conversations/${group.id}/messages`, { body: 'quoted from somewhere else', replyToId: first.message.id });
    expect(crossThread.__status).toBe(400);
    expect(crossThread.error.code).toBe('bad_reply');

    // A reply to a message that does not exist at all is the same refusal, not a
    // dangling quote the recipient can never open.
    const dangling = await alice.client.post(`/api/conversations/${thread}/messages`, { body: 'ghost quote', replyToId: '00000000-0000-4000-8000-000000000000' });
    expect(dangling.__status).toBe(400);
    expect(dangling.error.code).toBe('bad_reply');

    const stranger = await harness.register('rules_stranger');
    const guess = await stranger.client.post(`/api/conversations/${thread}/messages`, { body: 'let me in', replyToId: first.message.id });
    expect(guess.__status).toBe(404);
    expect(guess.error.code).toBe('no_conversation');
    // A guessed id must not be distinguishable from a nonexistent one, and nothing
    // was written either way.
    const nonexistent = await stranger.client.post('/api/conversations/00000000-0000-4000-8000-000000000000/messages', { body: 'let me in' });
    expect(nonexistent.__status).toBe(404);
    expect(nonexistent.error.code).toBe('no_conversation');
    expect(harness.store.get('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ?', stranger.id).n).toBe(0);
    // The refusals above wrote nothing either: one message exists, alice's own.
    expect(harness.store.get('SELECT COUNT(*) AS n FROM messages').n).toBe(1);
  });

  it('replies, reacts, and tells the other person without any client polling', async () => {
    harness = await boot();
    const { alice, bob, aliceSocket, bobSocket, thread } = await pair('react');

    const root = await alice.client.post(`/api/conversations/${thread}/messages`, { body: 'ship it on friday' });
    await bobSocket.waitFor('message');
    const reply = await bob.client.post(`/api/conversations/${thread}/messages`, { body: 'friday is fine', replyToId: root.message.id });
    expect(reply.__status).toBe(201);
    expect(reply.message.replyToId).toBe(root.message.id);

    const annotated = await alice.client.post(`/api/messages/${root.message.id}/reactions`, { emoji: '🎉' });
    expect(annotated.__status).toBe(200);
    expect(annotated.message.reactions).toEqual([{ emoji: '🎉', count: 1 }]);
    expect(annotated.message.reactionsMine).toEqual(['🎉']);

    const announced = await bobSocket.waitFor('reaction', (frame) => frame.messageId === root.message.id);
    expect(announced).toMatchObject({ userId: alice.id, removed: false, reactions: [{ emoji: '🎉', count: 1 }] });

    // The same reaction twice is one reaction, not a bar filling with duplicates.
    const again = await alice.client.post(`/api/messages/${root.message.id}/reactions`, { emoji: '🎉' });
    expect(again.message.reactions).toEqual([{ emoji: '🎉', count: 1 }]);

    // bob adds a second emoji, so removing alice's must not erase his.
    await bob.client.post(`/api/messages/${root.message.id}/reactions`, { emoji: '👀' });
    const lifted = await alice.client.del(`/api/messages/${root.message.id}/reactions?emoji=${encodeURIComponent('🎉')}`);
    expect(lifted.message.reactions.map((r) => r.emoji)).toEqual(['👀']);
    const removal = await bobSocket.waitFor('reaction', (frame) => frame.removed === true);
    expect(removal.messageId).toBe(root.message.id);

    // Not a single emoji is refused: a reaction is rendered in someone else's UI.
    const nonsense = await bob.client.post(`/api/messages/${root.message.id}/reactions`, { emoji: 'lol nice work' });
    expect(nonsense.__status).toBe(400);
    expect(nonsense.error.code).toBe('invalid_emoji');

    const page = await bob.client.get(`/api/conversations/${thread}/messages`);
    expect(page.items.map((item) => item.body)).toEqual(['ship it on friday', 'friday is fine']);
    expect(page.items[0].reactions).toEqual([{ emoji: '👀', count: 1 }]);
    // The reply knows what it answers, so a client can render the thread without
    // holding the whole conversation in memory.
    expect(page.items[1].replyToId).toBe(root.message.id);
    expect(aliceSocket.readyState).toBe(globalThis.WebSocket.OPEN);
  });

  it('shows typing indicators live and stores nothing at all', async () => {
    harness = await boot();
    const { alice, aliceSocket, bobSocket, thread } = await pair('typing');

    const before = harness.store.get('SELECT COUNT(*) AS n FROM messages').n;
    aliceSocket.send({ type: 'typing', conversationId: thread, typing: true });
    const indicator = await bobSocket.waitFor('typing', (frame) => frame.userId === alice.id);
    expect(indicator).toMatchObject({ conversationId: thread, name: 'typing_alice', typing: true });

    aliceSocket.send({ type: 'typing', conversationId: thread, typing: false });
    const stopped = await bobSocket.waitFor('typing', (frame) => frame.userId === alice.id && frame.typing === false);
    expect(stopped.conversationId).toBe(thread);

    // An indicator is a moment, not a record: no row anywhere holds it.
    expect(harness.store.get('SELECT COUNT(*) AS n FROM messages').n).toBe(before);
    expect(harness.store.get("SELECT COUNT(*) AS n FROM messages WHERE body LIKE '%typing%'").n).toBe(0);

    // Typing into a conversation you do not belong to is refused on the socket, and
    // the socket stays open: an error frame is a reply, not an eviction.
    const stranger = await harness.register('typing_stranger');
    const strangerSocket = await harness.connectSocket(stranger);
    strangerSocket.send({ type: 'typing', conversationId: thread });
    const refused = await strangerSocket.waitFor('error', (frame) => frame.code === 'no_conversation');
    expect(refused.ref).toBeNull();
    expect(strangerSocket.readyState).toBe(globalThis.WebSocket.OPEN);
  });

  it('sends read receipts when both sides allow it and nothing at all when the reader opts out', async () => {
    harness = await boot();
    const { alice, bob, aliceSocket, bobSocket, thread } = await pair('read');

    const sent = await alice.client.post(`/api/conversations/${thread}/messages`, { body: 'read me when you can' });
    await bobSocket.waitFor('message');

    // The socket path is the one a live IDE uses; the REST path is the durable
    // equivalent for a client that reconnects and catches up.
    bobSocket.send({ type: 'message.read', conversationId: thread, seq: sent.message.seq });
    const receipt = await aliceSocket.waitFor('message.read', (frame) => frame.conversationId === thread);
    expect(receipt).toMatchObject({ userId: bob.id, seq: 1 });
    expect((await bobSocket.waitFor('unread', (frame) => frame.total === 0)).total).toBe(0);
    expect((await bob.client.get('/api/conversations')).unread).toBe(0);

    // Going backwards is not a thing: an old cursor cannot un-read a message.
    const stale = await bob.client.post(`/api/conversations/${thread}/read`, { seq: 0 });
    expect(stale).toMatchObject({ seq: 1, changed: false });

    // Opt out, send again, and the sender must see no receipt at any point.
    await bob.client.put('/api/me/privacy', { readReceiptsEnabled: false });
    const second = await alice.client.post(`/api/conversations/${thread}/messages`, { body: 'read me silently' });
    await bobSocket.waitFor('message', (frame) => frame.message?.id === second.message.id);
    const receipts = aliceSocket.all('message.read').length;
    const marked = await bob.client.post(`/api/conversations/${thread}/read`, { seq: second.message.seq });
    expect(marked.changed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(aliceSocket.all('message.read').length).toBe(receipts);
    // The reader still gets their own badge cleared - the opt-out hides it from
    // the sender, it does not break the reader's own client.
    expect((await bob.client.get('/api/conversations')).unread).toBe(0);
  });

  it('fans one message out to a group and drops only the member who blocked the sender', async () => {
    harness = await boot();
    const alice = await harness.register('group_alice');
    const bob = await harness.register('group_bob');
    const carol = await harness.register('group_carol');
    const dave = await harness.register('group_dave');
    await harness.becomeFriends(alice, bob);
    await harness.becomeFriends(alice, carol);
    await harness.becomeFriends(alice, dave);

    const bobSocket = await harness.connectSocket(bob);
    const carolSocket = await harness.connectSocket(carol);
    const daveSocket = await harness.connectSocket(dave);
    for (const link of [bobSocket, carolSocket, daveSocket]) await link.waitFor('ready');

    const made = await alice.client.post('/api/conversations', { kind: 'group', memberIds: [bob.id, carol.id, dave.id], title: 'release crew' });
    expect(made.__status).toBe(201);
    expect(made.conversation.kind).toBe('group');
    expect(made.conversation.members).toHaveLength(4);
    for (const link of [bobSocket, carolSocket, daveSocket]) {
      expect((await link.waitFor('conversation.joined', (frame) => frame.conversationId === made.conversation.id)).kind).toBe('group');
    }

    // Dave would rather not be in a thread where alice speaks. That is his call, and
    // it is a per-recipient rule: the group keeps working for everyone else.
    const blocked = await dave.client.post('/api/block', { userId: alice.id });
    expect(blocked.__status).toBe(200);

    const sent = await alice.client.post(`/api/conversations/${made.conversation.id}/messages`, { body: 'cutting the release candidate now' });
    expect(sent.__status).toBe(201);
    expect(sent.deliveredTo).toBe(2);
    expect((await bobSocket.waitFor('message', (frame) => frame.message?.body === 'cutting the release candidate now')).conversationId).toBe(made.conversation.id);
    await carolSocket.waitFor('message', (frame) => frame.message?.body === 'cutting the release candidate now');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(daveSocket.all('message')).toEqual([]);

    // dave is still a member of the row set, and the message is still in the thread:
    // a block silences notifications, it does not rewrite history or remove people.
    const history = await dave.client.get(`/api/conversations/${made.conversation.id}/messages`);
    expect(history.items.map((item) => item.body)).toEqual(['cutting the release candidate now']);
    const asSeenByAlice = await alice.client.get(`/api/conversations/${made.conversation.id}`);
    expect(asSeenByAlice.conversation.members.map((m) => m.username)).toContain('group_dave');

    // And a stranger cannot read a group they were never added to.
    const outsider = await harness.register('group_outsider');
    expect((await outsider.client.get(`/api/conversations/${made.conversation.id}/messages`)).__status).toBe(404);
  });

  it('pages history backwards without losing or repeating a message', async () => {
    harness = await boot();
    const alice = await harness.register('page_alice');
    const bob = await harness.register('page_bob');
    await harness.becomeFriends(alice, bob);
    const thread = (await alice.client.post('/api/conversations', { otherUserId: bob.id })).conversation.id;

    const ids = [];
    for (let i = 1; i <= 12; i += 1) {
      const sent = await alice.client.post(`/api/conversations/${thread}/messages`, { body: `message ${String(i).padStart(2, '0')}`, clientId: `page-${i}` });
      expect(sent.__status).toBe(201);
      ids.push(sent.message.id);
    }

    // Walk back from the newest in pages of five, then read forward again.
    const collected = [];
    let cursor = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const query = cursor ? `?limit=5&before=${cursor}` : '?limit=5';
      const page = await alice.client.get(`/api/conversations/${thread}/messages${query}`);
      expect(page.items.length).toBeLessThanOrEqual(5);
      // Oldest first inside a page, so a client can prepend without sorting.
      const seqs = page.items.map((item) => item.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      collected.unshift(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(collected.map((item) => item.id)).toEqual(ids);
    expect(collected.map((item) => item.body)[0]).toBe('message 01');
    expect((await alice.client.get(`/api/conversations/${thread}/messages?limit=5`)).items).toHaveLength(5);

    // A page size the server does not allow is clamped, not honoured.
    const greedy = await alice.client.get(`/api/conversations/${thread}/messages?limit=100000`);
    expect(greedy.items.length).toBeLessThanOrEqual(harness.config.limits.pageSizeMax);

    // A retry of the same client id is the same message, once.
    const retried = await alice.client.post(`/api/conversations/${thread}/messages`, { body: 'message 12', clientId: 'page-12' });
    expect(retried.__status).toBe(200);
    expect(retried.reused).toBe(true);
    expect(retried.message.id).toBe(ids[ids.length - 1]);
    expect(harness.store.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', thread).n).toBe(12);
  });

  it('searches inside the conversations the caller belongs to and nowhere else', async () => {
    harness = await boot();
    const alice = await harness.register('find_alice');
    const bob = await harness.register('find_bob');
    const carol = await harness.register('find_carol');
    await harness.becomeFriends(alice, bob);
    await harness.becomeFriends(alice, carol);
    // bob and carol are contacts of each other as well, so there is a thread alice
    // is not in that contains the searched-for word - the leak test below needs a
    // real match that must not come back for her.
    await harness.becomeFriends(bob, carol);
    const withBob = (await alice.client.post('/api/conversations', { otherUserId: bob.id })).conversation.id;
    const withCarol = (await alice.client.post('/api/conversations', { otherUserId: carol.id })).conversation.id;
    await alice.client.post(`/api/conversations/${withBob}/messages`, { body: 'the kettlebell routine is in the notes app' });
    await alice.client.post(`/api/conversations/${withCarol}/messages`, { body: 'kettlebell: nothing to do with this thread' });
    const bobThread = (await bob.client.post('/api/conversations', { otherUserId: carol.id })).conversation.id;
    await bob.client.post(`/api/conversations/${bobThread}/messages`, { body: 'kettlebell private to bob and carol' });

    const found = await alice.client.get('/api/messages/search?q=kettlebell');
    expect(found.mode).toMatch(/^(fts5|like)$/);
    expect(found.items.map((item) => item.conversationId).sort()).toEqual([withBob, withCarol].sort());
    expect(found.items.every((item) => item.senderId === alice.id)).toBe(true);
    // bob's thread with carol holds the same word and alice is not in it. The index
    // is joined back through membership, so that match is not a result for her.
    expect(found.items.map((item) => item.conversationId)).not.toContain(bobThread);

    // Scoped to one thread, and the other match does not leak in.
    const scoped = await alice.client.get(`/api/messages/search?q=kettlebell&conversationId=${withCarol}`);
    expect(scoped.items.map((item) => item.conversationId)).toEqual([withCarol]);

    // Each of the other two sees their own two threads and nothing more: carol is in
    // alice's thread and in bob's, bob is in alice's and carol's.
    const asCarol = await carol.client.get('/api/messages/search?q=kettlebell');
    expect(asCarol.items.map((item) => item.conversationId).sort()).toEqual([withCarol, bobThread].sort());
    const asBob = await bob.client.get('/api/messages/search?q=kettlebell');
    expect(asBob.items.map((item) => item.conversationId).sort()).toEqual([withBob, bobThread].sort());

    // Too short to be a real query, and a term nobody wrote.
    expect((await alice.client.get('/api/messages/search?q=k')).items).toEqual([]);
    expect((await alice.client.get('/api/messages/search?q=unobtanium')).items).toEqual([]);
    // A conversation she is not in is not a search filter she may apply.
    expect((await carol.client.get(`/api/messages/search?q=kettlebell&conversationId=${withBob}`)).__status).toBe(404);
  });

  it('survives a restart of the server, with the same threads, the same tokens and the same rows', async () => {
    harness = await boot();
    const alice = await harness.register('durable_alice');
    const bob = await harness.register('durable_bob');
    await harness.becomeFriends(alice, bob);
    const aliceSocket = await harness.connectSocket(alice);
    const bobSocket = await harness.connectSocket(bob);
    await bobSocket.waitFor('ready');

    const thread = (await alice.client.post('/api/conversations', { otherUserId: bob.id })).conversation.id;
    const first = await alice.client.post(`/api/conversations/${thread}/messages`, { body: 'written before the restart', language: 'md' });
    await bobSocket.waitFor('message');
    await bob.client.post(`/api/conversations/${thread}/read`, { seq: first.message.seq });
    await alice.client.post(`/api/messages/${first.message.id}/reactions`, { emoji: '👍' });
    await alice.client.post(`/api/conversations/${thread}/messages`, { body: '#!/bin/sh\nrm -rf /', clientId: 'durable-2' });

    const before = {
      messages: harness.store.get('SELECT COUNT(*) AS n FROM messages').n,
      reactions: harness.store.get('SELECT COUNT(*) AS n FROM reactions').n,
      threads: (await alice.client.get('/api/conversations')).items.length,
      unread: (await bob.client.get('/api/conversations')).unread,
    };
    expect(before.messages).toBe(2);
    expect(before.reactions).toBe(1);

    // A second process against the same data directory. Nothing is carried over in
    // memory: sockets, presence and calls all start from an empty map.
    await harness.restart();
    expect((await harness.anon.get('/health')).liveSockets).toBe(0);
    expect(await until(async () => aliceSocket.closedInfo, { label: 'the old socket to be gone' })).toBeTruthy();

    // The credential still works because the session row is in the database.
    const me = await alice.client.get('/api/me');
    expect(me.__status).toBe(200);
    expect(me.user.username).toBe('durable_alice');

    const reopened = await alice.client.post('/api/conversations', { otherUserId: bob.id });
    expect(reopened.__status).toBe(201);
    expect(reopened.conversation.id).toBe(thread);

    const history = await alice.client.get(`/api/conversations/${thread}/messages`);
    expect(history.items.map((item) => item.body)).toEqual(['written before the restart', '#!/bin/sh\nrm -rf /']);
    expect(history.items[0].reactions).toEqual([{ emoji: '👍', count: 1 }]);
    expect(history.items[0].language).toBe('md');

    // Unread position is per member and durable, so a restart does not re-light a
    // badge the reader had already cleared.
    const list = await bob.client.get('/api/conversations');
    expect(list.unread).toBe(before.unread);
    expect(list.items).toHaveLength(before.threads);
    expect(harness.store.get('SELECT COUNT(*) AS n FROM messages').n).toBe(before.messages);

    // And the new process is live again: the same people can talk over sockets built
    // from scratch against a database they did not write.
    const carol = await harness.register('durable_carol');
    await harness.becomeFriends(alice, carol);
    const carolSocket = await harness.connectSocket(carol);
    const reconnected = await harness.connectSocket(alice);
    const bobAgain = await harness.connectSocket(bob);
    await reconnected.waitFor('ready');
    await bobAgain.waitFor('ready');
    // carol shares no thread that holds this message, so she is not told; bob had to
    // reconnect, and the send now reaches him over the rebuilt connection.
    const revived = await alice.client.post(`/api/conversations/${thread}/messages`, { body: 'still here after the restart' });
    expect(revived.__status).toBe(201);
    expect(revived.deliveredTo).toBe(1);
    const delivered = await bobAgain.waitFor('message', (frame) => frame.message?.body === 'still here after the restart');
    expect(delivered.conversationId).toBe(thread);
    await until(async () => (await harness.anon.get('/health')).liveSockets === 3, { label: 'three live sockets on the new process' });
    expect(carolSocket.all('message')).toEqual([]);
  });
});

/**
 * A runtime without `node:sqlite` and a standards-compliant WebSocket client
 * cannot test any of this, so the skip is reported with its reason instead of
 * looking like a pass.
 */
describe.runIf(SKIP)('NovaLink Live messaging', () => {
  it(`skipped on this runtime: ${SKIP_REASON}`, () => {
    expect(SKIP).toBe(true);
  });
});
