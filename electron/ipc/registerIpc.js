/**
 * IPC contract registry.
 *
 * The renderer talks to the main process through this explicit, closed set
 * of channels. Every handler:
 *   1. verifies the sender is the IDE window (no stray webContents),
 *   2. validates and confines its inputs (workspace path guard),
 *   3. converts unexpected failures into clean Error messages for invoke().
 */
const electron = require('electron');
const fsp = require('fs').promises;
const path = require('path');
const pathGuard = require('../services/pathGuard');
const fsService = require('../services/fsService');
const { describeProviders } = require('../services/ai/providers');
const { providerList, OAUTH_PROVIDERS } = require('../services/oauthProviders');

const EXTERNAL_URL = /^https?:\/\//i;

function normalizeProvider(payload, fallbackKey) {
  if (typeof payload === 'string') return { provider: 'openai', value: payload };
  const source = payload || {};
  return { provider: typeof source.provider === 'string' && source.provider ? source.provider : 'openai', value: source[fallbackKey] };
}

function registerIpc({
  getWindow,
  ipcMain = electron.ipcMain,
  dialog = electron.dialog,
  shell = electron.shell,
  app = electron.app,
  fs = fsService,
  history,
  extensions,
  registry,
  runtime,
  novalink,
  terminal,
  // Optional: without it the theme still works in content, just not in chrome.
  applyAppearance = () => ({ ok: false }),
  settings,
  secretStore,
  ai,
  auth,
  logger,
}) {
  const handlers = new Map();

  function handle(channel, handler) {
    if (handlers.has(channel)) {
      throw new Error(`IPC channel registered twice: ${channel}`);
    }
    handlers.set(channel, true);
    ipcMain.handle(channel, async (event, ...args) => {
      const win = getWindow();
      if (win && event.sender !== win.webContents) {
        throw new Error('Unauthorized IPC sender.');
      }
      try {
        return await handler(event, ...args);
      } catch (error) {
        logger.error(`ipc ${channel} failed`, { error: error.message });
        throw error instanceof pathGuard.PathGuardError || error instanceof Error
          ? error
          : new Error('Unexpected error.');
      }
    });
  }

  // --- dialogs & workspace -------------------------------------------------
  handle('dialog:choose-directory', async () => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Open project folder',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  handle('workspace:validate', async (_event, root) => {
    if (typeof root !== 'string' || !root.trim()) throw new Error('A folder path is required.');
    const resolved = path.resolve(root);
    let stat;
    try {
      stat = await fsp.stat(resolved);
    } catch {
      throw new Error('That folder no longer exists.');
    }
    if (!stat.isDirectory()) throw new Error('That path is not a folder.');
    return resolved;
  });

  // --- filesystem (workspace-confined) -------------------------------------
  handle('fs:read-dir', (_event, { root, target } = {}) => {
    if (!root) throw new pathGuard.PathGuardError('Open a folder first.');
    return fs.readTree(root, target || root);
  });

  handle('fs:read-file', (_event, { root, path: filePath } = {}) => {
    if (!root) throw new pathGuard.PathGuardError('Open a folder first.');
    return fs.readFile(root, filePath);
  });

  handle('fs:write-file', (_event, { root, path: filePath, content } = {}) => {
    if (!root) throw new pathGuard.PathGuardError('Open a folder first.');
    return fs.writeFile(root, filePath, content);
  });

  handle('fs:create-file', (_event, { root, dir, name } = {}) => {
    if (!root) throw new pathGuard.PathGuardError('Open a folder first.');
    return fs.createFile(root, dir || root, name);
  });

  handle('fs:create-folder', (_event, { root, dir, name } = {}) => {
    if (!root) throw new pathGuard.PathGuardError('Open a folder first.');
    return fs.createFolder(root, dir || root, name);
  });

  handle('fs:rename', (_event, { root, path: target, newName } = {}) => {
    if (!root) throw new pathGuard.PathGuardError('Open a folder first.');
    return fs.rename(root, target, newName);
  });

  handle('fs:delete', (_event, { root, path: target } = {}) => {
    if (!root) throw new pathGuard.PathGuardError('Open a folder first.');
    return fs.remove(root, target);
  });

  handle('fs:search', (_event, { root, query, isRegex, caseSensitive } = {}) => {
    if (!root) throw new pathGuard.PathGuardError('Open a folder first.');
    return fs.search(root, { query, isRegex, caseSensitive });
  });

  // --- safe change history --------------------------------------------------
  // The ONLY way AI edits reach disk: journaling happens in this process
  // before the write, so the renderer cannot bypass the journal.
  handle('fs:apply-ai-edit', async (_event, { root, path: filePath, content } = {}) => {
    if (!root) throw new pathGuard.PathGuardError('Open a folder first.');
    if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('A file path is required.');
    if (typeof content !== 'string') throw new Error('File content must be text.');
    let previous = null;
    try {
      previous = await fs.readFile(root, filePath);
    } catch {
      previous = null; // the edit creates this file
    }
    const entry = history.record({ root, filePath, previous, content, kind: 'ai-edit' });
    await fs.writeFile(root, filePath, content);
    return { id: entry.id, ts: entry.ts, filePath };
  });

  handle('history:list', (_event, root) => history.list({ root }));

  handle('history:restore', (_event, { root, id } = {}) => history.restore({ root, id }));

  // --- terminal -------------------------------------------------------------
  handle('terminal:start', (_event, payload = {}) => terminal.start(payload));

  handle('terminal:cancel', (_event, runId) => terminal.cancel(String(runId || '')));

  handle('terminal:profiles', () => terminal.profiles());

  // --- settings ---------------------------------------------------------------
  handle('settings:get', () => settings.load());

  handle('settings:set', (_event, patch) => settings.save(patch));

  // --- AI (multi-provider; keys never cross back to the renderer) -----------
  handle('ai:set-key', async (_event, payload) => {
    const { provider, value } = normalizeProvider(payload, 'key');
    return secretStore.setSecret(provider, value);
  });

  handle('ai:clear-key', (_event, payload) => {
    const { provider } = normalizeProvider(payload, 'key');
    return secretStore.clearSecret(provider);
  });

  handle('ai:key-status', async (_event, payload) => {
    const { provider } = normalizeProvider(payload, 'key');
    const source = await secretStore.getSecretSource(provider);
    const envVar = `NOVACODE_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '')}_API_KEY`;
    return { provider, hasKey: Boolean(source) || Boolean(process.env[envVar]), source };
  });

  handle('ai:providers', () => describeProviders());

  handle('ai:check-connection', (_event, { provider, baseUrl } = {}) => ai.checkConnection({ provider, baseUrl }));

  handle('ai:chat', (_event, payload = {}) => ai.start(payload));

  // Inline ghost-text suggestions: same auth gate as chat, never throws.
  handle('ai:complete', (_event, payload = {}) => ai.complete(payload));

  handle('ai:cancel', (_event, runId) => ai.cancel(String(runId || '')));

  // --- accounts (local sign-in, per-email token, token budget) --------------
  if (auth) {
    handle('auth:sign-in', (_event, payload = {}) => auth.signIn(payload));
    handle('auth:account', () => auth.getAccount());
    handle('auth:sign-out', () => auth.signOut());
    handle('auth:begin-login', () => auth.beginLogin());
    handle('auth:cancel-login', () => auth.cancel());

    // Sign-in provider config (Google/GitHub/Microsoft OAuth client ids). The
    // plaintext values live only in the encrypted secret store; the renderer
    // gets back presence booleans, never the values.
    handle('auth:oauth-status', async () => {
      const status = [];
      for (const p of providerList()) {
        const key = p.id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
        const def = OAUTH_PROVIDERS[p.id];
        const idSrc = await secretStore.getSecretSource(`oauth-${p.id}-id`);
        const secSrc = await secretStore.getSecretSource(`oauth-${p.id}-secret`);
        const envId = Boolean(process.env[`NOVACODE_${key}_CLIENT_ID`]);
        const envSec = Boolean(process.env[`NOVACODE_${key}_CLIENT_SECRET`]);
        const hasClientId = Boolean(idSrc) || envId;
        const hasSecret = Boolean(secSrc) || envSec;
        status.push({
          id: p.id,
          label: p.label,
          requiresSecret: def.requiresSecret,
          hasClientId,
          hasSecret,
          fromEnv: !idSrc && envId,
          live: hasClientId && (!def.requiresSecret || hasSecret),
        });
      }
      return status;
    });

    handle('auth:set-oauth-config', async (_event, { provider, clientId, clientSecret } = {}) => {
      if (!OAUTH_PROVIDERS[provider]) throw new Error('Unknown sign-in provider.');
      if (typeof clientId === 'string') {
        const id = clientId.trim();
        if (id) await secretStore.setSecret(`oauth-${provider}-id`, id);
        else await secretStore.clearSecret(`oauth-${provider}-id`);
      }
      if (typeof clientSecret === 'string') {
        const sec = clientSecret.trim();
        if (sec) await secretStore.setSecret(`oauth-${provider}-secret`, sec);
        else await secretStore.clearSecret(`oauth-${provider}-secret`);
      }
      return { ok: true };
    });
  }

  // --- shell & app ----------------------------------------------------------
  handle('shell:open-external', (_event, url) => {
    if (typeof url !== 'string' || !EXTERNAL_URL.test(url)) {
      throw new Error('Only http(s) links can be opened externally.');
    }
    return shell.openExternal(url);
  });

  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  }));

  // Native half of the theme: window canvas colour + light/dark OS chrome, so a
  // theme switch is visible everywhere, not only inside the web content.
  handle('window:set-appearance', (_event, payload = {}) => applyAppearance(payload));

  // --- extensions (declarative catalog; no code execution) -------------------
  if (extensions) {
    handle('extensions:list', async () => extensions.list());

    handle('extensions:install', async (_event, id) => {
      if (typeof id !== 'string' || !id.trim()) throw new Error('An extension id is required.');
      return extensions.install(id.trim());
    });

    handle('extensions:update', async (_event, id) => {
      if (typeof id !== 'string' || !id.trim()) throw new Error('An extension id is required.');
      return extensions.update(id.trim());
    });

    handle('extensions:set-enabled', async (_event, { id, enabled } = {}) => {
      if (typeof id !== 'string' || !id.trim()) throw new Error('An extension id is required.');
      return extensions.setEnabled(id, Boolean(enabled));
    });

    handle('extensions:uninstall', async (_event, id) => {
      if (typeof id !== 'string' || !id.trim()) throw new Error('An extension id is required.');
      return extensions.uninstall(id.trim());
    });
  }

  // --- remote extension registry (Open VSX discovery + declarative install) --
  if (registry) {
    handle('extensions:search', (_event, { query } = {}) => (
      registry.search({ query: typeof query === 'string' ? query : '' })
    ));

    handle('extensions:install-market', (_event, payload = {}) => registry.install({
      namespace: typeof payload?.namespace === 'string' ? payload.namespace : '',
      name: typeof payload?.name === 'string' ? payload.name : '',
    }));
  }

  // --- language runtimes -------------------------------------------------------
  if (runtime) {
    handle('runtime:detect', async () => runtime.detectAll());
  }

  // --- NovaLink peer-to-peer collaboration -----------------------------------
  // Every id-shaped argument is validated as a non-empty string before it
  // reaches the service; the service then confines all filesystem work to the
  // workspace via pathGuard. No raw Node/fs or IPC objects ever reach React.
  if (novalink) {
    const requireId = (value, label) => {
      if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
      return value.trim();
    };

    handle('novalink:status', () => novalink.getStatus());
    handle('novalink:discover', () => novalink.discover());
    handle('novalink:stop-discovery', () => novalink.stopScan());
    handle('novalink:enable-bluetooth', () => novalink.enableBluetooth());
    handle('novalink:scan-bluetooth', () => novalink.scanBluetoothDevices());
    handle('novalink:connect', (_event, { peerId } = {}) => novalink.connect(requireId(peerId, 'A peer id')));
    handle('novalink:accept-connection', (_event, { peerId } = {}) => novalink.acceptConnection(requireId(peerId, 'A peer id')));
    handle('novalink:reject-connection', (_event, { peerId } = {}) => novalink.rejectConnection(requireId(peerId, 'A peer id')));
    handle('novalink:disconnect', (_event, { peerId } = {}) => novalink.disconnect(requireId(peerId, 'A peer id')));
    handle('novalink:send-message', (_event, { peerId, text } = {}) => novalink.sendMessage(requireId(peerId, 'A peer id'), typeof text === 'string' ? text : ''));
    handle('novalink:share-code', (_event, payload = {}) => novalink.shareCode({
      peerId: requireId(payload.peerId, 'A peer id'),
      text: typeof payload.text === 'string' ? payload.text : '',
      language: typeof payload.language === 'string' ? payload.language : '',
      path: typeof payload.path === 'string' ? payload.path : '',
    }));
    handle('novalink:share-file', (_event, payload = {}) => novalink.shareFile({
      peerId: requireId(payload.peerId, 'A peer id'),
      root: typeof payload.root === 'string' ? payload.root : '',
      path: typeof payload.path === 'string' ? payload.path : '',
    }));
    handle('novalink:accept-transfer', (_event, { transferId } = {}) => novalink.acceptTransfer(requireId(transferId, 'A transfer id')));
    handle('novalink:reject-transfer', (_event, { transferId } = {}) => novalink.rejectTransfer(requireId(transferId, 'A transfer id')));
    handle('novalink:cancel-transfer', (_event, { transferId } = {}) => novalink.cancelTransfer(requireId(transferId, 'A transfer id')));
    handle('novalink:save-transfer', (_event, payload = {}) => novalink.saveTransfer(requireId(payload.transferId, 'A transfer id'), {
      root: typeof payload.root === 'string' ? payload.root : '',
      dir: typeof payload.dir === 'string' ? payload.dir : '',
      name: typeof payload.name === 'string' ? payload.name : '',
      overwrite: Boolean(payload.overwrite),
    }));
  }

  return { channelCount: handlers.size };
}

module.exports = { registerIpc };
