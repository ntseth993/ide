/**
 * NovaLink Live renderer store.
 *
 * A single observable state container that consumes every WS frame the main
 * process forwards on `novalinkLive:event`, plus status snapshots on
 * `novalinkLive:status-event`, and exposes an immutable-ish snapshot compatible
 * with React's `useSyncExternalStore`. Components never call the client
 * directly for read state; they read from here. Write actions (send, markRead,
 * block, etc.) still go through `client.novalinkLive*` and their optimistic
 * bits are merged in by the store's dispatch helpers.
 *
 * The store is intentionally renderer-only. It has no Node APIs, no fs, no ws.
 * It's safe to import from any component or hook.
 */
import { client } from './novaClient';

const TYPING_DECAY_MS = 3000;
const MESSAGE_WINDOW_DEFAULT = 50;

let state = emptyState();
const listeners = new Set();
let typingTicker = null;

function emptyState() {
  return {
    status: null,
    ready: false,
    signedIn: false,
    user: null,
    conversations: [],
    messagesByConversation: {},
    hasMoreByConversation: {},
    presenceByUser: {},
    lastSeenByUser: {},
    typingByConversation: {},
    unreadByConversation: {},
    unreadTotal: 0,
    reactionsByMessage: {},
    directory: [],
    contacts: [],
    requests: { incoming: [], outgoing: [] },
    blocked: [],
    activeConversationId: null,
    lastError: null,
    lastErrorAt: null,
    call: null,
  };
}

function emit() {
  // Copy so subscribers see a fresh top-level identity each time. Selectors
  // are memo-friendly because they compare slice references, which stay stable
  // unless a specific slice was actually rewritten.
  state = { ...state };
  for (const listener of listeners) listener();
}

export function subscribe(listener) {
  listeners.add(listener);
  if (!typingTicker) {
    typingTicker = setInterval(pruneTyping, 500);
    if (typingTicker.unref) typingTicker.unref();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typingTicker) {
      clearInterval(typingTicker);
      typingTicker = null;
    }
  };
}

export function getSnapshot() {
  return state;
}

/** Test seam — reset to a pristine state. */
export function __reset() {
  state = emptyState();
  if (typingTicker) {
    clearInterval(typingTicker);
    typingTicker = null;
  }
}

// ---------------------------------------------------------------------------
// Frame ingestion
// ---------------------------------------------------------------------------

export function handleStatus(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  state = {
    ...state,
    status: snapshot,
    ready: Boolean(snapshot.ready),
    signedIn: Boolean(snapshot.signedIn),
    user: snapshot.user || state.user,
    lastError: snapshot.lastError || null,
    lastErrorAt: snapshot.lastErrorAt || null,
  };
  emit();
}

export function handleFrame(frame) {
  if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') return;
  switch (frame.type) {
    case 'ready':
      state = {
        ...state,
        ready: true,
        signedIn: true,
        user: frame.user || state.user,
      };
      emit();
      break;
    case 'presence':
      applyPresence(frame);
      break;
    case 'typing':
      applyTyping(frame);
      break;
    case 'message':
      applyIncomingMessage(frame);
      break;
    case 'message.updated':
    case 'message.edit':
      applyMessageEdit(frame);
      break;
    case 'message.deleted':
      applyMessageDelete(frame);
      break;
    case 'message.delivered':
      applyDelivery(frame);
      break;
    case 'message.read':
      applyRead(frame);
      break;
    case 'unread':
      applyUnread(frame);
      break;
    case 'reaction':
      applyReaction(frame);
      break;
    case 'connection.request':
      applyConnectionRequest(frame);
      break;
    case 'connection.accepted':
      applyConnectionAccepted(frame);
      break;
    case 'call.incoming':
      state = { ...state, call: frame.call || null };
      emit();
      break;
    case 'call.ended':
      state = { ...state, call: null };
      emit();
      break;
    case 'pong':
      // Server time — useful for drifting our delivery ticks, not the UI today.
      break;
    case 'error':
      state = {
        ...state,
        lastError: frame.message || frame.code || 'server error',
        lastErrorAt: Date.now(),
      };
      emit();
      break;
    default:
      // Unknown frame — leave state alone. The diagnostics panel surfaces it.
      break;
  }
}

function applyPresence(frame) {
  const userId = frame.userId;
  if (!userId) return;
  const presenceByUser = { ...state.presenceByUser, [userId]: frame.status || 'offline' };
  const lastSeenByUser = frame.status === 'offline' && frame.lastSeenAt
    ? { ...state.lastSeenByUser, [userId]: frame.lastSeenAt }
    : state.lastSeenByUser;
  state = { ...state, presenceByUser, lastSeenByUser };
  emit();
}

function applyTyping(frame) {
  const conversationId = frame.conversationId;
  const userId = frame.fromUserId || frame.userId;
  if (!conversationId || !userId) return;
  const perConv = { ...(state.typingByConversation[conversationId] || {}) };
  if (frame.typing) {
    perConv[userId] = { name: frame.name || 'Someone', at: Date.now() };
  } else {
    delete perConv[userId];
  }
  const typingByConversation = { ...state.typingByConversation, [conversationId]: perConv };
  state = { ...state, typingByConversation };
  emit();
}

function pruneTyping() {
  const now = Date.now();
  let mutated = false;
  const typingByConversation = { ...state.typingByConversation };
  for (const [convId, byUser] of Object.entries(typingByConversation)) {
    const surviving = {};
    for (const [userId, entry] of Object.entries(byUser)) {
      if (now - entry.at < TYPING_DECAY_MS) surviving[userId] = entry;
      else mutated = true;
    }
    if (Object.keys(surviving).length === 0) delete typingByConversation[convId];
    else typingByConversation[convId] = surviving;
  }
  if (mutated) {
    state = { ...state, typingByConversation };
    emit();
  }
}

function applyIncomingMessage(frame) {
  const message = frame.message;
  if (!message || !message.conversationId) return;
  const convId = message.conversationId;
  const existing = state.messagesByConversation[convId] || [];
  // De-dupe by id; the server may redeliver on reconnect.
  const alreadyThere = existing.some((entry) => entry.id === message.id);
  const messagesByConversation = alreadyThere
    ? state.messagesByConversation
    : { ...state.messagesByConversation, [convId]: [...existing, message] };
  // Bump conversation recency + unread when we're not actively reading it.
  const isActive = convId === state.activeConversationId;
  const isSelf = state.user && message.fromUserId === state.user.id;
  const unreadByConversation = (!isActive && !isSelf)
    ? { ...state.unreadByConversation, [convId]: (state.unreadByConversation[convId] || 0) + 1 }
    : state.unreadByConversation;
  // Merge into the ordered conversations array.
  const conversations = bumpConversation(state.conversations, convId, message);
  state = {
    ...state,
    messagesByConversation,
    unreadByConversation,
    conversations,
  };
  emit();
  // Fire the native notification if the app is unfocused and this isn't our
  // own message or the thread the user is currently reading.
  if (!isActive && !isSelf && typeof document !== 'undefined' && !document.hasFocus()) {
    notifyFor(message, convId);
  }
}

function bumpConversation(list, convId, message) {
  const idx = list.findIndex((entry) => entry.id === convId);
  const snippet = summarise(message);
  const patched = {
    ...(idx >= 0 ? list[idx] : { id: convId }),
    lastBody: snippet,
    lastAt: message.createdAt || message.timestamp || Date.now(),
    lastSeq: message.seq ?? (idx >= 0 ? list[idx].lastSeq : null),
  };
  if (idx < 0) return [patched, ...list];
  const next = list.slice();
  next.splice(idx, 1);
  return [patched, ...next];
}

function summarise(message) {
  if (!message) return '';
  if (message.attachments?.length && !message.body) {
    return message.attachments.length === 1 ? 'Sent a file' : `Sent ${message.attachments.length} files`;
  }
  if (message.kind === 'code') return message.body ? '``` code ```' : 'Sent code';
  return String(message.body || '').slice(0, 80);
}

function applyMessageEdit(frame) {
  const messageId = frame.messageId || frame.message?.id;
  const convId = frame.conversationId || frame.message?.conversationId;
  if (!messageId || !convId) return;
  const list = state.messagesByConversation[convId];
  if (!list) return;
  const messagesByConversation = {
    ...state.messagesByConversation,
    [convId]: list.map((entry) => (entry.id === messageId
      ? { ...entry, body: frame.message?.body ?? entry.body, editedAt: Date.now() }
      : entry)),
  };
  state = { ...state, messagesByConversation };
  emit();
}

function applyMessageDelete(frame) {
  const messageId = frame.messageId;
  const convId = frame.conversationId;
  if (!messageId || !convId) return;
  const list = state.messagesByConversation[convId];
  if (!list) return;
  const messagesByConversation = {
    ...state.messagesByConversation,
    [convId]: list.map((entry) => (entry.id === messageId ? { ...entry, deleted: true } : entry)),
  };
  state = { ...state, messagesByConversation };
  emit();
}

function applyDelivery(frame) {
  const convId = frame.conversationId;
  const ids = frame.messageIds || (frame.messageId ? [frame.messageId] : []);
  if (!convId || !ids.length) return;
  const list = state.messagesByConversation[convId] || [];
  const set = new Set(ids);
  const messagesByConversation = {
    ...state.messagesByConversation,
    [convId]: list.map((entry) => (set.has(entry.id) ? { ...entry, deliveredAt: Date.now() } : entry)),
  };
  state = { ...state, messagesByConversation };
  emit();
}

function applyRead(frame) {
  const convId = frame.conversationId;
  const upToSeq = frame.seq ?? frame.upToSeq;
  if (!convId || upToSeq == null) return;
  const list = state.messagesByConversation[convId] || [];
  const messagesByConversation = {
    ...state.messagesByConversation,
    [convId]: list.map((entry) => (entry.seq != null && entry.seq <= upToSeq
      ? { ...entry, readAt: entry.readAt || Date.now() }
      : entry)),
  };
  state = { ...state, messagesByConversation };
  emit();
}

function applyUnread(frame) {
  const byConversation = frame.byConversation || {};
  const unreadByConversation = { ...state.unreadByConversation };
  for (const [convId, count] of Object.entries(byConversation)) {
    unreadByConversation[convId] = Number(count) || 0;
  }
  state = {
    ...state,
    unreadByConversation,
    unreadTotal: frame.total != null ? Number(frame.total) || 0 : state.unreadTotal,
  };
  emit();
}

function applyReaction(frame) {
  const messageId = frame.messageId;
  const emoji = frame.emoji;
  const userId = frame.userId;
  if (!messageId || !emoji || !userId) return;
  const perMessage = { ...(state.reactionsByMessage[messageId] || {}) };
  const current = new Set(perMessage[emoji] || []);
  if (frame.removed) current.delete(userId);
  else current.add(userId);
  if (current.size === 0) delete perMessage[emoji];
  else perMessage[emoji] = Array.from(current);
  const reactionsByMessage = { ...state.reactionsByMessage, [messageId]: perMessage };
  state = { ...state, reactionsByMessage };
  emit();
}

function applyConnectionRequest(frame) {
  const req = frame.request || frame;
  const incoming = [req, ...state.requests.incoming.filter((entry) => entry.id !== req.id)];
  state = { ...state, requests: { ...state.requests, incoming } };
  emit();
}

function applyConnectionAccepted(frame) {
  const user = frame.user;
  if (!user?.id) return;
  const contacts = state.contacts.some((entry) => entry.id === user.id)
    ? state.contacts
    : [...state.contacts, user];
  const outgoing = state.requests.outgoing.filter((entry) => entry.toUserId !== user.id);
  state = { ...state, contacts, requests: { ...state.requests, outgoing } };
  emit();
}

async function notifyFor(message, conversationId) {
  try {
    const title = message.fromName || 'NovaLink message';
    const body = summarise(message);
    await client.novalinkLiveNotify({ title, body, conversationId });
  } catch {
    // Notification is best-effort; never fail frame handling over it.
  }
}

// ---------------------------------------------------------------------------
// Bootstrap ingestion (called by Root after `ready`)
// ---------------------------------------------------------------------------

export function ingestBootstrap(data) {
  if (!data || typeof data !== 'object') return;
  const conversations = Array.isArray(data.conversations) ? data.conversations : state.conversations;
  const contacts = Array.isArray(data.contacts) ? data.contacts : state.contacts;
  const requests = data.requests || state.requests;
  const unreadByConversation = data.unreadByConversation || state.unreadByConversation;
  const presenceByUser = { ...state.presenceByUser };
  for (const contact of contacts) {
    if (contact?.id && contact?.presence) presenceByUser[contact.id] = contact.presence;
  }
  state = {
    ...state,
    user: data.user || state.user,
    conversations,
    contacts,
    requests,
    unreadByConversation,
    unreadTotal: data.unread ?? state.unreadTotal,
    presenceByUser,
  };
  emit();
}

export function ingestMessages(conversationId, messages, { hasMore = false, replace = false } = {}) {
  if (!conversationId || !Array.isArray(messages)) return;
  const existing = replace ? [] : (state.messagesByConversation[conversationId] || []);
  const seen = new Set(existing.map((entry) => entry.id));
  const merged = [...existing];
  for (const message of messages) {
    // Guard against a caller supplying duplicates within the same batch as
    // well as against already-stored pages; the server redelivers on reconnect
    // and paging merges old + new chunks into one ingest.
    if (!message || !message.id || seen.has(message.id)) continue;
    merged.push(message);
    seen.add(message.id);
  }
  merged.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  state = {
    ...state,
    messagesByConversation: { ...state.messagesByConversation, [conversationId]: merged },
    hasMoreByConversation: { ...state.hasMoreByConversation, [conversationId]: Boolean(hasMore) },
  };
  emit();
}

export function ingestDirectory(users) {
  state = { ...state, directory: Array.isArray(users) ? users : [] };
  emit();
}

export function ingestContacts(contacts) {
  state = { ...state, contacts: Array.isArray(contacts) ? contacts : [] };
  emit();
}

export function ingestRequests(requests) {
  state = { ...state, requests: requests || { incoming: [], outgoing: [] } };
  emit();
}

export function ingestBlocked(blocked) {
  state = { ...state, blocked: Array.isArray(blocked) ? blocked : [] };
  emit();
}

// ---------------------------------------------------------------------------
// Actions the UI dispatches through the store so optimistic bits stay coherent
// ---------------------------------------------------------------------------

export function setActiveConversation(conversationId) {
  if (state.activeConversationId === conversationId) return;
  state = {
    ...state,
    activeConversationId: conversationId,
    unreadByConversation: { ...state.unreadByConversation, [conversationId]: 0 },
  };
  emit();
  if (conversationId) {
    const list = state.messagesByConversation[conversationId] || [];
    const latest = list[list.length - 1];
    if (latest?.seq != null) {
      client.novalinkLiveMarkRead(conversationId, latest.seq).catch(() => { /* non-fatal */ });
    }
  }
}

export function optimisticSend(conversationId, message) {
  const existing = state.messagesByConversation[conversationId] || [];
  state = {
    ...state,
    messagesByConversation: { ...state.messagesByConversation, [conversationId]: [...existing, message] },
    conversations: bumpConversation(state.conversations, conversationId, message),
  };
  emit();
}

export function reconcilePending(conversationId, pendingId, serverMessage) {
  const existing = state.messagesByConversation[conversationId] || [];
  const filtered = existing.filter((entry) => entry.id !== pendingId);
  const merged = serverMessage ? [...filtered, serverMessage] : filtered;
  state = {
    ...state,
    messagesByConversation: { ...state.messagesByConversation, [conversationId]: merged },
  };
  emit();
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function selectConversations() {
  return state.conversations;
}

export function selectMessages(conversationId) {
  if (!conversationId) return [];
  return state.messagesByConversation[conversationId] || [];
}

export function selectUnreadTotal() {
  return state.unreadTotal || Object.values(state.unreadByConversation).reduce((sum, n) => sum + (n || 0), 0);
}

export function selectUnreadFor(conversationId) {
  return state.unreadByConversation[conversationId] || 0;
}

export function selectPresence(userId) {
  return state.presenceByUser[userId] || 'offline';
}

export function selectTyping(conversationId) {
  const byUser = state.typingByConversation[conversationId];
  if (!byUser) return [];
  const selfId = state.user?.id;
  return Object.entries(byUser)
    .filter(([userId]) => userId !== selfId)
    .map(([, entry]) => entry.name);
}

export function selectActiveId() {
  return state.activeConversationId;
}

export function selectSelf() {
  return state.user;
}

export function selectReactions(messageId) {
  return state.reactionsByMessage[messageId] || {};
}

export function selectStatusSnapshot() {
  return state.status;
}

export const WINDOW = MESSAGE_WINDOW_DEFAULT;
