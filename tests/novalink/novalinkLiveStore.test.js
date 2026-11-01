// @vitest-environment jsdom
/**
 * Renderer store — every transition the chat UI relies on.
 *
 * These are reducer-shaped tests: feed a frame, assert the next snapshot. They
 * do not render anything; component tests live in the sibling test.jsx files.
 * Coverage mirrors the frame vocabulary the main process forwards on
 * `novalinkLive:event` — ready, presence, typing, message, message.delivered,
 * message.read, unread, reaction, connection.request, connection.accepted,
 * call.incoming, call.ended, error — plus bootstrap ingestion and the two
 * action helpers (setActiveConversation, optimisticSend / reconcilePending).
 *
 * The store also owns the notification side effect: an incoming message for
 * a conversation the user is NOT currently viewing while the app is unfocused
 * must fire `client.novalinkLiveNotify`. jsdom is used because the store
 * consults `document.hasFocus()` before deciding to notify.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock novaClient so no side effect can reach the real bridge and so we can
// spy on the notify + markRead calls the store fires.
const notifyMock = vi.fn(async () => ({ ok: true }));
const markReadMock = vi.fn(async () => ({ ok: true }));
vi.mock('../../src/services/novaClient', () => ({
  client: {
    novalinkLiveNotify: (...args) => notifyMock(...args),
    novalinkLiveMarkRead: (...args) => markReadMock(...args),
  },
  toUserMessage: (err) => String(err?.message || err || 'unavailable'),
  isDesktop: true,
  nova: {},
}));

const store = await import('../../src/services/novalinkLiveStore.js');

const ALICE = 'a'.repeat(8) + '-0000-0000-0000-000000000000';
const BOB = 'b'.repeat(8) + '-0000-0000-0000-000000000000';
const CONVA = 'c'.repeat(8) + '-0000-0000-0000-000000000000';
const MSG1 = 'm'.repeat(8) + '-0000-0000-0000-000000000001';
const MSG2 = 'm'.repeat(8) + '-0000-0000-0000-000000000002';

function messageFixture(overrides = {}) {
  return {
    id: MSG1,
    conversationId: CONVA,
    fromUserId: BOB,
    fromName: 'Bob',
    body: 'hi',
    seq: 1,
    kind: 'text',
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  store.__reset();
  notifyMock.mockClear();
  markReadMock.mockClear();
  // Default jsdom: document has focus. Individual tests override when they
  // want to prove the notification path fires.
  vi.spyOn(document, 'hasFocus').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('subscribe / getSnapshot contract', () => {
  it('getSnapshot returns a stable reference until a change lands', () => {
    const before = store.getSnapshot();
    store.handleFrame({ type: 'pong' }); // no-op frame
    expect(store.getSnapshot()).toBe(before); // identity unchanged
  });

  it('emit produces a fresh top-level object so React re-renders', () => {
    const before = store.getSnapshot();
    store.handleFrame({ type: 'ready', user: { id: ALICE, username: 'alice' } });
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.ready).toBe(true);
    expect(after.user.id).toBe(ALICE);
  });

  it('listeners attached via subscribe() are notified on every emit', () => {
    const seen = [];
    const off = store.subscribe(() => seen.push(store.getSnapshot().ready));
    store.handleFrame({ type: 'ready', user: { id: ALICE } });
    store.handleStatus({ ready: false, signedIn: false });
    off();
    store.handleFrame({ type: 'ready', user: { id: ALICE } }); // should not notify
    expect(seen).toEqual([true, false]);
  });
});

describe('frame: ready / presence / typing', () => {
  it('ready marks signedIn and captures the user', () => {
    store.handleFrame({ type: 'ready', user: { id: ALICE, username: 'alice' } });
    const snap = store.getSnapshot();
    expect(snap.ready).toBe(true);
    expect(snap.signedIn).toBe(true);
    expect(snap.user.username).toBe('alice');
  });

  it('presence updates the map and remembers lastSeenAt on offline', () => {
    store.handleFrame({ type: 'presence', userId: BOB, status: 'online' });
    expect(store.selectPresence(BOB)).toBe('online');
    store.handleFrame({ type: 'presence', userId: BOB, status: 'away' });
    expect(store.selectPresence(BOB)).toBe('away');
    const ts = '2026-10-18T00:00:00.000Z';
    store.handleFrame({ type: 'presence', userId: BOB, status: 'offline', lastSeenAt: ts });
    expect(store.selectPresence(BOB)).toBe('offline');
    expect(store.getSnapshot().lastSeenByUser[BOB]).toBe(ts);
  });

  it('unknown userId in presence is added, not silently dropped', () => {
    const CHARLIE = 'd'.repeat(8) + '-0000-0000-0000-000000000000';
    store.handleFrame({ type: 'presence', userId: CHARLIE, status: 'busy' });
    expect(store.selectPresence(CHARLIE)).toBe('busy');
  });

  it('typing frames set and clear per-user entries in a conversation', () => {
    store.handleFrame({ type: 'typing', conversationId: CONVA, fromUserId: BOB, name: 'Bob', typing: true });
    expect(store.selectTyping(CONVA)).toEqual(['Bob']);
    store.handleFrame({ type: 'typing', conversationId: CONVA, fromUserId: BOB, name: 'Bob', typing: false });
    expect(store.selectTyping(CONVA)).toEqual([]);
  });

  it('selectTyping filters out the local user', () => {
    store.handleFrame({ type: 'ready', user: { id: ALICE } });
    store.handleFrame({ type: 'typing', conversationId: CONVA, fromUserId: ALICE, name: 'Me', typing: true });
    store.handleFrame({ type: 'typing', conversationId: CONVA, fromUserId: BOB, name: 'Bob', typing: true });
    expect(store.selectTyping(CONVA)).toEqual(['Bob']);
  });

  it('typing decays after TYPING_DECAY_MS once a subscriber is attached', async () => {
    vi.useFakeTimers();
    try {
      const off = store.subscribe(() => {});
      store.handleFrame({ type: 'typing', conversationId: CONVA, fromUserId: BOB, name: 'Bob', typing: true });
      expect(store.selectTyping(CONVA)).toEqual(['Bob']);
      // The prune ticker runs at 500 ms and only clears entries older than
      // 3000 ms; advance both conditions.
      await vi.advanceTimersByTimeAsync(3200);
      expect(store.selectTyping(CONVA)).toEqual([]);
      off();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('frame: message / unread / conversations bump', () => {
  it('incoming message appends to the thread and promotes the conversation', () => {
    store.handleFrame({ type: 'message', message: messageFixture({ body: 'first' }) });
    const snap = store.getSnapshot();
    expect(snap.messagesByConversation[CONVA]).toHaveLength(1);
    expect(snap.conversations[0].id).toBe(CONVA);
    expect(snap.conversations[0].lastBody).toBe('first');
  });

  it('duplicates by message id are dropped (server redelivers on reconnect)', () => {
    store.handleFrame({ type: 'message', message: messageFixture() });
    store.handleFrame({ type: 'message', message: messageFixture() });
    expect(store.selectMessages(CONVA)).toHaveLength(1);
  });

  it('unread increments for a non-active conversation from someone else', () => {
    store.handleFrame({ type: 'ready', user: { id: ALICE } });
    store.handleFrame({ type: 'message', message: messageFixture({ fromUserId: BOB }) });
    expect(store.selectUnreadFor(CONVA)).toBe(1);
    expect(store.selectUnreadTotal()).toBe(1);
  });

  it('unread does NOT increment for the active conversation', () => {
    store.handleFrame({ type: 'ready', user: { id: ALICE } });
    store.setActiveConversation(CONVA);
    store.handleFrame({ type: 'message', message: messageFixture({ fromUserId: BOB }) });
    expect(store.selectUnreadFor(CONVA)).toBe(0);
  });

  it('unread does NOT increment for our own sent messages', () => {
    store.handleFrame({ type: 'ready', user: { id: ALICE } });
    store.handleFrame({ type: 'message', message: messageFixture({ fromUserId: ALICE }) });
    expect(store.selectUnreadFor(CONVA)).toBe(0);
  });

  it('native notification fires only when the app is unfocused AND conversation is not active', async () => {
    vi.spyOn(document, 'hasFocus').mockImplementation(() => false);
    store.handleFrame({ type: 'ready', user: { id: ALICE } });
    store.handleFrame({ type: 'message', message: messageFixture({ fromUserId: BOB, fromName: 'Bob', body: 'dinner?' }) });
    // notifyFor is async; give it a microtask.
    await Promise.resolve();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith({
      title: 'Bob',
      body: 'dinner?',
      conversationId: CONVA,
    });
  });

  it('no notification when the app has focus', async () => {
    store.handleFrame({ type: 'ready', user: { id: ALICE } });
    store.handleFrame({ type: 'message', message: messageFixture({ fromUserId: BOB }) });
    await Promise.resolve();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('notification summary for attachment-only messages says "Sent a file"', async () => {
    vi.spyOn(document, 'hasFocus').mockImplementation(() => false);
    store.handleFrame({ type: 'ready', user: { id: ALICE } });
    store.handleFrame({
      type: 'message',
      message: messageFixture({ fromUserId: BOB, fromName: 'Bob', body: '', attachments: [{ id: 'x' }] }),
    });
    await Promise.resolve();
    expect(notifyMock.mock.calls[0][0].body).toBe('Sent a file');
  });
});

describe('frame: message.delivered / message.read / reactions', () => {
  it('delivered stamps deliveredAt on the referenced messages', () => {
    store.handleFrame({ type: 'message', message: messageFixture({ id: MSG1 }) });
    store.handleFrame({ type: 'message.delivered', conversationId: CONVA, messageIds: [MSG1] });
    const [entry] = store.selectMessages(CONVA);
    expect(entry.deliveredAt).toBeGreaterThan(0);
  });

  it('read stamps readAt up to the supplied seq', () => {
    store.handleFrame({ type: 'message', message: messageFixture({ id: MSG1, seq: 1 }) });
    store.handleFrame({ type: 'message', message: messageFixture({ id: MSG2, seq: 2 }) });
    store.handleFrame({ type: 'message.read', conversationId: CONVA, seq: 1 });
    const list = store.selectMessages(CONVA);
    expect(list.find((m) => m.id === MSG1).readAt).toBeGreaterThan(0);
    expect(list.find((m) => m.id === MSG2).readAt).toBeUndefined();
  });

  it('reaction add + remove toggles a user in the emoji set', () => {
    store.handleFrame({ type: 'reaction', messageId: MSG1, emoji: '👍', userId: BOB });
    expect(store.selectReactions(MSG1)).toEqual({ '👍': [BOB] });
    store.handleFrame({ type: 'reaction', messageId: MSG1, emoji: '👍', userId: ALICE });
    expect(store.selectReactions(MSG1)['👍'].sort()).toEqual([ALICE, BOB].sort());
    store.handleFrame({ type: 'reaction', messageId: MSG1, emoji: '👍', userId: BOB, removed: true });
    expect(store.selectReactions(MSG1)).toEqual({ '👍': [ALICE] });
  });

  it('removing the last reactor deletes the emoji key entirely', () => {
    store.handleFrame({ type: 'reaction', messageId: MSG1, emoji: '🎉', userId: BOB });
    store.handleFrame({ type: 'reaction', messageId: MSG1, emoji: '🎉', userId: BOB, removed: true });
    expect(store.selectReactions(MSG1)).toEqual({});
  });
});

describe('frame: unread snapshot / connection / call / error', () => {
  it('unread frame replaces the per-conversation counts and total', () => {
    store.handleFrame({ type: 'unread', byConversation: { [CONVA]: 3 }, total: 3 });
    expect(store.selectUnreadFor(CONVA)).toBe(3);
    expect(store.selectUnreadTotal()).toBe(3);
  });

  it('connection.request prepends to the incoming queue', () => {
    store.handleFrame({ type: 'connection.request', request: { id: 'r1', fromUserId: BOB } });
    store.handleFrame({ type: 'connection.request', request: { id: 'r2', fromUserId: ALICE } });
    const incoming = store.getSnapshot().requests.incoming;
    expect(incoming.map((r) => r.id)).toEqual(['r2', 'r1']);
  });

  it('connection.accepted adds the peer to contacts and removes the outgoing request', () => {
    store.ingestRequests({ incoming: [], outgoing: [{ id: 'rq', toUserId: BOB }] });
    store.handleFrame({ type: 'connection.accepted', user: { id: BOB, username: 'bob' } });
    expect(store.getSnapshot().contacts.map((c) => c.id)).toContain(BOB);
    expect(store.getSnapshot().requests.outgoing).toHaveLength(0);
  });

  it('call.incoming captures the call; call.ended clears it', () => {
    store.handleFrame({ type: 'call.incoming', call: { id: 'd1', conversationId: CONVA } });
    expect(store.getSnapshot().call).toMatchObject({ id: 'd1' });
    store.handleFrame({ type: 'call.ended' });
    expect(store.getSnapshot().call).toBeNull();
  });

  it('error frame records the message and timestamp', () => {
    const before = Date.now();
    store.handleFrame({ type: 'error', message: 'server exploded' });
    const snap = store.getSnapshot();
    expect(snap.lastError).toBe('server exploded');
    expect(snap.lastErrorAt).toBeGreaterThanOrEqual(before);
  });

  it('unknown frame type does not throw', () => {
    expect(() => store.handleFrame({ type: 'made-up-frame' })).not.toThrow();
  });

  it('malformed frame is dropped', () => {
    expect(() => store.handleFrame(null)).not.toThrow();
    expect(() => store.handleFrame({})).not.toThrow();
    expect(() => store.handleFrame({ type: 42 })).not.toThrow();
  });
});

describe('bootstrap / paging / active thread', () => {
  it('ingestBootstrap replaces conversations, contacts, requests, unreadTotal, and seeds presence', () => {
    store.ingestBootstrap({
      user: { id: ALICE, username: 'alice' },
      conversations: [{ id: CONVA, lastBody: 'earlier', lastSeq: 4 }],
      contacts: [{ id: BOB, username: 'bob', presence: 'online' }],
      requests: { incoming: [{ id: 'r1' }], outgoing: [] },
      unread: 2,
      unreadByConversation: { [CONVA]: 2 },
    });
    const snap = store.getSnapshot();
    expect(snap.user.id).toBe(ALICE);
    expect(snap.conversations).toHaveLength(1);
    expect(snap.contacts).toHaveLength(1);
    expect(snap.requests.incoming).toHaveLength(1);
    expect(snap.unreadTotal).toBe(2);
    expect(store.selectPresence(BOB)).toBe('online');
  });

  it('ingestMessages sorts by seq and de-duplicates', () => {
    store.ingestMessages(CONVA, [
      messageFixture({ id: MSG2, seq: 2 }),
      messageFixture({ id: MSG1, seq: 1 }),
      messageFixture({ id: MSG1, seq: 1 }),
    ]);
    const list = store.selectMessages(CONVA);
    expect(list.map((m) => m.seq)).toEqual([1, 2]);
  });

  it('ingestMessages with replace=true discards existing entries', () => {
    store.ingestMessages(CONVA, [messageFixture({ id: MSG1, seq: 1 })]);
    store.ingestMessages(CONVA, [messageFixture({ id: MSG2, seq: 2 })], { replace: true });
    expect(store.selectMessages(CONVA).map((m) => m.id)).toEqual([MSG2]);
  });

  it('setActiveConversation clears local unread AND asks the client to markRead at latest seq', async () => {
    store.ingestMessages(CONVA, [
      messageFixture({ id: MSG1, seq: 5 }),
      messageFixture({ id: MSG2, seq: 7 }),
    ]);
    store.handleFrame({ type: 'unread', byConversation: { [CONVA]: 3 }, total: 3 });
    store.setActiveConversation(CONVA);
    expect(store.selectUnreadFor(CONVA)).toBe(0);
    expect(store.selectActiveId()).toBe(CONVA);
    // markRead fires asynchronously; drain microtasks.
    await Promise.resolve();
    expect(markReadMock).toHaveBeenCalledWith(CONVA, 7);
  });

  it('setActiveConversation with a null id simply clears the active field', () => {
    store.setActiveConversation(CONVA);
    store.setActiveConversation(null);
    expect(store.selectActiveId()).toBeNull();
  });

  it('optimisticSend appends a pending message; reconcilePending swaps it for the server copy', () => {
    const pending = messageFixture({ id: 'pending-1', fromUserId: ALICE, pending: true });
    store.optimisticSend(CONVA, pending);
    expect(store.selectMessages(CONVA).map((m) => m.id)).toEqual(['pending-1']);
    store.reconcilePending(CONVA, 'pending-1', messageFixture({ id: MSG1, fromUserId: ALICE, seq: 1 }));
    const list = store.selectMessages(CONVA);
    expect(list.map((m) => m.id)).toEqual([MSG1]);
    expect(list[0].pending).toBeUndefined();
  });
});

describe('selectors return safe defaults', () => {
  it('selectMessages returns [] for an unknown conversation', () => {
    expect(store.selectMessages('does-not-exist')).toEqual([]);
    expect(store.selectMessages(null)).toEqual([]);
  });

  it('selectUnreadTotal falls back to summing the per-conversation map', () => {
    store.handleFrame({ type: 'message', message: messageFixture({ conversationId: CONVA }) });
    store.handleFrame({ type: 'message', message: messageFixture({ conversationId: 'c2', id: MSG2 }) });
    expect(store.selectUnreadTotal()).toBe(2);
  });

  it('selectPresence returns offline for unknown users', () => {
    expect(store.selectPresence('ghost')).toBe('offline');
  });

  it('WINDOW is exported so Composer can cap local buffers consistently', () => {
    expect(store.WINDOW).toBe(50);
  });
});
