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
  terminal: { start: vi.fn(), cancel: vi.fn(), profiles: vi.fn(() => ({ platform: 'win32', defaultId: 'powershell', profiles: [{ id: 'powershell', label: 'PowerShell', default: true }] })) },
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
    expect(channels.size).toBe(43);
    expect(registerIpcFailedOnce).toBe(false);
  });

  it('starts a fresh registry per call and reports the channel count', async () => {
    const mod = await import('../electron/ipc/registerIpc');
    const secondChannels = new Map();
    const result = mod.registerIpc({
      ...services,
      ipcMain: { handle: (c, f) => secondChannels.set(c, f) },
    });
    expect(secondChannels.size).toBe(43);
    expect(result.channelCount).toBe(43);
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
    expect(services.terminal.start).toHaveBeenCalledWith({ cwd: 'C:\\w', command: 'node -v', profile: 'cmd' });
    const profiles = await call('terminal:profiles');
    expect(profiles).toMatchObject({ defaultId: 'powershell' });
    await call('ai:cancel', 'run-1');
    expect(services.ai.cancel).toHaveBeenCalledWith('run-1');
    const completionPayload = { provider: 'openai', messages: [{ role: 'user', content: 'def' }] };
    await expect(call('ai:complete', completionPayload)).resolves.toMatchObject({ text: 'x' });
    expect(services.ai.complete).toHaveBeenCalledWith(completionPayload);
    // The channel is always invoked with a payload object, never a bare event.
    await call('ai:complete');
    expect(services.ai.complete).toHaveBeenLastCalledWith({});
  });

  it('guard errors propagate with their message', async () => {
    await expect(call('fs:read-dir', { root: '', target: '' })).rejects.toThrow(/Open a folder first/);
    await expect(call('fs:read-dir', {})).rejects.toThrow(/Open a folder first/);
  });
});
