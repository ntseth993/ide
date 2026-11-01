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
const DEPLOY_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

function normalizeProvider(payload, fallbackKey) {
  if (typeof payload === 'string') return { provider: 'openai', value: payload };
  const source = payload || {};
  return { provider: typeof source.provider === 'string' && source.provider ? source.provider : 'openai', value: source[fallbackKey] };
}

// --- deploy argument validation ---------------------------------------------
// The renderer cannot reach the provider adapters directly; every value that
// crosses these channels is re-typed here first, so a stray object/array/number
// can never be forwarded into a path, a URL or an API body.
function clip(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function isTrue(value) {
  return value === true;
}

// Environment variable names are case-sensitive on the Linux runtimes the
// hosts use, so the name is forwarded exactly as typed: silently uppercasing
// `connectionString` would create a variable the application never reads and
// still report a successful deploy.
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Environment values cross once and are forgotten; keys must look like names. */
function envVarList(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50)
    .map((item) => ({
      key: clip(item && item.key, 64),
      value: typeof (item && item.value) === 'string' ? item.value.slice(0, 8000) : '',
    }))
    .filter((item) => ENV_KEY.test(item.key) && item.value);
}

function registerIpc({
  // Multi-window: a sender is trusted if it belongs to a live IDE window, and
  // streaming services reply to the *calling* window via a per-sender emitter.
  isTrustedSender = () => true,
  getWindowForSender = () => null,
  emitTo = () => () => {},
  createNewWindow = () => {},
  openFileForWindow = async () => ({}),
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
  novadb,
  novadbConnector,
  deploy,
  hosting,
  diagnosis,
  preview,
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
      if (!isTrustedSender(event.sender)) {
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
  handle('dialog:choose-directory', async (event) => {
    const win = getWindowForSender(event.sender);
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

  // --- window management (multi-window) ------------------------------------
  handle('window:new', () => createNewWindow());

  handle('window:close', (event) => {
    const win = getWindowForSender(event.sender);
    if (win && !win.isDestroyed()) win.close();
    return { ok: true };
  });

  handle('dialog:open-file', (event) => openFileForWindow(getWindowForSender(event.sender)));

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
  handle('terminal:start', (event, payload = {}) => terminal.start(payload, emitTo(event.sender.id, 'terminal:event')));

  handle('terminal:cancel', (_event, runId) => terminal.cancel(String(runId || '')));

  handle('terminal:profiles', () => terminal.profiles());

  // AI Agent runs a command to completion and gets its captured output back.
  // Confined to the workspace; never throws (resolves with a structured error).
  handle('terminal:run-capture', (_event, payload = {}) => {
    if (!payload.root) throw new pathGuard.PathGuardError('Open a folder first.');
    return terminal.runCapture(payload);
  });

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

  handle('ai:chat', (event, payload = {}) => ai.start(payload, emitTo(event.sender.id, 'ai:event')));

  // Inline ghost-text suggestions: same auth gate as chat, never throws.
  handle('ai:complete', (event, payload = {}) => ai.complete(payload, emitTo(event.sender.id, 'ai:event')));

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

  handle('app:quit', () => {
    app.quit();
    return { ok: true };
  });

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

  // --- NovaDB (the IDE's own database engine) ------------------------------
  // The renderer never sees the engine: it sends a SQL string (+ optional bind
  // params) over a closed channel and gets a plain result object back. The
  // service owns persistence; nothing here touches the filesystem directly.
  if (novadb) {
    handle('db:status', () => novadb.status());
    handle('db:execute', (_event, { sql, params } = {}) => {
      if (typeof sql !== 'string' || !sql.trim()) throw new Error('A SQL statement is required.');
      return novadb.execute(sql, Array.isArray(params) ? params : []);
    });
  }

  // --- NovaDB external connector (loopback TCP server for separate programs) --
  // The renderer can inspect and toggle the connector. `configure` is the only
  // mutating channel; the server itself clamps the host to loopback and owns the
  // shared token, so no arbitrary bind address can be requested from the UI.
  if (novadbConnector) {
    handle('db:connectorStatus', () => novadbConnector.status());
    handle('db:connectorConfigure', (_event, { enabled, port, regenerateToken } = {}) => {
      const patch = {};
      if (typeof enabled === 'boolean') patch.enabled = enabled;
      if (Number.isInteger(port)) patch.port = port;
      if (typeof regenerateToken === 'boolean') patch.regenerateToken = regenerateToken;
      return novadbConnector.configure(patch);
    });
  }

  // --- Deploy (build / preview / export the user's own project) --------------
  // All operations are confined to the opened workspace via pathGuard inside
  // the deploy + preview services. Building shells out through the terminal
  // service; the preview server is loopback-only. These three channels never
  // touch the network — publishing lives in the hosting block below.
  if (deploy) {
    handle('deploy:detect', (_event, root) => {
      if (!root) throw new pathGuard.PathGuardError('Open a folder first.');
      return deploy.detect(root);
    });
    handle('deploy:build', (_event, { root, command, timeoutMs } = {}) => {
      if (!root) throw new pathGuard.PathGuardError('Open a folder first.');
      return deploy.build(root, { command, timeoutMs });
    });
    handle('deploy:export', (_event, { root, outputDir } = {}) => {
      if (!root) throw new pathGuard.PathGuardError('Open a folder first.');
      return deploy.exportBundle(root, { outputDir });
    });
  }

  // --- hosting providers (real deploys through the adapter registry) --------
  // The only place provider network calls can originate from: the renderer gets
  // named, argument-checked channels, the controller reads the access token from
  // the encrypted store inside this process, and no token ever travels back.
  if (hosting) {
    const requireRoot = (value) => {
      const root = clip(value, 1000);
      if (!root) throw new pathGuard.PathGuardError('Open a folder first.');
      return root;
    };
    const requireProvider = (value) => {
      const provider = clip(value, 32);
      if (!provider) throw new Error('Choose a hosting provider first.');
      return provider;
    };
    const optionalId = (value) => {
      if (value === undefined || value === null) return undefined;
      const raw = typeof value === 'string' ? value.trim() : '';
      if (!raw) return undefined;
      // Deliberately not clipped: a truncated team or project id would silently
      // retarget the deployment at a different (or nonexistent) account, and
      // §3 requires the deploy to belong to the account the user picked.
      if (!DEPLOY_ID.test(raw)) throw new Error('That value is not a valid identifier.');
      return raw;
    };
    const requireRun = (value) => {
      const runId = optionalId(value);
      if (!runId) throw new Error('A deployment run id is required.');
      return runId;
    };

    handle('deploy:providers', () => hosting.providers());
    handle('deploy:connections', () => hosting.connections());

    // Connecting verifies against the provider BEFORE storing, so a typo or a
    // revoked token can never leave the UI claiming an account is connected.
    handle('deploy:connect', (_event, { provider, token } = {}) => hosting.connect({
      provider: requireProvider(provider),
      token: clip(token, 400),
    }));

    handle('deploy:disconnect', (_event, { provider } = {}) => hosting.disconnect({ provider: requireProvider(provider) }));
    handle('deploy:teams', (_event, { provider } = {}) => hosting.teams({ provider: requireProvider(provider) }));
    handle('deploy:projects', (_event, { provider, teamId } = {}) => hosting.listProjects({
      provider: requireProvider(provider),
      teamId: optionalId(teamId),
    }));
    handle('deploy:deploys', (_event, { provider, teamId, project } = {}) => hosting.listDeploys({
      provider: requireProvider(provider),
      teamId: optionalId(teamId),
      project: optionalId(project),
    }));
    handle('deploy:domains', (_event, { provider, teamId, project } = {}) => hosting.domains({
      provider: requireProvider(provider),
      teamId: optionalId(teamId),
      project: optionalId(project),
    }));
    handle('deploy:providerLogs', (_event, { provider, teamId, deploymentId, project } = {}) => hosting.deployLogs({
      provider: requireProvider(provider),
      teamId: optionalId(teamId),
      deploymentId: optionalId(deploymentId),
      project: optionalId(project),
    }));

    handle('deploy:plan', (_event, { root, provider, teamId, project, rebuild } = {}) => hosting.plan({
      root: requireRoot(root),
      provider: requireProvider(provider),
      teamId: optionalId(teamId),
      project: optionalId(project),
      rebuild: isTrue(rebuild),
    }));

    // Start a deployment. The confirmation flags are explicit: a production
    // publish, running the project's own build script, and knowingly shipping
    // only the frontend all have to be approved by name.
    const deployStartArgs = (payload = {}) => ({
      root: requireRoot(payload.root),
      provider: requireProvider(payload.provider),
      teamId: optionalId(payload.teamId),
      project: optionalId(payload.project),
      buildCommand: clip(payload.buildCommand, 300) || undefined,
      outputDir: clip(payload.outputDir, 200) || undefined,
      production: payload.production === false ? false : true,
      rebuild: isTrue(payload.rebuild),
      confirmProduction: isTrue(payload.confirmProduction),
      confirmBuild: isTrue(payload.confirmBuild),
      acknowledgeFrontendOnly: isTrue(payload.acknowledgeFrontendOnly),
      envVars: envVarList(payload.envVars),
    });

    handle('deploy:start', (event, payload) => hosting.start(deployStartArgs(payload), emitTo(event.sender.id, 'deploy:event')));

    handle('deploy:redeploy', (event, payload) => hosting.redeploy({
      ...deployStartArgs(payload),
    }, emitTo(event.sender.id, 'deploy:event')));

    handle('deploy:status', (_event, { runId } = {}) => hosting.status({ runId: requireRun(runId) }));
    // The panel re-attaches to a deploy that is still running in this process
    // after the renderer reloads, instead of losing sight of it.
    handle('deploy:runs', () => hosting.listRuns());
    handle('deploy:refresh', (_event, { runId } = {}) => hosting.refresh({ runId: requireRun(runId) }));
    handle('deploy:cancel', (_event, { runId } = {}) => hosting.cancel({ runId: requireRun(runId) }));
    handle('deploy:runLogs', (_event, { runId } = {}) => hosting.runLogs({ runId: requireRun(runId) }));

    // Explaining a failed deployment is opt-in per click: the diagnostics module
    // builds redacted evidence and asks the assistant the developer configured.
    // Without it the panel still shows the run log, just no written diagnosis.
    if (diagnosis) {
      handle('deploy:diagnose', (_event, { runId } = {}) => diagnosis.diagnose({ runId: requireRun(runId) }));
    }

    handle('deploy:history', (_event, { root } = {}) => hosting.historyList({ root: clip(root, 1000) }));
    handle('deploy:historyClear', (_event, { root, confirm } = {}) => hosting.historyClear({
      root: clip(root, 1000),
      confirm: isTrue(confirm),
    }));
    handle('deploy:preferences', () => hosting.getPreferences());
    handle('deploy:setPreferences', (_event, { provider, teamId } = {}) => hosting.setPreferences({
      provider: clip(provider, 32),
      teamId: optionalId(teamId),
    }));
  }

  if (preview) {
    handle('deploy:previewStatus', () => preview.status());
    handle('deploy:previewStart', (_event, { root, dir } = {}) => {
      if (!root) throw new pathGuard.PathGuardError('Open a folder first.');
      return preview.start({ root, dir });
    });
    handle('deploy:previewStop', () => preview.stop());
  }

  // --- NovaLink Live (internet-connected team collaboration) ---------------
  //
  // One named channel per Live method. Every argument is re-typed here before
  // it reaches the main-process client: ids must be UUIDs, strings are
  // length-clipped, bytes are Uint8Array with a hard ceiling, and only the
  // named keys a method actually reads cross the wire. The client re-validates
  // and the server validates again, but a hostile or buggy renderer should
  // never get to make the client issue a request it was not designed to make.
  if (novalink) {
    const LIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const liveId = (value, label) => {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (!LIVE_ID.test(trimmed)) throw new Error(`${label} must be a uuid.`);
      return trimmed;
    };
    const liveOptId = (value, label) => {
      if (value === undefined || value === null || value === '') return undefined;
      return liveId(value, label);
    };
    const liveStr = (value, max, label, { required = false } = {}) => {
      const text = typeof value === 'string' ? value.trim() : '';
      if (required && !text) throw new Error(`${label} is required.`);
      return text.slice(0, max);
    };
    const liveBool = (value) => (typeof value === 'boolean' ? value : undefined);
    const liveInt = (value, { min, max }) => {
      if (value === undefined || value === null || value === '') return undefined;
      const n = Number(value);
      if (!Number.isFinite(n)) return undefined;
      const i = Math.floor(n);
      if (i < min) return min;
      if (i > max) return max;
      return i;
    };
    // Renderer sends Uint8Array (Electron structured-clone); we hand the client
    // a Buffer. Anything else — a plain array, an object, a string — is refused
    // before we allocate.
    const liveBytes = (value, max) => {
      if (!value) throw new Error('File bytes are required.');
      if (typeof value !== 'object') throw new Error('File bytes must be a Uint8Array.');
      const buf = Buffer.isBuffer(value)
        ? value
        : ArrayBuffer.isView(value)
          ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          : null;
      if (!buf) throw new Error('File bytes must be a Uint8Array.');
      if (buf.length === 0) throw new Error('File is empty.');
      if (buf.length > max) throw new Error(`File exceeds the ${Math.round(max / 1024 / 1024)} MB limit.`);
      return buf;
    };
    const liveIdList = (value, label, max) => {
      if (!Array.isArray(value)) return undefined;
      return value.slice(0, max).map((id) => liveId(id, label));
    };

    // Lifecycle & status
    handle('novalinkLive:status', () => novalink.status());
    handle('novalinkLive:boot', (_event, payload = {}) => novalink.boot({
      baseUrl: liveStr(payload.baseUrl, 400, 'Server address') || undefined,
      autoConnect: payload.autoConnect !== false,
    }));
    handle('novalinkLive:configure', (_event, payload = {}) => novalink.configure({
      baseUrl: liveStr(payload.baseUrl, 400, 'Server address'),
    }));
    handle('novalinkLive:reconnect', () => novalink.reconnectNow());

    // Auth & profile
    handle('novalinkLive:register', (_event, payload = {}) => novalink.register({
      username: liveStr(payload.username, 32, 'A username', { required: true }),
      password: liveStr(payload.password, 256, 'A password', { required: true }),
      displayName: liveStr(payload.displayName, 64, 'Display name') || undefined,
      bio: liveStr(payload.bio, 500, 'Bio') || undefined,
    }));
    handle('novalinkLive:login', (_event, payload = {}) => novalink.login({
      username: liveStr(payload.username, 64, 'A username', { required: true }),
      password: liveStr(payload.password, 256, 'A password', { required: true }),
    }));
    handle('novalinkLive:logout', () => novalink.logout());
    handle('novalinkLive:me', () => novalink.me());
    handle('novalinkLive:bootstrap', () => novalink.bootstrap());
    handle('novalinkLive:updateProfile', (_event, payload = {}) => novalink.updateProfile({
      displayName: liveStr(payload.displayName, 64, 'Display name'),
      bio: liveStr(payload.bio, 500, 'Bio'),
    }));
    handle('novalinkLive:uploadAvatar', (_event, payload = {}) => novalink.uploadAvatar({
      bytes: liveBytes(payload.bytes, 2 * 1024 * 1024),
      fileName: liveStr(payload.fileName, 128, 'File name') || 'avatar.png',
    }));
    handle('novalinkLive:deleteAvatar', () => novalink.deleteAvatar());
    handle('novalinkLive:changePassword', (_event, payload = {}) => novalink.changePassword({
      currentPassword: liveStr(payload.currentPassword, 256, 'Your current password', { required: true }),
      newPassword: liveStr(payload.newPassword, 256, 'A new password', { required: true }),
    }));
    handle('novalinkLive:updatePrivacy', (_event, payload = {}) => {
      const body = {};
      for (const key of ['presenceVisibleTo', 'contactRequestsFrom']) {
        if (payload[key] !== undefined) body[key] = liveStr(payload[key], 32, key);
      }
      for (const key of ['appearOffline', 'showLastActive', 'readReceiptsEnabled', 'callsEnabled', 'attachmentsEnabled']) {
        const v = liveBool(payload[key]);
        if (v !== undefined) body[key] = v;
      }
      return novalink.updatePrivacy(body);
    });

    // Directory & connections
    handle('novalinkLive:searchUsers', (_event, payload = {}) => novalink.searchUsers({
      q: liveStr(payload.q, 64, 'Search query'),
      limit: liveInt(payload.limit, { min: 1, max: 50 }),
    }));
    handle('novalinkLive:getUser', (_event, payload = {}) => novalink.getUser(liveId(payload.userId, 'User id')));
    handle('novalinkLive:listContacts', () => novalink.listContacts());
    handle('novalinkLive:listRequests', () => novalink.listRequests());
    handle('novalinkLive:requestConnection', (_event, payload = {}) => novalink.requestConnection({
      userId: liveOptId(payload.userId, 'User id'),
      username: liveStr(payload.username, 64, 'Username') || undefined,
      message: liveStr(payload.message, 240, 'Message') || undefined,
    }));
    handle('novalinkLive:acceptRequest', (_event, payload = {}) => novalink.acceptRequest(liveId(payload.requestId, 'Request id')));
    handle('novalinkLive:rejectRequest', (_event, payload = {}) => novalink.rejectRequest(liveId(payload.requestId, 'Request id')));
    handle('novalinkLive:removeContact', (_event, payload = {}) => novalink.removeContact(liveId(payload.userId, 'User id')));
    handle('novalinkLive:listBlocked', () => novalink.listBlocked());
    handle('novalinkLive:blockUser', (_event, payload = {}) => novalink.blockUser(liveId(payload.userId, 'User id')));
    handle('novalinkLive:unblockUser', (_event, payload = {}) => novalink.unblockUser(liveId(payload.userId, 'User id')));
    handle('novalinkLive:reportUser', (_event, payload = {}) => novalink.reportUser({
      userId: liveId(payload.userId, 'User id'),
      reason: liveStr(payload.reason, 80, 'Reason') || undefined,
      detail: liveStr(payload.detail, 1000, 'Detail') || undefined,
    }));

    // Conversations & messages
    handle('novalinkLive:listConversations', () => novalink.listConversations());
    handle('novalinkLive:createConversation', (_event, payload = {}) => novalink.createConversation({
      kind: liveStr(payload.kind, 12, 'Kind') || undefined,
      otherUserId: liveOptId(payload.otherUserId, 'Other user id'),
      memberIds: liveIdList(payload.memberIds, 'Member id', 64),
      title: liveStr(payload.title, 120, 'Title') || undefined,
    }));
    handle('novalinkLive:getConversation', (_event, payload = {}) => novalink.getConversation(liveId(payload.conversationId, 'Conversation id')));
    handle('novalinkLive:listMessages', (_event, payload = {}) => novalink.listMessages(liveId(payload.conversationId, 'Conversation id'), {
      before: payload.before === undefined || payload.before === null ? undefined : String(payload.before).slice(0, 24),
      limit: liveInt(payload.limit, { min: 1, max: 200 }),
    }));
    handle('novalinkLive:sendMessage', (_event, payload = {}) => novalink.sendMessage(liveId(payload.conversationId, 'Conversation id'), {
      body: liveStr(payload.body, 8000, 'A message', { required: true }),
      kind: ['text', 'code', 'file'].includes(payload.kind) ? payload.kind : undefined,
      metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : undefined,
      language: liveStr(payload.language, 24, 'Language') || undefined,
      replyToId: liveOptId(payload.replyToId, 'Reply-to message id'),
      clientId: liveStr(payload.clientId, 64, 'Client id') || undefined,
      attachmentIds: liveIdList(payload.attachmentIds, 'Attachment id', 8),
    }));
    handle('novalinkLive:markRead', (_event, payload = {}) => novalink.markRead(
      liveId(payload.conversationId, 'Conversation id'),
      liveInt(payload.seq, { min: 0, max: 1_000_000_000 }),
    ));
    handle('novalinkLive:listAttachments', (_event, payload = {}) => novalink.listAttachments(liveId(payload.conversationId, 'Conversation id')));
    handle('novalinkLive:searchMessages', (_event, payload = {}) => novalink.searchMessages({
      q: liveStr(payload.q, 120, 'Search query'),
      conversationId: liveOptId(payload.conversationId, 'Conversation id'),
      limit: liveInt(payload.limit, { min: 1, max: 50 }),
    }));
    handle('novalinkLive:addReaction', (_event, payload = {}) => novalink.addReaction(
      liveId(payload.messageId, 'Message id'),
      liveStr(payload.emoji, 32, 'An emoji', { required: true }),
    ));
    handle('novalinkLive:removeReaction', (_event, payload = {}) => novalink.removeReaction(
      liveId(payload.messageId, 'Message id'),
      liveStr(payload.emoji, 32, 'An emoji', { required: true }),
    ));

    // Files & avatars
    handle('novalinkLive:uploadFile', (_event, payload = {}) => novalink.uploadFile({
      conversationId: liveId(payload.conversationId, 'Conversation id'),
      bytes: liveBytes(payload.bytes, 25 * 1024 * 1024),
      fileName: liveStr(payload.fileName, 200, 'File name') || 'file.bin',
    }));
    handle('novalinkLive:downloadFile', (_event, payload = {}) => novalink.downloadFile(liveId(payload.fileId, 'File id')));
    handle('novalinkLive:deleteFile', (_event, payload = {}) => novalink.deleteFile(liveId(payload.fileId, 'File id')));
    handle('novalinkLive:avatarUrl', (_event, payload = {}) => ({ url: novalink.avatarUrl(liveId(payload.avatarId, 'Avatar id')) }));
    handle('novalinkLive:fetchAvatar', (_event, payload = {}) => novalink.fetchAvatar(liveId(payload.avatarId, 'Avatar id')));

    // Calls
    handle('novalinkLive:startCall', (_event, payload = {}) => novalink.startCall(
      liveId(payload.conversationId, 'Conversation id'),
      liveStr(payload.mode, 12, 'Mode') || 'audio',
    ));
    handle('novalinkLive:acceptCall', (_event, payload = {}) => novalink.acceptCall(liveId(payload.callId, 'Call id')));
    handle('novalinkLive:declineCall', (_event, payload = {}) => novalink.declineCall(liveId(payload.callId, 'Call id')));
    handle('novalinkLive:endCall', (_event, payload = {}) => novalink.endCall(
      liveId(payload.callId, 'Call id'),
      liveStr(payload.reason, 40, 'Reason') || undefined,
    ));
    handle('novalinkLive:cancelCall', (_event, payload = {}) => novalink.cancelCall(liveId(payload.callId, 'Call id')));
    handle('novalinkLive:currentCall', () => novalink.currentCall());
    handle('novalinkLive:callHistory', (_event, payload = {}) => novalink.callHistory(
      liveId(payload.conversationId, 'Conversation id'),
      liveInt(payload.limit, { min: 1, max: 50 }),
    ));

    // Realtime frames — the only 5 the server accepts, so the surface is closed.
    handle('novalinkLive:sendPing', (_event, payload = {}) => novalink.sendPing(liveStr(payload.id, 64, 'Ping id') || undefined));
    handle('novalinkLive:sendPresence', (_event, payload = {}) => novalink.sendPresence(liveStr(payload.status, 16, 'Presence status', { required: true })));
    handle('novalinkLive:sendTyping', (_event, payload = {}) => novalink.sendTyping({
      conversationId: liveId(payload.conversationId, 'Conversation id'),
      typing: payload.typing !== false,
    }));
    handle('novalinkLive:sendMessageRead', (_event, payload = {}) => novalink.sendMessageRead({
      conversationId: liveId(payload.conversationId, 'Conversation id'),
      seq: liveInt(payload.seq, { min: 0, max: 1_000_000_000 }) || 0,
    }));
    handle('novalinkLive:sendCallSignal', (_event, payload = {}) => {
      // `payload.payload` is the SDP/candidate/mute body; forwarded verbatim
      // because the Live client clips per signal kind before the socket send.
      const inner = payload.payload && typeof payload.payload === 'object' && !Array.isArray(payload.payload) ? payload.payload : {};
      return novalink.sendCallSignal({
        callId: liveId(payload.callId, 'Call id'),
        toUserId: liveId(payload.toUserId, 'Peer id'),
        signal: liveStr(payload.signal, 24, 'Signal kind', { required: true }),
        payload: inner,
      });
    });

    // Native notifications. The renderer never touches `new Notification()`;
    // every OS-visible toast goes through this channel so we can rate, gate,
    // and — critically — hand focus back to the correct window on click.
    handle('novalinkLive:notify', (event, payload = {}) => {
      const title = liveStr(payload.title, 80, 'Notification title', { required: true });
      const body = liveStr(payload.body, 200, 'Notification body');
      const conversationId = liveOptId(payload.conversationId);
      const Notification = electron.Notification;
      if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) {
        return { ok: false, reason: 'unsupported' };
      }
      const sender = event.sender;
      const notification = new Notification({
        title,
        body,
        silent: false,
        urgency: 'normal',
      });
      notification.once('click', () => {
        try {
          const win = getWindowForSender(sender);
          if (win && !win.isDestroyed()) {
            if (typeof win.show === 'function') win.show();
            if (typeof win.focus === 'function') win.focus();
            if (win.webContents && !win.webContents.isDestroyed()) {
              win.webContents.send('novalinkLive:open-conversation', { conversationId });
            }
          }
        } catch {
          // Focus restoration is best-effort.
        }
      });
      notification.show();
      return { ok: true };
    });
  }

  return { channelCount: handlers.size };
}

module.exports = { registerIpc };
