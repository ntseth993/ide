'use strict';
/**
 * NovaLink Live — main-process client for link-server.
 *
 * This is the ONLY place the desktop app reaches the internet on behalf of the
 * renderer. It:
 *
 *   - holds the session credential in the OS-encrypted secret store and never
 *     returns it across IPC;
 *   - issues real HTTP requests to a closed list of routes (no generic fetch
 *     passthrough the renderer can steer);
 *   - keeps one authenticated WebSocket to `/link`, reconnects with backoff,
 *     and lets the server's own heartbeat drive presence — never the renderer's
 *     lifecycle events;
 *   - forwards every server frame (message, presence, typing, unread,
 *     reaction, call.*) to the renderer on a single, validated event channel.
 *
 * Nothing here is simulated or hardcoded. If link-server rejects a call, the
 * renderer sees the same code the server wrote. If the socket drops, the
 * status snapshot says so honestly.
 */
const { WebSocket } = require('ws');

const TOKEN_SECRET = 'novalink_live_token';
const ID_SHAPE = /^[A-Za-z0-9_.:-]{1,120}$/;
const RECONNECT_STEPS_MS = [500, 1500, 4000, 10000, 30000];
const HTTP_RETRY_STATUSES = new Set([502, 503, 504]);
const MAX_WS_FRAME_BYTES = 1024 * 1024; // 1 MB — matches link-server's client budget.

// Vocabulary the server whitelists on the socket. Kept here so a bad renderer
// call is refused locally rather than round-tripped and bounced back as an
// `unknown_event`/`invalid_signal`/`invalid_status` error we'd have to re-map.
const CALL_SIGNALS = new Set(['offer', 'answer', 'candidate', 'hangup', 'renegotiate', 'mute', 'screen']);
const PRESENCE_STATUSES = new Set(['online', 'away', 'busy', 'offline']);
const MAX_SDP_CHARS = 32000;      // link-server's own ceiling per offer/answer
const MAX_CANDIDATE_BATCH = 60;   // link-server's own ceiling per candidate list

class LiveError extends Error {
  constructor(message, { code = 'client_error', status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'LiveError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function requireId(value, label) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!ID_SHAPE.test(trimmed)) throw new LiveError(`${label} is required.`, { code: 'bad_argument' });
  return trimmed;
}

function requireString(value, label, max = 8000) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new LiveError(`${label} is required.`, { code: 'bad_argument' });
  return text.slice(0, max);
}

function optionalString(value, max = 8000) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function optionalIdOrNull(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed && ID_SHAPE.test(trimmed) ? trimmed : null;
}

function optionalBool(value) {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalInt(value, { min, max } = {}) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const i = Math.floor(n);
  if (min !== undefined && i < min) return min;
  if (max !== undefined && i > max) return max;
  return i;
}

function stringList(value, max = 200) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim().slice(0, max));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} deps
 * @param {{ getSecret: Function, setSecret: Function, clearSecret: Function }} deps.secretStore
 * @param {(frame: object) => void} deps.onEvent   Streams a WS frame to the renderer.
 * @param {(status: object) => void} [deps.onStatusChange]
 * @param {object} deps.logger
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {typeof WebSocket} [deps.wsImpl]
 */
function createLiveClient({ secretStore, onEvent, onStatusChange, logger, fetchImpl, wsImpl }) {
  const doFetch = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const WS = wsImpl || WebSocket;
  if (!doFetch) throw new Error('NovaLink Live needs a fetch-capable runtime (Node 18+).');
  const log = logger || { info() {}, warn() {}, error() {}, debug() {} };

  const state = {
    baseUrl: '',
    token: null,
    user: null,
    privacy: null,
    server: null,
    connected: false,
    ready: false,
    lastError: null,
    lastErrorAt: null,
    reconnectAttempt: 0,
    reconnectTimer: null,
    socket: null,
    disposed: false,
    deviceLabel: `NovaCode@${process.platform}`,
  };

  // ---- base URL -------------------------------------------------------------
  function normalizeBaseUrl(raw) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return '';
    let url;
    try { url = new URL(value); }
    catch { throw new LiveError('The NovaLink server address is not a valid URL.', { code: 'bad_base_url' }); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new LiveError('NovaLink Live only speaks http:// or https:// to a link-server.', { code: 'bad_base_url' });
    }
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  }

  function emitStatus() {
    if (typeof onStatusChange === 'function') {
      try { onStatusChange(statusSnapshot()); } catch (error) { log.warn?.('live status listener threw', { error: error.message }); }
    }
  }

  function setBaseUrl(raw) {
    const next = normalizeBaseUrl(raw);
    if (next === state.baseUrl) return next;
    state.baseUrl = next;
    // A base-URL change is a different server: forget the credential and drop
    // the socket so we never reuse a token against an unrelated origin. The
    // OS-encrypted copy must go too, otherwise a restart would restore it and
    // the very next `boot()` would try the old bearer against the new server.
    closeSocket('base url changed');
    state.token = null;
    state.user = null;
    state.ready = false;
    state.connected = false;
    secretStore.clearSecret(TOKEN_SECRET).catch((error) => log.warn?.('clear token on base-url change failed', { error: error.message }));
    emitStatus();
    return next;
  }

  // ---- HTTP ----------------------------------------------------------------
  function httpUrl(route, query) {
    const url = new URL(`${state.baseUrl}${route}`);
    if (query && typeof query === 'object') {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async function request(method, route, { body, query, rawBody, headers = {}, contentType = 'application/json', expectJson = true, retries = 2 } = {}) {
    if (!state.baseUrl) throw new LiveError('NovaLink is not configured. Set the server address in Settings.', { code: 'no_base_url' });
    const url = httpUrl(route, query);
    const finalHeaders = { accept: 'application/json', ...headers };
    if (state.token) finalHeaders.authorization = `Bearer ${state.token}`;
    let payload;
    if (rawBody !== undefined) {
      payload = rawBody;
      if (contentType) finalHeaders['content-type'] = contentType;
    } else if (body !== undefined) {
      finalHeaders['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let attempt = 0;
    let lastError;
    while (attempt <= retries) {
      attempt += 1;
      try {
        const response = await doFetch(url, {
          method,
          headers: finalHeaders,
          body: payload,
          duplex: rawBody !== undefined ? 'half' : undefined,
        });
        const status = response.status;
        const text = expectJson ? await response.text() : null;
        let json = {};
        if (expectJson) {
          try { json = text ? JSON.parse(text) : {}; }
          catch { json = { code: 'bad_response', message: 'Server returned a non-JSON response.' }; }
        }
        if (response.ok) return json;
        // 5xx transient? retry with a short backoff.
        if (HTTP_RETRY_STATUSES.has(status) && attempt <= retries) {
          await sleep(120 * attempt);
          continue;
        }
        const err = json && json.error ? json.error : {};
        throw new LiveError(err.message || `Request failed with status ${status}.`, {
          code: err.code || `http_${status}`,
          status,
          retryable: HTTP_RETRY_STATUSES.has(status),
        });
      } catch (error) {
        lastError = error;
        if (error instanceof LiveError) throw error;
        // Network / DNS / TLS errors: report as unreachable after exhausting retries.
        if (attempt > retries) break;
        await sleep(200 * attempt);
      }
    }
    throw new LiveError(`NovaLink server is unreachable: ${lastError && lastError.message ? lastError.message : 'unknown error'}.`, { code: 'unreachable', retryable: true });
  }

  // ---- session/token -------------------------------------------------------
  async function loadTokenFromStore() {
    try {
      const stored = await secretStore.getSecret(TOKEN_SECRET);
      if (typeof stored === 'string' && stored) {
        state.token = stored;
        return true;
      }
    } catch (error) {
      log.warn?.('live token read failed', { error: error.message });
    }
    state.token = null;
    return false;
  }

  async function rememberToken(token) {
    state.token = token || null;
    if (token) await secretStore.setSecret(TOKEN_SECRET, token);
    else await secretStore.clearSecret(TOKEN_SECRET);
  }

  // ---- websocket -----------------------------------------------------------
  function wsUrl() {
    if (!state.baseUrl) return '';
    const url = new URL(state.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/link';
    return url.toString();
  }

  function closeSocket(reason) {
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    if (state.socket) {
      const sock = state.socket;
      state.socket = null;
      try { sock.close(1000, reason || 'client closing'); } catch { /* already gone */ }
    }
    state.connected = false;
    state.ready = false;
  }

  function scheduleReconnect() {
    if (state.disposed || !state.baseUrl || !state.token) return;
    if (state.reconnectTimer) return;
    const delay = RECONNECT_STEPS_MS[Math.min(state.reconnectAttempt, RECONNECT_STEPS_MS.length - 1)];
    state.reconnectAttempt += 1;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      openSocket().catch(() => { /* next attempt is already scheduled */ });
    }, delay);
    if (state.reconnectTimer.unref) state.reconnectTimer.unref();
  }

  function openSocket() {
    if (state.disposed || !state.baseUrl || !state.token) return Promise.resolve(false);
    if (state.socket) return Promise.resolve(true);
    const url = wsUrl();
    let settled = false;
    return new Promise((resolve) => {
      let sock;
      try { sock = new WS(url, { maxPayload: MAX_WS_FRAME_BYTES, handshakeTimeout: 6000 }); }
      catch (error) {
        state.lastError = `socket create failed: ${error.message}`;
        emitStatus();
        scheduleReconnect();
        resolve(false);
        return;
      }
      state.socket = sock;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };

      sock.addEventListener('open', () => {
        state.connected = true;
        state.lastError = null;
        state.reconnectAttempt = 0;
        try { sock.send(JSON.stringify({ type: 'auth', token: state.token, deviceLabel: state.deviceLabel })); }
        catch (error) { log.warn?.('auth send failed', { error: error.message }); }
        emitStatus();
        finish(true);
      });
      sock.addEventListener('message', (event) => {
        const data = typeof event.data === 'string' ? event.data : (event.data && event.data.toString ? event.data.toString('utf8') : '');
        let frame;
        try { frame = JSON.parse(data); } catch { return; }
        if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') return;
        if (frame.type === 'ready') {
          state.ready = true;
          if (frame.user) state.user = frame.user;
          if (frame.privacy) state.privacy = frame.privacy;
          // link-server's `ready` frame carries `rtc` + `limits` at the top level
          // (see hub.js). The REST `/api/bootstrap` response nests them under
          // `server`, so we normalise here to one shape the renderer can read
          // regardless of which path filled it in.
          state.server = {
            rtc: frame.rtc || (state.server && state.server.rtc) || null,
            limits: frame.limits || (state.server && state.server.limits) || null,
            serverTime: frame.serverTime || null,
            sessions: frame.sessions || (state.server && state.server.sessions) || null,
          };
          emitStatus();
        }
        if (frame.type === 'error' && frame.code === 'unauthorized') {
          // The credential is dead: forget it so we do not spin reconnecting.
          state.token = null;
          state.user = null;
          secretStore.clearSecret(TOKEN_SECRET).catch(() => {});
          closeSocket('session expired');
          emitStatus();
          return;
        }
        if (typeof onEvent === 'function') {
          try { onEvent(frame); } catch (error) { log.warn?.('live event listener threw', { error: error.message }); }
        }
      });
      sock.addEventListener('close', (event) => {
        state.connected = false;
        state.ready = false;
        state.socket = null;
        const code = event && event.code;
        const reason = String((event && event.reason) || '');
        // 1008 + "session rejected" is the only place the server tells us our
        // bearer credential is dead during the socket handshake (hub.js:101).
        // Without this branch we would reconnect-loop against a revoked token
        // for the rest of the process's life, silently.
        if (code === 1008 && /session rejected|authenticate before/i.test(reason)) {
          state.token = null;
          state.user = null;
          state.lastError = 'Your session has ended. Sign in again.';
          state.lastErrorAt = Date.now();
          secretStore.clearSecret(TOKEN_SECRET).catch(() => {});
          emitStatus();
          finish(false);
          return;
        }
        // 1012 = "session replaced" (another device opened the same session id).
        // Do NOT clear the token — it is still valid; just retry after a beat.
        emitStatus();
        scheduleReconnect();
        finish(false);
      });
      sock.addEventListener('error', (event) => {
        state.lastError = (event && event.message) || 'socket error';
        emitStatus();
      });
      setTimeout(() => { if (!settled) finish(false); }, 8000).unref?.();
    });
  }

  function sendFrame(frame) {
    if (!state.socket || !state.connected) throw new LiveError('NovaLink is not connected. Check the server address and your network.', { code: 'not_connected' });
    try { state.socket.send(JSON.stringify(frame)); return { ok: true }; }
    catch (error) { throw new LiveError(`Could not send: ${error.message}`, { code: 'send_failed' }); }
  }

  // ---- public surface ------------------------------------------------------
  function statusSnapshot() {
    return {
      configured: Boolean(state.baseUrl),
      baseUrl: state.baseUrl || '',
      signedIn: Boolean(state.token),
      connected: state.connected,
      ready: state.ready,
      user: state.user,
      privacy: state.privacy,
      server: state.server,
      reconnectAttempt: state.reconnectAttempt,
      lastError: state.lastError,
      lastErrorAt: state.lastErrorAt,
    };
  }

  async function boot({ baseUrl, autoConnect = true } = {}) {
    if (typeof baseUrl === 'string' && baseUrl.trim()) setBaseUrl(baseUrl);
    await loadTokenFromStore();
    if (state.token && autoConnect) {
      try {
        const me = await request('GET', '/api/me');
        state.user = me.user || null;
        state.privacy = me.privacy || null;
        state.server = me.server || null;
        emitStatus();
      } catch (error) {
        // A dead credential is forgotten; a network error keeps it so the next
        // boot can try again without asking the developer to log in.
        if (error.status === 401 || error.code === 'unauthorized') await rememberToken(null);
        else { state.lastError = error.message; state.lastErrorAt = Date.now(); }
      }
      if (state.token) openSocket();
    }
    return statusSnapshot();
  }

  async function configure(payload = {}) {
    const next = typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : '';
    if (next) setBaseUrl(next);
    return statusSnapshot();
  }

  async function register({ username, password, displayName, bio } = {}) {
    const body = {
      username: requireString(username, 'A username', 32),
      password: requireString(password, 'A password', 256),
      displayName: optionalString(displayName, 64) || undefined,
      bio: optionalString(bio, 500) || undefined,
    };
    const result = await request('POST', '/api/register', { body });
    await rememberToken(result.token);
    state.user = result.user;
    state.privacy = result.privacy;
    state.server = result.server;
    emitStatus();
    openSocket();
    // `token` is deliberately not returned. The renderer never needs it; the
    // main process holds it in the OS-encrypted store.
    return { user: state.user, privacy: state.privacy, server: state.server, sessions: result.sessions };
  }

  async function login({ username, password } = {}) {
    const body = {
      username: requireString(username, 'A username', 64),
      password: requireString(password, 'A password', 256),
      deviceLabel: state.deviceLabel,
    };
    const result = await request('POST', '/api/login', { body });
    await rememberToken(result.token);
    state.user = result.user;
    state.privacy = result.privacy;
    state.server = result.server;
    emitStatus();
    openSocket();
    return { user: state.user, privacy: state.privacy, server: state.server, sessions: result.sessions };
  }

  async function logout() {
    try { if (state.token) await request('POST', '/api/logout', { body: {} }); } catch { /* still clear locally */ }
    await rememberToken(null);
    state.user = null;
    state.privacy = null;
    closeSocket('signed out');
    emitStatus();
    return { ok: true };
  }

  async function me() {
    const result = await request('GET', '/api/me');
    state.user = result.user;
    state.privacy = result.privacy;
    state.server = result.server;
    emitStatus();
    return result;
  }

  async function bootstrap() {
    const result = await request('GET', '/api/bootstrap');
    state.user = result.user;
    state.privacy = result.privacy;
    state.server = result.server || state.server;
    emitStatus();
    return result;
  }

  async function updateProfile(payload = {}) {
    const body = {};
    if (payload.displayName !== undefined) body.displayName = optionalString(payload.displayName, 64);
    if (payload.bio !== undefined) body.bio = optionalString(payload.bio, 500);
    const result = await request('PATCH', '/api/me', { body });
    state.user = result.user;
    emitStatus();
    return result;
  }

  async function uploadAvatar({ bytes, fileName }) {
    if (!bytes || typeof bytes.length !== 'number') throw new LiveError('Avatar bytes are required.', { code: 'bad_argument' });
    const query = { fileName: optionalString(fileName, 128) || 'avatar.png' };
    const result = await request('POST', '/api/me/avatar', { rawBody: Buffer.from(bytes), query, contentType: 'application/octet-stream' });
    state.user = result.user;
    emitStatus();
    return result;
  }

  async function deleteAvatar() {
    const result = await request('DELETE', '/api/me/avatar');
    state.user = result.user;
    emitStatus();
    return result;
  }

  async function changePassword({ currentPassword, newPassword } = {}) {
    const result = await request('PUT', '/api/me/password', { body: { currentPassword: requireString(currentPassword, 'Your current password', 256), newPassword: requireString(newPassword, 'A new password', 256) } });
    // Server revoked every session; our token is now dead locally too.
    await rememberToken(null);
    closeSocket('password changed');
    state.user = null;
    emitStatus();
    return result;
  }

  async function updatePrivacy(payload = {}) {
    const body = {};
    for (const key of ['presenceVisibleTo', 'contactRequestsFrom']) {
      if (payload[key] !== undefined) body[key] = optionalString(payload[key], 32);
    }
    for (const key of ['appearOffline', 'showLastActive', 'readReceiptsEnabled', 'callsEnabled', 'attachmentsEnabled']) {
      const v = optionalBool(payload[key]);
      if (v !== undefined) body[key] = v;
    }
    const result = await request('PUT', '/api/me/privacy', { body });
    state.privacy = result.privacy;
    emitStatus();
    return result;
  }

  // ---- directory -----------------------------------------------------------
  async function searchUsers({ q, limit } = {}) {
    return request('GET', '/api/users/search', { query: { q: optionalString(q, 64), limit: optionalInt(limit, { min: 1, max: 50 }) } });
  }
  async function getUser(id) { return request('GET', `/api/users/${requireId(id, 'User id')}`); }

  // ---- connections ---------------------------------------------------------
  async function listContacts() { return request('GET', '/api/contacts'); }
  async function listRequests() { return request('GET', '/api/requests'); }
  async function requestConnection(payload = {}) {
    const body = {};
    const userId = optionalIdOrNull(payload.userId);
    const username = optionalString(payload.username, 64);
    if (userId) body.userId = userId;
    if (username) body.username = username;
    body.message = optionalString(payload.message, 240) || undefined;
    if (!body.userId && !body.username) throw new LiveError('A user id or a username is required.', { code: 'bad_argument' });
    return request('POST', '/api/requests', { body });
  }
  async function acceptRequest(id) { return request('POST', `/api/requests/${requireId(id, 'Request id')}/accept`, { body: {} }); }
  async function rejectRequest(id) { return request('POST', `/api/requests/${requireId(id, 'Request id')}/reject`, { body: {} }); }
  async function removeContact(id) { return request('DELETE', `/api/contacts/${requireId(id, 'User id')}`); }
  async function listBlocked() { return request('GET', '/api/blocked'); }
  async function blockUser(userId) { return request('POST', '/api/block', { body: { userId: requireId(userId, 'User id') } }); }
  async function unblockUser(id) { return request('DELETE', `/api/block/${requireId(id, 'User id')}`); }
  async function reportUser(payload = {}) {
    return request('POST', '/api/report', { body: { userId: requireId(payload.userId, 'User id'), reason: optionalString(payload.reason, 80) || undefined, detail: optionalString(payload.detail, 1000) || undefined } });
  }

  // ---- conversations -------------------------------------------------------
  async function listConversations() { return request('GET', '/api/conversations'); }
  async function createConversation(payload = {}) {
    const body = { kind: optionalString(payload.kind, 12) || undefined };
    const otherUserId = optionalIdOrNull(payload.otherUserId);
    if (otherUserId) body.otherUserId = otherUserId;
    if (Array.isArray(payload.memberIds)) body.memberIds = payload.memberIds.map((id) => requireId(id, 'Member id')).slice(0, 200);
    const title = optionalString(payload.title, 120);
    if (title) body.title = title;
    return request('POST', '/api/conversations', { body });
  }
  async function getConversation(id) { return request('GET', `/api/conversations/${requireId(id, 'Conversation id')}`); }
  async function listMessages(id, { before, limit } = {}) {
    return request('GET', `/api/conversations/${requireId(id, 'Conversation id')}/messages`, { query: { before: optionalString(before, 120), limit: optionalInt(limit, { min: 1, max: 200 }) } });
  }
  async function sendMessage(id, payload = {}) {
    const body = {
      body: requireString(payload.body, 'A message', 8000),
      language: optionalString(payload.language, 24) || undefined,
      replyToId: optionalIdOrNull(payload.replyToId) || undefined,
      clientId: optionalString(payload.clientId, 64) || undefined,
    };
    if (Array.isArray(payload.attachmentIds)) {
      body.attachmentIds = payload.attachmentIds.map((fileId) => requireId(fileId, 'File id')).slice(0, 20);
    }
    return request('POST', `/api/conversations/${requireId(id, 'Conversation id')}/messages`, { body });
  }
  async function markRead(id, seq) {
    return request('POST', `/api/conversations/${requireId(id, 'Conversation id')}/read`, { body: { seq: optionalInt(seq, { min: 0, max: 1_000_000_000 }) } });
  }
  async function listAttachments(id) { return request('GET', `/api/conversations/${requireId(id, 'Conversation id')}/attachments`); }
  async function searchMessages({ q, conversationId, limit } = {}) {
    return request('GET', '/api/messages/search', { query: { q: optionalString(q, 120), conversationId: optionalString(conversationId, 120), limit: optionalInt(limit, { min: 1, max: 50 }) } });
  }

  // ---- reactions -----------------------------------------------------------
  async function addReaction(messageId, emoji) {
    return request('POST', `/api/messages/${requireId(messageId, 'Message id')}/reactions`, { body: { emoji: requireString(emoji, 'An emoji', 32) } });
  }
  async function removeReaction(messageId, emoji) {
    return request('DELETE', `/api/messages/${requireId(messageId, 'Message id')}/reactions`, { query: { emoji: requireString(emoji, 'An emoji', 32) } });
  }

  // ---- files ---------------------------------------------------------------
  async function uploadFile({ conversationId, bytes, fileName }) {
    if (!bytes || typeof bytes.length !== 'number') throw new LiveError('File bytes are required.', { code: 'bad_argument' });
    const query = {
      conversationId: requireId(conversationId, 'Conversation id'),
      fileName: optionalString(fileName, 200) || 'file.bin',
      bytes: bytes.length,
    };
    return request('POST', '/api/uploads', { rawBody: Buffer.from(bytes), query, contentType: 'application/octet-stream' });
  }
  async function downloadFile(id) {
    const url = `${state.baseUrl}/api/files/${requireId(id, 'File id')}`;
    if (!state.token) throw new LiveError('Sign in before downloading.', { code: 'unauthorized' });
    const response = await doFetch(url, { headers: { authorization: `Bearer ${state.token}` } });
    if (!response.ok) throw new LiveError(`Download failed with status ${response.status}.`, { code: 'download_failed', status: response.status });
    const buf = Buffer.from(await response.arrayBuffer());
    return {
      bytes: buf,
      mimeType: response.headers.get('content-type') || 'application/octet-stream',
      disposition: response.headers.get('content-disposition') || '',
      sha256: response.headers.get('x-content-sha256') || '',
    };
  }
  async function deleteFile(id) { return request('DELETE', `/api/files/${requireId(id, 'File id')}`); }

  /**
   * URL only. `/api/avatars/:id` requires the bearer header, so this URL is
   * never usable directly from a renderer <img>. Kept for developer debug and
   * for the (rare) case a shared avatar is opened in a browser after re-auth.
   * Renderer code must call `fetchAvatar` and receive bytes back.
   */
  function avatarUrl(id) { return `${state.baseUrl}/api/avatars/${requireId(id, 'Avatar id')}`; }

  /** Avatar bytes + mime type, fetched through the main process so the token
   *  never leaves it. Returns `null` when there is no configured base URL or
   *  the server says the avatar does not exist — a broken <img> tag would be
   *  worse than a missing one. */
  async function fetchAvatar(id) {
    const avatarId = optionalIdOrNull(id);
    if (!avatarId || !state.baseUrl || !state.token) return null;
    const url = `${state.baseUrl}/api/avatars/${avatarId}`;
    const response = await doFetch(url, { headers: { authorization: `Bearer ${state.token}`, accept: 'image/*' } });
    if (!response.ok) return null;
    const buf = Buffer.from(await response.arrayBuffer());
    return { bytes: buf, mimeType: response.headers.get('content-type') || 'application/octet-stream' };
  }

  // ---- calls ---------------------------------------------------------------
  async function startCall(conversationId, mode) {
    return request('POST', `/api/conversations/${requireId(conversationId, 'Conversation id')}/calls`, { body: { mode: optionalString(mode, 12) || 'audio' } });
  }
  async function acceptCall(id) { return request('POST', `/api/calls/${requireId(id, 'Call id')}/accept`, { body: {} }); }
  async function declineCall(id) { return request('POST', `/api/calls/${requireId(id, 'Call id')}/decline`, { body: {} }); }
  async function endCall(id, reason) { return request('POST', `/api/calls/${requireId(id, 'Call id')}/end`, { body: { reason: optionalString(reason, 40) || undefined } }); }
  async function cancelCall(id) { return request('POST', `/api/calls/${requireId(id, 'Call id')}/cancel`, { body: {} }); }
  async function currentCall() { return request('GET', '/api/calls/current'); }
  async function callHistory(conversationId, limit) { return request('GET', `/api/conversations/${requireId(conversationId, 'Conversation id')}/calls`, { query: { limit: optionalInt(limit, { min: 1, max: 50 }) } }); }

  // ---- realtime frames the client may push --------------------------------
  //
  // link-server (events.js) accepts EXACTLY five inbound client frame types:
  //   ping, presence, typing, message.read, call.signal
  // Anything else is refused with `unknown_event`, so this block is closed on
  // purpose. Durable actions (send a message, upload a file, add a reaction,
  // start/accept/decline/end a call) belong to REST, not here.

  function sendPing(id) {
    const frame = { type: 'ping' };
    if (typeof id === 'string' && id) frame.id = id.slice(0, 64);
    return sendFrame(frame);
  }

  function sendPresence(status) {
    const next = typeof status === 'string' ? status.trim().toLowerCase() : '';
    if (!PRESENCE_STATUSES.has(next)) {
      throw new LiveError(`Presence status must be one of: ${[...PRESENCE_STATUSES].join(', ')}.`, { code: 'bad_argument' });
    }
    return sendFrame({ type: 'presence', status: next });
  }

  function sendTyping({ conversationId, typing }) {
    return sendFrame({ type: 'typing', conversationId: requireId(conversationId, 'Conversation id'), typing: typing !== false });
  }

  function sendMessageRead({ conversationId, seq }) {
    return sendFrame({ type: 'message.read', conversationId: requireId(conversationId, 'Conversation id'), seq: optionalInt(seq, { min: 0, max: 1_000_000_000 }) || 0 });
  }

  /**
   * WebRTC signalling relay.
   *
   * The wire shape (link-server/events.js:96-117 + calls.js:269-342) is
   * `{type:'call.signal', callId, toUserId, signal, payload}` — the frame's
   * own `type` is the envelope, and `signal` carries the kind (offer/answer/
   * candidate/hangup/renegotiate/mute/screen). `payload` is validated per
   * kind by the server, so we only clip sizes and forward verbatim.
   */
  function sendCallSignal(payload = {}) {
    const callId = requireId(payload.callId, 'Call id');
    const toUserId = requireId(payload.toUserId, 'Peer id');
    const kind = typeof payload.signal === 'string' ? payload.signal.trim().toLowerCase() : '';
    if (!CALL_SIGNALS.has(kind)) {
      throw new LiveError(`call.signal must name one of: ${[...CALL_SIGNALS].join(', ')}.`, { code: 'bad_argument' });
    }
    const body = payload.payload;
    let clipped;
    if (kind === 'offer' || kind === 'answer') {
      const sdp = typeof body?.sdp === 'string' ? body.sdp : '';
      if (!sdp || sdp.length > MAX_SDP_CHARS) {
        throw new LiveError(`An offer/answer must be 1-${MAX_SDP_CHARS} characters.`, { code: 'bad_argument' });
      }
      clipped = { sdp, type: body?.type === kind ? body.type : kind };
    } else if (kind === 'candidate') {
      const list = Array.isArray(body?.candidates) ? body.candidates : (body ? [body] : []);
      if (!list.length || list.length > MAX_CANDIDATE_BATCH) {
        throw new LiveError(`A candidate batch holds 1-${MAX_CANDIDATE_BATCH} entries.`, { code: 'bad_argument' });
      }
      clipped = {
        candidates: list.map((c) => ({
          candidate: typeof c?.candidate === 'string' ? c.candidate.slice(0, 600) : '',
          sdpMid: c?.sdpMid === undefined || c?.sdpMid === null ? null : String(c.sdpMid).slice(0, 40),
          sdpMLineIndex: Number.isInteger(c?.sdpMLineIndex) ? c.sdpMLineIndex : null,
        })),
      };
    } else if (kind === 'mute' || kind === 'screen') {
      clipped = {
        audio: body?.audio === undefined ? null : Boolean(body.audio),
        video: body?.video === undefined ? null : Boolean(body.video),
        screen: body?.screen === undefined ? null : Boolean(body.screen),
        reason: body?.reason ? String(body.reason).slice(0, 80) : null,
      };
    } else {
      clipped = {};
    }
    return sendFrame({ type: 'call.signal', callId, toUserId, signal: kind, payload: clipped });
  }

  async function reconnectNow() {
    closeSocket('manual reconnect');
    state.reconnectAttempt = 0;
    if (!state.baseUrl || !state.token) return statusSnapshot();
    await openSocket();
    return statusSnapshot();
  }

  async function dispose() {
    state.disposed = true;
    closeSocket('app quitting');
    state.baseUrl = '';
    state.token = null;
    state.user = null;
  }

  return {
    // lifecycle
    boot, configure, dispose, reconnectNow,
    status: statusSnapshot,
    // auth + profile
    register, login, logout, me, bootstrap,
    updateProfile, uploadAvatar, deleteAvatar, changePassword, updatePrivacy,
    // directory + connections
    searchUsers, getUser, listContacts, listRequests, requestConnection,
    acceptRequest, rejectRequest, removeContact,
    listBlocked, blockUser, unblockUser, reportUser,
    // conversations + messages
    listConversations, createConversation, getConversation, listMessages, sendMessage,
    markRead, listAttachments, searchMessages, addReaction, removeReaction,
    // files
    uploadFile, downloadFile, deleteFile, avatarUrl, fetchAvatar,
    // calls
    startCall, acceptCall, declineCall, endCall, cancelCall, currentCall, callHistory,
    // realtime frames (exactly the five the server accepts)
    sendPing, sendPresence, sendTyping, sendMessageRead, sendCallSignal,
  };
}

module.exports = { createLiveClient, LiveError };
