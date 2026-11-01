/**
 * IPC contract tests.
 *
 * Registers the real registry with injected electron hooks, then invokes the
 * captured handlers exactly the way Electron does: (event, ...args). This
 * pins the preload<->main argument contract — a handler that forgets the
 * leading _event parameter receives the event object as its payload and
 * fails here instead of at runtime for users.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const channels = new Map();
const externalOpens = [];
const ipcMainStub = {
  handle: (channel, fn) => channels.set(channel, fn),
};
const shellStub = {
  openExternal: (url) => externalOpens.push(url),
};

const fsStubs = {
  readTree: vi.fn(async () => []),
  readFile: vi.fn(async () => 'old content\n'),
  writeFile: vi.fn(async () => ({})),
  createFile: vi.fn(async () => ({})),
  createFolder: vi.fn(async () => ({})),
  rename: vi.fn(async () => ({})),
  remove: vi.fn(async () => ({})),
  search: vi.fn(async () => []),
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), redact: (v) => v };
const services = {
  getWindow: () => null,
  app: { quit: vi.fn(), getVersion: () => '1.0.0' },
  createNewWindow: vi.fn(() => ({ ok: true })),
  openFileForWindow: vi.fn(async () => ({ ok: true })),
  ipcMain: ipcMainStub,
  shell: shellStub,
  fs: fsStubs,
  history: {
    record: vi.fn(() => ({ id: 'ch-test-1', ts: '2026-10-18T00:00:00.000Z' })),
    list: vi.fn(() => []),
    restore: vi.fn(() => ({ filePath: 'a.js', content: 'restored\n' })),
  },
  extensions: {
    list: vi.fn(async () => ({ installed: [], available: [], exampleCatalog: true })),
    install: vi.fn(async () => ({ ok: true })),
    update: vi.fn(async () => ({ ok: true, updated: false })),
    setEnabled: vi.fn(async () => ({ ok: true })),
    uninstall: vi.fn(async () => ({ ok: true })),
  },
  registry: {
    search: vi.fn(async ({ query }) => ({ results: [{ id: 'x.y', name: 'y', namespace: 'x', query }], total: 1 })),
    install: vi.fn(async (payload) => ({ ok: true, manifest: { id: `${payload.namespace}.${payload.name}` } })),
  },
  runtime: {
    detectAll: vi.fn(async () => ({ runtimes: [], detectedAt: '2026-10-18T00:00:00.000Z' })),
  },
  novalink: {
    // NovaLink Live — every method is a stub that resolves with a marker so the
    // assertions can confirm the channel dispatched to the right one, and the
    // arguments arrived with the shape the client expects.
    status: vi.fn(() => ({ configured: true, baseUrl: 'https://link.test', signedIn: false, connected: false, ready: false, user: null, privacy: null, server: null, reconnectAttempt: 0, lastError: null, lastErrorAt: null })),
    boot: vi.fn(async (payload) => ({ ok: true, boot: payload })),
    configure: vi.fn(async (payload) => ({ ok: true, configured: payload.baseUrl })),
    reconnectNow: vi.fn(async () => ({ ok: true })),
    register: vi.fn(async (payload) => ({ user: { id: 'a'.repeat(8) + '-0000-0000-0000-000000000000', username: payload.username }, privacy: null, server: null, sessions: [] })),
    login: vi.fn(async (payload) => ({ user: { username: payload.username }, privacy: null, server: null, sessions: [] })),
    logout: vi.fn(async () => ({ ok: true })),
    me: vi.fn(async () => ({ user: { username: 'ada' }, privacy: null, server: null })),
    bootstrap: vi.fn(async () => ({ user: { username: 'ada' }, contacts: [], conversations: [], requests: { incoming: [], outgoing: [] }, unread: 0 })),
    updateProfile: vi.fn(async (payload) => ({ user: { displayName: payload.displayName } })),
    uploadAvatar: vi.fn(async (payload) => ({ avatarId: 'b'.repeat(8) + '-0000-0000-0000-000000000000', bytes: payload.bytes.length })),
    deleteAvatar: vi.fn(async () => ({ ok: true })),
    changePassword: vi.fn(async () => ({ ok: true, sessions: [] })),
    updatePrivacy: vi.fn(async (payload) => ({ privacy: payload })),
    searchUsers: vi.fn(async (payload) => ({ users: [], query: payload.q })),
    getUser: vi.fn(async (userId) => ({ user: { id: userId } })),
    listContacts: vi.fn(async () => ({ contacts: [] })),
    listRequests: vi.fn(async () => ({ incoming: [], outgoing: [] })),
    requestConnection: vi.fn(async (payload) => ({ ok: true, ...payload })),
    acceptRequest: vi.fn(async (requestId) => ({ ok: true, requestId })),
    rejectRequest: vi.fn(async (requestId) => ({ ok: true, requestId })),
    removeContact: vi.fn(async (userId) => ({ ok: true, userId })),
    listBlocked: vi.fn(async () => ({ blocked: [] })),
    blockUser: vi.fn(async (userId) => ({ ok: true, userId })),
    unblockUser: vi.fn(async (userId) => ({ ok: true, userId })),
    reportUser: vi.fn(async (payload) => ({ ok: true, ...payload })),
    listConversations: vi.fn(async () => ({ conversations: [] })),
    createConversation: vi.fn(async (payload) => ({ conversation: { id: 'c'.repeat(8) + '-0000-0000-0000-000000000000', ...payload } })),
    getConversation: vi.fn(async (conversationId) => ({ conversation: { id: conversationId } })),
    listMessages: vi.fn(async (conversationId, opts) => ({ messages: [], conversationId, ...opts })),
    sendMessage: vi.fn(async (conversationId, payload) => ({ message: { id: 'm'.repeat(8) + '-0000-0000-0000-000000000000', conversationId, ...payload } })),
    markRead: vi.fn(async (conversationId, seq) => ({ ok: true, conversationId, seq })),
    listAttachments: vi.fn(async (conversationId) => ({ attachments: [], conversationId })),
    searchMessages: vi.fn(async (payload) => ({ results: [], query: payload.q })),
    addReaction: vi.fn(async (messageId, emoji) => ({ ok: true, messageId, emoji })),
    removeReaction: vi.fn(async (messageId, emoji) => ({ ok: true, messageId, emoji })),
    uploadFile: vi.fn(async (payload) => ({ file: { id: 'f'.repeat(8) + '-0000-0000-0000-000000000000', bytes: payload.bytes.length, fileName: payload.fileName } })),
    downloadFile: vi.fn(async (fileId) => ({ bytes: Buffer.alloc(4), mimeType: 'application/octet-stream', disposition: '', sha256: '', fileId })),
    deleteFile: vi.fn(async (fileId) => ({ ok: true, fileId })),
    avatarUrl: vi.fn((avatarId) => `https://link.test/api/avatars/${avatarId}`),
    fetchAvatar: vi.fn(async (avatarId) => ({ bytes: Buffer.alloc(2), mimeType: 'image/png', avatarId })),
    startCall: vi.fn(async (conversationId, mode) => ({ call: { id: 'd'.repeat(8) + '-0000-0000-0000-000000000000', conversationId, mode }, ringing: [], relayWarning: null })),
    acceptCall: vi.fn(async (callId) => ({ ok: true, callId })),
    declineCall: vi.fn(async (callId) => ({ ok: true, callId })),
    endCall: vi.fn(async (callId, reason) => ({ ok: true, callId, reason })),
    cancelCall: vi.fn(async (callId) => ({ ok: true, callId })),
    currentCall: vi.fn(async () => ({ call: null })),
    callHistory: vi.fn(async (conversationId) => ({ calls: [], conversationId })),
    sendPing: vi.fn((id) => ({ ok: true, id })),
    sendPresence: vi.fn((status) => ({ ok: true, status })),
    sendTyping: vi.fn((payload) => ({ ok: true, ...payload })),
    sendMessageRead: vi.fn((payload) => ({ ok: true, ...payload })),
    sendCallSignal: vi.fn((payload) => ({ ok: true, ...payload })),
  },
  terminal: { start: vi.fn(), cancel: vi.fn(), runCapture: vi.fn(async (p) => ({ output: '', code: 0, signal: null, ...p })), profiles: vi.fn(() => ({ platform: 'win32', defaultId: 'powershell', profiles: [{ id: 'powershell', label: 'PowerShell', default: true }] })) },
  settings: { load: vi.fn(async () => ({})), save: vi.fn(async () => ({})) },
  secretStore: { setSecret: vi.fn(), clearSecret: vi.fn(), getSecretSource: vi.fn(async () => null) },
  ai: { start: vi.fn(), complete: vi.fn(async () => ({ text: 'x' })), cancel: vi.fn(), checkConnection: vi.fn() },
  auth: {
    signIn: vi.fn(async (payload) => ({ email: payload.email, token: 'nova_test', tokensRemaining: 1_000_000_000 })),
    getAccount: vi.fn(async () => null),
    signOut: vi.fn(async () => ({ ok: true })),
    beginLogin: vi.fn(async () => ({ ok: true, url: 'http://127.0.0.1:1/signin?state=x' })),
    cancel: vi.fn(async () => ({ ok: true })),
  },
  logger,
  novadb: {
    status: vi.fn(() => ({ current: 'appdb', databases: [{ name: 'appdb', isCurrent: true, tables: [] }], storagePath: '/tmp/novadb.json', ready: true })),
    execute: vi.fn((sql, params) => ({ ok: true, type: 'select', columns: ['ok'], rows: [{ ok: 1 }], rowCount: 1, sql, params })),
  },
};

let registerIpcFailedOnce = false;

beforeAll(async () => {
  const mod = await import('../electron/ipc/registerIpc');
  try {
    mod.registerIpc(services);
  } catch {
    // Vitest may import the module fresh per worker; a second registration
    // attempt is only an error if the first one never happened.
    registerIpcFailedOnce = true;
    channels.clear();
    mod.registerIpc(services);
  }
});

/** Invoke a channel the way ipcRenderer.invoke delivers it. */
function call(channel, ...payload) {
  const handler = channels.get(channel);
  if (!handler) throw new Error(`Channel not registered: ${channel}`);
  return handler({ sender: {} }, ...payload);
}

describe('IPC argument contract', () => {
  it('registers the full closed channel set', () => {
    // 51 non-NovaLink channels + 54 NovaLink Live channels (notify added).
    expect(channels.size).toBe(105);
    expect(registerIpcFailedOnce).toBe(false);
  });

  it('starts a fresh registry per call and reports the channel count', async () => {
    const mod = await import('../electron/ipc/registerIpc');
    const secondChannels = new Map();
    const result = mod.registerIpc({
      ...services,
      ipcMain: { handle: (c, f) => secondChannels.set(c, f) },
    });
    expect(secondChannels.size).toBe(105);
    expect(result.channelCount).toBe(105);
  });

  it('exposes the provider catalog and account channels', async () => {
    const providers = await call('ai:providers');
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.map((p) => p.id)).toEqual(expect.arrayContaining(['openai', 'anthropic', 'gemini', 'ollama']));
    const account = await call('auth:sign-in', { email: 'ada@example.com' });
    expect(account).toMatchObject({ email: 'ada@example.com', tokensRemaining: 1_000_000_000 });
    await call('auth:account');
    expect(services.auth.getAccount).toHaveBeenCalledTimes(1);
    await call('auth:sign-out');
    expect(services.auth.signOut).toHaveBeenCalledTimes(1);
    expect(await call('auth:begin-login')).toMatchObject({ ok: true, url: expect.stringContaining('/signin?state=') });
    await call('auth:cancel-login');
    expect(services.auth.cancel).toHaveBeenCalled();
  });

  it('reports sign-in provider status and stores client ids in the secret store', async () => {
    const status = await call('auth:oauth-status');
    expect(status.map((p) => p.id)).toEqual(expect.arrayContaining(['google', 'github', 'microsoft']));
    expect(status.find((p) => p.id === 'github').requiresSecret).toBe(true);

    await call('auth:set-oauth-config', { provider: 'google', clientId: '  cid.apps.googleusercontent.com  ' });
    expect(services.secretStore.setSecret).toHaveBeenCalledWith('oauth-google-id', 'cid.apps.googleusercontent.com');

    await call('auth:set-oauth-config', { provider: 'google', clientId: '' });
    expect(services.secretStore.clearSecret).toHaveBeenCalledWith('oauth-google-id');

    await expect(call('auth:set-oauth-config', { provider: 'nope', clientId: 'x' })).rejects.toThrow(/unknown sign-in provider/i);
  });

  it('validates extension ids and passes extensions calls through', async () => {
    await expect(call('extensions:install', '')).rejects.toThrow(/extension id is required/i);
    await expect(call('extensions:uninstall', '   ')).rejects.toThrow(/extension id is required/i);
    await expect(call('extensions:set-enabled', {})).rejects.toThrow(/extension id is required/i);
    await call('extensions:list');
    await call('extensions:install', 'novacode-samples.js-snippets');
    await call('extensions:update', ' novacode-samples.js-snippets ');
    await call('extensions:set-enabled', { id: 'x.y', enabled: true });
    await call('extensions:uninstall', 'x.y');
    const ext = services.extensions;
    expect(ext.list).toHaveBeenCalledTimes(1);
    expect(ext.install).toHaveBeenCalledWith('novacode-samples.js-snippets');
    expect(ext.update).toHaveBeenCalledWith('novacode-samples.js-snippets');
    expect(ext.setEnabled).toHaveBeenCalledWith('x.y', true);
    expect(ext.uninstall).toHaveBeenCalledWith('x.y');
  });

  it('exposes runtime detection through a single channel', async () => {
    const result = await call('runtime:detect');
    expect(result).toMatchObject({ runtimes: [] });
    expect(services.runtime.detectAll).toHaveBeenCalledTimes(1);
  });

  it('routes marketplace search and install to the registry', async () => {
    const search = await call('extensions:search', { query: 'python' });
    expect(search.results[0].id).toBe('x.y');
    expect(services.registry.search).toHaveBeenCalledWith({ query: 'python' });
    await call('extensions:search', {});
    expect(services.registry.search).toHaveBeenLastCalledWith({ query: '' });

    await call('extensions:install-market', { namespace: 'ms-python', name: 'python' });
    expect(services.registry.install).toHaveBeenCalledWith({ namespace: 'ms-python', name: 'python' });
  });

  it('workspace:validate receives the payload, not the ipc event', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ipc-'));
    await expect(call('workspace:validate', dir)).resolves.toBe(path.resolve(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('workspace:validate rejects empty and missing folders with usable messages', async () => {
    await expect(call('workspace:validate', '')).rejects.toThrow(/folder path is required/);
    await expect(call('workspace:validate', 'Z:\\definitely\\not\\here')).rejects.toThrow(/no longer exists/);
  });

  it('fs handlers receive the payload object and reach the service', async () => {
    await call('fs:read-dir', { root: 'C:\\w', target: 'C:\\w\\a' });
    expect(fsStubs.readTree).toHaveBeenCalledWith('C:\\w', 'C:\\w\\a');
  });

  it('shell:open-external allows only http(s)', async () => {
    await call('shell:open-external', 'https://example.com');
    expect(externalOpens).toContain('https://example.com');
    await expect(call('shell:open-external', 'file:///C:/x')).rejects.toThrow(/http\(s\)/);
    await expect(call('shell:open-external', 'javascript:alert(1)')).rejects.toThrow(/http\(s\)/);
  });

  it('journal-applied AI edits record previous content before writing', async () => {
    const result = await call('fs:apply-ai-edit', { root: 'C:\\w', path: 'a.js', content: 'new content\n' });
    expect(result).toMatchObject({ id: 'ch-test-1', filePath: 'a.js' });
    expect(services.history.record).toHaveBeenCalledWith({
      root: 'C:\\w',
      filePath: 'a.js',
      previous: 'old content\n',
      content: 'new content\n',
      kind: 'ai-edit',
    });
    expect(fsStubs.writeFile).toHaveBeenCalledWith('C:\\w', 'a.js', 'new content\n');
  });

  it('journal-applied AI edits treat unreadable files as newly created', async () => {
    fsStubs.readFile.mockRejectedValueOnce(new Error('ENOENT'));
    await call('fs:apply-ai-edit', { root: 'C:\\w', path: 'made.js', content: 'x' });
    expect(services.history.record).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: 'made.js', previous: null, kind: 'ai-edit' }),
    );
  });

  it('journal-applied AI edits refuse non-text content and empty paths', async () => {
    await expect(call('fs:apply-ai-edit', { root: 'C:\\w', path: 'a.js', content: 42 })).rejects.toThrow(/must be text/);
    await expect(call('fs:apply-ai-edit', { root: 'C:\\w', path: '', content: 'x' })).rejects.toThrow(/file path is required/);
    await expect(call('fs:apply-ai-edit', { path: 'a.js', content: 'x' })).rejects.toThrow(/Open a folder first/);
  });

  it('history channels pass root and entry id through to the service', async () => {
    await call('history:list', 'C:\\w');
    expect(services.history.list).toHaveBeenCalledWith({ root: 'C:\\w' });
    await call('history:restore', { root: 'C:\\w', id: 'ch-9' });
    expect(services.history.restore).toHaveBeenCalledWith({ root: 'C:\\w', id: 'ch-9' });
  });

  it('terminal and ai payloads pass through untouched', async () => {
    await call('terminal:start', { cwd: 'C:\\w', command: 'node -v', profile: 'cmd' });
    // Streaming channels now also receive a per-window emitter as a 2nd arg.
    expect(services.terminal.start).toHaveBeenCalledWith({ cwd: 'C:\\w', command: 'node -v', profile: 'cmd' }, expect.any(Function));
    const profiles = await call('terminal:profiles');
    expect(profiles).toMatchObject({ defaultId: 'powershell' });
    await call('ai:cancel', 'run-1');
    expect(services.ai.cancel).toHaveBeenCalledWith('run-1');
    const completionPayload = { provider: 'openai', messages: [{ role: 'user', content: 'def' }] };
    await expect(call('ai:complete', completionPayload)).resolves.toMatchObject({ text: 'x' });
    expect(services.ai.complete).toHaveBeenCalledWith(completionPayload, expect.any(Function));
    // The channel is always invoked with a payload object, never a bare event.
    await call('ai:complete');
    expect(services.ai.complete).toHaveBeenLastCalledWith({}, expect.any(Function));
  });

  it('exposes window and lifecycle channels', async () => {
    expect(await call('window:new')).toMatchObject({ ok: true });
    expect(await call('app:quit')).toMatchObject({ ok: true });
    expect(await call('dialog:open-file')).toMatchObject({ ok: true });
    expect(await call('window:close')).toMatchObject({ ok: true });
  });

  it('routes NovaLink Live actions to the client and confines arguments', async () => {
    // Status is synchronous on the client (returns a snapshot object).
    const snap = await call('novalinkLive:status');
    expect(snap.baseUrl).toBe('https://link.test');

    // Boot trims and forwards the base URL. registerIpc only clips whitespace;
    // the client's `normalizeBaseUrl` is what enforces the http(s) scheme and
    // strips any trailing slash. The mock sees the value as it left the IPC
    // layer, not as it will look inside the client.
    await call('novalinkLive:boot', { baseUrl: '  https://link.test/ ', autoConnect: false });
    expect(services.novalink.boot).toHaveBeenCalledWith({ baseUrl: 'https://link.test/', autoConnect: false });

    // Login forwards the typed credentials; the token is server-provided and
    // never returned across IPC.
    const logged = await call('novalinkLive:login', { username: '  ada  ', password: 'hunter2-hunter2' });
    expect(logged.user.username).toBe('ada');
    expect(services.novalink.login).toHaveBeenCalledWith({ username: 'ada', password: 'hunter2-hunter2' });

    // A real UUIDv4 id crosses; a non-UUID is rejected before it reaches the
    // client, so a malformed renderer call cannot make the client issue a bad
    // HTTP request.
    const uuid = '0e62c1e2-3f70-4d05-9c78-8ee4d1a0b111';
    await call('novalinkLive:getUser', { userId: uuid });
    expect(services.novalink.getUser).toHaveBeenCalledWith(uuid);
    await expect(call('novalinkLive:getUser', { userId: 'not-a-uuid' })).rejects.toThrow(/must be a uuid/i);
    await expect(call('novalinkLive:getUser', {})).rejects.toThrow(/must be a uuid/i);

    // A message body clips to the server's 8000-char ceiling.
    const long = 'x'.repeat(12_000);
    await call('novalinkLive:sendMessage', { conversationId: uuid, body: long });
    const sendArgs = services.novalink.sendMessage.mock.calls.at(-1);
    expect(sendArgs[0]).toBe(uuid);
    expect(sendArgs[1].body.length).toBe(8000);

    // Bytes for uploadFile must be a Uint8Array, and are clipped to 25 MB.
    await call('novalinkLive:uploadFile', { conversationId: uuid, bytes: new Uint8Array([1, 2, 3]), fileName: 'hi.txt' });
    const upArgs = services.novalink.uploadFile.mock.calls.at(-1);
    expect(Buffer.isBuffer(upArgs[0].bytes)).toBe(true);
    expect(upArgs[0].bytes.length).toBe(3);
    await expect(call('novalinkLive:uploadFile', { conversationId: uuid, bytes: 'not-bytes' })).rejects.toThrow(/Uint8Array/);
    await expect(call('novalinkLive:uploadFile', { conversationId: uuid, bytes: new Uint8Array(0) })).rejects.toThrow(/empty/i);

    // call.signal frames must use one of the server's five accepted names.
    await call('novalinkLive:sendCallSignal', { callId: uuid, toUserId: uuid, signal: 'offer', payload: { sdp: 'v=0…', type: 'offer' } });
    expect(services.novalink.sendCallSignal).toHaveBeenCalledWith({ callId: uuid, toUserId: uuid, signal: 'offer', payload: { sdp: 'v=0…', type: 'offer' } });

    // sendPresence forwards the string as-is; the client enforces the vocabulary.
    await call('novalinkLive:sendPresence', { status: 'away' });
    expect(services.novalink.sendPresence).toHaveBeenCalledWith('away');
    await expect(call('novalinkLive:sendPresence', {})).rejects.toThrow(/presence status is required/i);

    // Reactions need an emoji, and the message id must be a uuid.
    await expect(call('novalinkLive:addReaction', { messageId: uuid })).rejects.toThrow(/emoji is required/i);
    await expect(call('novalinkLive:addReaction', { messageId: 'not-uuid', emoji: '👍' })).rejects.toThrow(/must be a uuid/i);
  });

  // novalinkLive:notify is the ONLY renderer path to an OS-visible toast. Its
  // handler must shape arguments before Electron's Notification is asked to
  // render them; the underlying API is not available in a plain Node test
  // worker, so we assert the shape guard + graceful degradation instead of
  // the actual click-to-focus round-trip (that path is covered in the
  // packaged app by an operator running the smoke UI).
  it('shapes the native notification arguments and degrades when unsupported', async () => {
    const uuid = '0e62c1e2-3f70-4d05-9c78-8ee4d1a0b111';
    // Missing title -> rejected before anything touches the Notification API.
    await expect(call('novalinkLive:notify', { body: 'hi' })).rejects.toThrow(/Notification title is required/i);
    // Non-string title -> same, because liveStr coerces to '' then throws.
    await expect(call('novalinkLive:notify', { title: 42, body: 'hi' })).rejects.toThrow(/Notification title is required/i);
    // Empty title after trim -> rejected.
    await expect(call('novalinkLive:notify', { title: '   ', body: 'hi' })).rejects.toThrow(/Notification title is required/i);
    // Valid title but Notification is not present in a Node test worker:
    // the handler returns `{ ok: false, reason: 'unsupported' }` rather than
    // throwing, so a renderer that fires a notification on an Electron build
    // without the API (e.g. headless CI) still gets a resolved promise.
    const result = await call('novalinkLive:notify', {
      title: 'New message',
      body: 'x'.repeat(500),
      conversationId: uuid,
    });
    expect(result).toMatchObject({ ok: false, reason: 'unsupported' });
    // Body clipping to 200 and title clipping to 80 are enforced by liveStr
    // BEFORE the unsupported short-circuit — that is what keeps a malicious
    // renderer from trickling an unbounded string into the OS toast queue.
    // A supplied conversationId must still be a real uuid; liveOptId treats
    // `undefined` / `''` as "no conversation" but rejects any other malformed
    // value, so a bad renderer cannot smuggle a foreign identifier through.
    await expect(call('novalinkLive:notify', {
      title: 'ok',
      body: 'ok',
      conversationId: 'not-a-uuid',
    })).rejects.toThrow(/must be a uuid/i);
    // Omitted conversationId is accepted (undefined short-circuits liveOptId).
    const noId = await call('novalinkLive:notify', { title: 'ok', body: 'ok' });
    expect(noId).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('guard errors propagate with their message', async () => {
    await expect(call('fs:read-dir', { root: '', target: '' })).rejects.toThrow(/Open a folder first/);
    await expect(call('fs:read-dir', {})).rejects.toThrow(/Open a folder first/);
  });

  it('forwards NovaDB statements and binds params; rejects empty SQL', async () => {
    services.novadb.execute.mockClear();
    const result = await call('db:execute', { sql: 'SELECT * FROM users WHERE id = ?', params: [7] });
    expect(services.novadb.execute).toHaveBeenCalledWith('SELECT * FROM users WHERE id = ?', [7]);
    expect(result).toMatchObject({ ok: true, type: 'select', rowCount: 1 });

    // Non-array params are normalised to [] so the arity check stays honest.
    await call('db:execute', { sql: 'SHOW DATABASES', params: 'nope' });
    expect(services.novadb.execute).toHaveBeenLastCalledWith('SHOW DATABASES', []);

    await expect(call('db:execute', { sql: '   ' })).rejects.toThrow(/SQL statement is required/i);
    await expect(call('db:execute', {})).rejects.toThrow(/SQL statement is required/i);

    const status = await call('db:status');
    expect(status).toMatchObject({ ready: true, current: 'appdb' });
  });
});

/**
 * Deploy + hosting channels.
 *
 * Registered against a second, independent registry because these handlers only
 * exist when the services are wired: the base 67-channel contract above must
 * stay exactly as it was, and a missing service must not open a channel.
 */
describe('deploy / hosting IPC contract', () => {
  const hostingStub = () => ({
    providers: vi.fn(async () => [{ id: 'vercel', available: true }]),
    connections: vi.fn(async () => [{ provider: 'vercel', connected: true }]),
    connect: vi.fn(async (payload) => ({ provider: payload.provider, connected: true })),
    disconnect: vi.fn(async (payload) => ({ ok: true, provider: payload.provider })),
    teams: vi.fn(async (payload) => ({ provider: payload.provider, teams: [] })),
    listProjects: vi.fn(async (payload) => [{ id: 'prj_1', teamId: payload.teamId }]),
    listDeploys: vi.fn(async () => []),
    domains: vi.fn(async () => ({ domains: [] })),
    deployLogs: vi.fn(async (payload) => ({ text: 'log', deploymentId: payload.deploymentId })),
    plan: vi.fn(async (payload) => ({ provider: payload.provider, root: payload.root, rebuild: payload.rebuild })),
    start: vi.fn(async (payload, emit) => { emit({ type: 'phase' }); return { runId: 'run_1', state: 'queued', ...payload }; }),
    redeploy: vi.fn(async (payload) => ({ runId: 'run_2', ...payload })),
    status: vi.fn(async (payload) => ({ runId: payload.runId, state: 'building' })),
    listRuns: vi.fn(async () => ['run_1']),
    refresh: vi.fn(async (payload) => ({ runId: payload.runId, state: 'ready' })),
    cancel: vi.fn(async (payload) => ({ ok: true, runId: payload.runId })),
    runLogs: vi.fn(async (payload) => ({ runId: payload.runId, text: '' })),
    historyList: vi.fn(async (payload) => [{ root: payload.root }]),
    historyClear: vi.fn(async (payload) => ({ ok: payload.confirm, root: payload.root })),
    getPreferences: vi.fn(async () => ({ provider: 'vercel' })),
    setPreferences: vi.fn(async (payload) => ({ ...payload })),
  });

  let hosting;
  let deploySvc;
  let previewSvc;
  let emitted;
  let map;

  async function register(overrides = {}) {
    const mod = await import('../electron/ipc/registerIpc');
    hosting = hostingStub();
    deploySvc = {
      detect: vi.fn(async (root) => ({ root, kind: 'node' })),
      build: vi.fn(async (root, opts) => ({ root, ...opts })),
      exportBundle: vi.fn(async (root, opts) => ({ root, ...opts })),
    };
    previewSvc = {
      status: vi.fn(async () => ({ running: false })),
      start: vi.fn(async (payload) => payload),
      stop: vi.fn(async () => ({ running: false })),
    };
    emitted = [];
    map = new Map();
    const result = mod.registerIpc({
      ...services,
      ...overrides,
      hosting,
      deploy: deploySvc,
      preview: previewSvc,
      ipcMain: { handle: (channel, fn) => map.set(channel, fn) },
      emitTo: (senderId, channel) => (payload) => emitted.push({ senderId, channel, payload }),
    });
    return result;
  }

  function fire(channel, ...payload) {
    const handler = map.get(channel);
    if (!handler) throw new Error(`Channel not registered: ${channel}`);
    return handler({ sender: { id: 7 } }, ...payload);
  }

  it('opens 27 extra channels and only when the services exist', async () => {
    const result = await register();
    // 105 base + 27 deploy/hosting channels = 132.
    expect(result.channelCount).toBe(132);
    expect(map.size).toBe(132);

    // No services wired -> no deploy/hosting surface at all.
    const mod = await import('../electron/ipc/registerIpc');
    const bare = new Map();
    mod.registerIpc({ ...services, ipcMain: { handle: (c, f) => bare.set(c, f) } });
    expect(bare.size).toBe(105);
    expect([...bare.keys()].some((k) => k.startsWith('deploy:'))).toBe(false);
  });

  // The diagnosis channel is the one place a deploy action can reach a language
  // model, so it must not exist unless the diagnostics service was wired, and it
  // must not accept a run id it cannot trust.
  it('offers the failure diagnosis only when the diagnostics service is wired', async () => {
    await register();
    expect(map.has('deploy:diagnose')).toBe(false);

    const diagnose = vi.fn(async ({ runId }) => ({ runId, text: 'Reconnect the account.', hints: [] }));
    await register({ diagnosis: { diagnose } });
    expect(map.has('deploy:diagnose')).toBe(true);

    expect(await fire('deploy:diagnose', { runId: 'run_1' })).toMatchObject({ runId: 'run_1' });
    expect(diagnose).toHaveBeenCalledWith({ runId: 'run_1' });
    await expect(fire('deploy:diagnose', {})).rejects.toThrow(/run id is required/);
    await expect(fire('deploy:diagnose', { runId: 'x'.repeat(200) })).rejects.toThrow(/not a valid identifier/);
  });

  it('routes the local deploy channels and requires a workspace root', async () => {
    await register();
    expect(await fire('deploy:detect', 'C:\\w')).toMatchObject({ root: 'C:\\w' });
    await fire('deploy:build', { root: 'C:\\w', command: 'npm run build', timeoutMs: 60000 });
    expect(deploySvc.build).toHaveBeenCalledWith('C:\\w', { command: 'npm run build', timeoutMs: 60000 });
    await fire('deploy:export', { root: 'C:\\w', outputDir: 'dist' });
    expect(deploySvc.exportBundle).toHaveBeenCalledWith('C:\\w', { outputDir: 'dist' });

    await expect(fire('deploy:detect', '')).rejects.toThrow(/Open a folder first/);
    await expect(fire('deploy:build', {})).rejects.toThrow(/Open a folder first/);
    await expect(fire('deploy:export', { outputDir: 'dist' })).rejects.toThrow(/Open a folder first/);
  });

  it('keeps the preview server channels separate from publishing', async () => {
    await register();
    expect(await fire('deploy:previewStatus')).toMatchObject({ running: false });
    await fire('deploy:previewStart', { root: 'C:\\w', dir: 'dist' });
    expect(previewSvc.start).toHaveBeenCalledWith({ root: 'C:\\w', dir: 'dist' });
    await fire('deploy:previewStop');
    expect(previewSvc.stop).toHaveBeenCalledTimes(1);
    await expect(fire('deploy:previewStart', { dir: 'dist' })).rejects.toThrow(/Open a folder first/);
  });

  it('requires a provider name before touching any account', async () => {
    await register();
    expect(await fire('deploy:providers')).toEqual([{ id: 'vercel', available: true }]);
    expect(await fire('deploy:connections')).toEqual([{ provider: 'vercel', connected: true }]);
    for (const channel of ['deploy:connect', 'deploy:disconnect', 'deploy:teams']) {
      await expect(fire(channel, {})).rejects.toThrow(/Choose a hosting provider/);
      await expect(fire(channel, { provider: 42 })).rejects.toThrow(/Choose a hosting provider/);
    }
    await expect(fire('deploy:projects', {})).rejects.toThrow(/Choose a hosting provider/);
    await expect(fire('deploy:plan', { root: 'C:\\w' })).rejects.toThrow(/Choose a hosting provider/);
    await expect(fire('deploy:plan', { provider: 'vercel' })).rejects.toThrow(/Open a folder first/);
  });

  it('clips the token and never hands it back to the renderer', async () => {
    await register();
    await fire('deploy:connect', { provider: ' vercel ', token: `  ${'t'.repeat(500)}  ` });
    expect(hosting.connect).toHaveBeenCalledWith({ provider: 'vercel', token: 't'.repeat(400) });

    // A non-string payload cannot smuggle an object into the secret store.
    await fire('deploy:connect', { provider: 'netlify', token: { a: 1 } });
    expect(hosting.connect).toHaveBeenLastCalledWith({ provider: 'netlify', token: '' });

    const response = await fire('deploy:connect', { provider: 'vercel', token: 'secret-token' });
    expect(JSON.stringify(response)).not.toContain('secret-token');
  });

  it('rejects ids that are not ids, so a path cannot ride a query parameter', async () => {
    await register();
    await fire('deploy:projects', { provider: 'vercel', teamId: '  team_1  ' });
    expect(hosting.listProjects).toHaveBeenCalledWith({ provider: 'vercel', teamId: 'team_1' });

    for (const bad of ['../etc/passwd', 'team 1', 'team;rm', 'a'.repeat(121)]) {
      await expect(fire('deploy:projects', { provider: 'vercel', teamId: bad })).rejects.toThrow(/not a valid identifier/);
    }
    // An over-long id is refused rather than clipped: a truncated team id would
    // silently deploy to a different account.
    expect(hosting.listProjects).not.toHaveBeenCalledWith(expect.objectContaining({ teamId: 'a'.repeat(120) }));
    // Absent and blank both mean "my account", not "undefined string".
    await fire('deploy:projects', { provider: 'vercel', teamId: '   ' });
    expect(hosting.listProjects).toHaveBeenLastCalledWith({ provider: 'vercel', teamId: undefined });
  });

  it('passes provider listing, domains and logs through with validated ids', async () => {
    await register();
    await fire('deploy:deploys', { provider: 'netlify', teamId: 'abc', project: 'site_1' });
    expect(hosting.listDeploys).toHaveBeenCalledWith({ provider: 'netlify', teamId: 'abc', project: 'site_1' });
    await fire('deploy:domains', { provider: 'vercel', project: 'acme' });
    expect(hosting.domains).toHaveBeenCalledWith({ provider: 'vercel', teamId: undefined, project: 'acme' });
    await fire('deploy:providerLogs', { provider: 'vercel', deploymentId: 'dpl_1' });
    expect(hosting.deployLogs).toHaveBeenCalledWith({
      provider: 'vercel', teamId: undefined, deploymentId: 'dpl_1', project: undefined,
    });
    await expect(fire('deploy:providerLogs', { provider: 'vercel', deploymentId: 'dpl 1' })).rejects.toThrow(/not a valid identifier/);
  });

  it('only starts a production publish with explicit confirmations', async () => {
    await register();
    const base = { root: 'C:\\w', provider: 'vercel' };
    await fire('deploy:start', base);
    let args = hosting.start.mock.calls[0][0];
    expect(args.production).toBe(true); // default branch, must still be confirmed below
    expect(args.confirmProduction).toBe(false);
    expect(args.rebuild).toBe(false);
    expect(args.acknowledgeFrontendOnly).toBe(false);
    expect(args.confirmBuild).toBe(false);
    expect(args.envVars).toEqual([]);

    // A truthy-but-not-boolean value is not an approval.
    await fire('deploy:start', { ...base, confirmProduction: 1, rebuild: 'yes', confirmBuild: 'true' });
    args = hosting.start.mock.calls[1][0];
    expect(args.confirmProduction).toBe(false);
    expect(args.rebuild).toBe(false);
    expect(args.confirmBuild).toBe(false);

    // Explicitly opting out of production is honoured.
    await fire('deploy:start', { ...base, production: false, confirmProduction: true });
    args = hosting.start.mock.calls[2][0];
    expect(args.production).toBe(false);
    expect(args.confirmProduction).toBe(true);

    // Free-text settings are clipped, never passed as objects.
    await fire('deploy:start', { ...base, buildCommand: `  ${'b'.repeat(400)}  `, outputDir: { pwn: true }, teamId: 'team_1' });
    args = hosting.start.mock.calls[3][0];
    expect(args.buildCommand).toBe('b'.repeat(300));
    expect(args.outputDir).toBeUndefined();
    expect(args.teamId).toBe('team_1');
  });

  it('sanitises environment variables without rewriting their case', async () => {
    await register();
    await fire('deploy:start', {
      root: 'C:\\w',
      provider: 'vercel',
      envVars: [
        { key: ' API_URL ', value: 'https://api.example.com' },
        { key: 'connectionString', value: 'postgres://x' },
        { key: 'NO_VALUE', value: '' },
        { key: 'BAD-NAME', value: 'v' },
        { key: '9LEADING', value: 'v' },
        { key: 42, value: 'v' },
        'not-an-object',
        { key: 'OK2', value: 7 },
      ],
    });
    const args = hosting.start.mock.calls[0][0];
    // Hosts treat env names case-sensitively, so a lowercase name the app really
    // reads must survive instead of being silently uppercased.
    expect(args.envVars).toEqual([
      { key: 'API_URL', value: 'https://api.example.com' },
      { key: 'connectionString', value: 'postgres://x' },
    ]);

    // A caller cannot push an unbounded list into the provider API.
    await fire('deploy:start', {
      root: 'C:\\w', provider: 'vercel',
      envVars: Array.from({ length: 200 }, (_, i) => ({ key: `V${i}`, value: 'x' })),
    });
    expect(hosting.start.mock.calls[1][0].envVars).toHaveLength(50);
  });

  it('streams run events back to the window that started them', async () => {
    await register();
    const run = await fire('deploy:start', { root: 'C:\\w', provider: 'vercel' });
    expect(run).toMatchObject({ runId: 'run_1' });
    expect(emitted).toEqual([{ senderId: 7, channel: 'deploy:event', payload: { type: 'phase' } }]);

    emitted.length = 0;
    await fire('deploy:redeploy', { root: 'C:\\w', provider: 'vercel' });
    expect(hosting.redeploy).toHaveBeenCalledWith(expect.objectContaining({ root: 'C:\\w' }), expect.any(Function));
    expect(emitted).toHaveLength(0);
  });

  it('requires a well-formed run id for every run channel', async () => {
    await register();
    for (const channel of ['deploy:status', 'deploy:refresh', 'deploy:cancel', 'deploy:runLogs']) {
      await expect(fire(channel, {})).rejects.toThrow(/deployment run id is required/i);
      await expect(fire(channel, { runId: 'run/../x' })).rejects.toThrow(/not a valid identifier/);
    }
    expect(await fire('deploy:status', { runId: 'run_1' })).toMatchObject({ runId: 'run_1' });
    expect(await fire('deploy:runs')).toEqual(['run_1']);
    expect(await fire('deploy:cancel', { runId: 'run_1' })).toMatchObject({ ok: true });
  });

  it('gates history clearing on an explicit confirm', async () => {
    await register();
    await fire('deploy:history', { root: 'C:\\w' });
    expect(hosting.historyList).toHaveBeenCalledWith({ root: 'C:\\w' });

    await fire('deploy:historyClear', { root: 'C:\\w' });
    expect(hosting.historyClear).toHaveBeenCalledWith({ root: 'C:\\w', confirm: false });

    await fire('deploy:historyClear', { root: 'C:\\w', confirm: true });
    expect(hosting.historyClear).toHaveBeenLastCalledWith({ root: 'C:\\w', confirm: true });

    // No root means "no workspace": the service decides, but nothing crashes.
    await fire('deploy:history', {});
    expect(hosting.historyList).toHaveBeenLastCalledWith({ root: '' });
  });

  it('stores preferences without trusting the renderer types', async () => {
    await register();
    expect(await fire('deploy:preferences')).toEqual({ provider: 'vercel' });
    await fire('deploy:setPreferences', { provider: ' netlify ', teamId: 'team_1' });
    expect(hosting.setPreferences).toHaveBeenCalledWith({ provider: 'netlify', teamId: 'team_1' });
    await fire('deploy:setPreferences', { provider: 9, teamId: '   ' });
    expect(hosting.setPreferences).toHaveBeenLastCalledWith({ provider: '', teamId: undefined });
    await expect(fire('deploy:setPreferences', { provider: 'vercel', teamId: 'bad id!' })).rejects.toThrow(/not a valid identifier/);
  });

  it('does not register hosting channels when the service is absent', async () => {
    await register();
    const mod = await import('../electron/ipc/registerIpc');
    const onlyDeploy = new Map();
    mod.registerIpc({
      ...services,
      deploy: deploySvc,
      ipcMain: { handle: (c, f) => onlyDeploy.set(c, f) },
    });
    expect(onlyDeploy.size).toBe(108);
    expect(onlyDeploy.has('deploy:detect')).toBe(true);
    expect(onlyDeploy.has('deploy:start')).toBe(false);
    expect(onlyDeploy.has('deploy:connections')).toBe(false);
  });
});
