/**
 * Preload bridge.
 *
 * Exposes the ONLY surface the renderer can use to reach privileged
 * functionality. There is no generic invoke passthrough: every method is a
 * named contract bound to a specific validated IPC channel. Runs inside the
 * sandbox with context isolation enabled.
 */
const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

function subscribe(channel, callback) {
  const handler = (_event, data) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  // dialogs & workspace
  chooseDirectory: () => invoke('dialog:choose-directory'),
  validateWorkspace: (root) => invoke('workspace:validate', root),
  // main -> renderer: open a folder/file requested via the `nova` CLI
  onWorkspaceRequest: (callback) => subscribe('workspace:request', callback),
  // main -> renderer: native application menu dispatched a command id
  onMenuCommand: (callback) => subscribe('menu:command', callback),

  // filesystem (workspace-confined)
  readDir: (root, target) => invoke('fs:read-dir', { root, target }),
  readFile: (root, filePath) => invoke('fs:read-file', { root, path: filePath }),
  writeFile: (root, filePath, content) => invoke('fs:write-file', { root, path: filePath, content }),
  createFile: (root, dir, name) => invoke('fs:create-file', { root, dir, name }),
  createFolder: (root, dir, name) => invoke('fs:create-folder', { root, dir, name }),
  renamePath: (root, target, newName) => invoke('fs:rename', { root, path: target, newName }),
  deletePath: (root, target) => invoke('fs:delete', { root, path: target }),
  searchWorkspace: (root, options) => invoke('fs:search', { root, ...options }),

  // safe change history (AI edits are journaled in the main process)
  applyAiEdit: (root, filePath, content) => invoke('fs:apply-ai-edit', { root, path: filePath, content }),
  listHistory: (root) => invoke('history:list', root),
  restoreHistory: (root, id) => invoke('history:restore', { root, id }),

  // terminal (streaming)
  startTerminal: (payload) => invoke('terminal:start', payload),
  cancelTerminal: (runId) => invoke('terminal:cancel', runId),
  terminalProfiles: () => invoke('terminal:profiles'),
  onTerminalEvent: (callback) => subscribe('terminal:event', callback),

  // settings
  getSettings: () => invoke('settings:get'),
  saveSettings: (patch) => invoke('settings:set', patch),

  // AI (key never crosses back to the renderer)
  setApiKey: (provider, key) => invoke('ai:set-key', { provider, key }),
  clearApiKey: (provider) => invoke('ai:clear-key', { provider }),
  apiKeyStatus: (provider) => invoke('ai:key-status', { provider }),
  listAiProviders: () => invoke('ai:providers'),
  checkAiConnection: (provider, baseUrl) => invoke('ai:check-connection', { provider, baseUrl }),
  startChat: (payload) => invoke('ai:chat', payload),
  aiComplete: (payload) => invoke('ai:complete', payload),
  cancelChat: (runId) => invoke('ai:cancel', runId),
  onAiEvent: (callback) => subscribe('ai:event', callback),

  // accounts (sign-in opens the default browser; a loopback page hands the session back)
  signIn: (email, name) => invoke('auth:sign-in', { email, name }),
  getAccount: () => invoke('auth:account'),
  signOut: () => invoke('auth:sign-out'),
  beginLogin: () => invoke('auth:begin-login'),
  cancelLogin: () => invoke('auth:cancel-login'),
  onAuthSession: (callback) => subscribe('auth:session', callback),
  oauthStatus: () => invoke('auth:oauth-status'),
  setOauthConfig: (payload) => invoke('auth:set-oauth-config', payload),

  // shell & app
  openExternal: (url) => invoke('shell:open-external', url),
  appInfo: () => invoke('app:info'),
  // Native window chrome for the active theme (background colour + light/dark).
  setWindowAppearance: (payload) => invoke('window:set-appearance', payload),

  // extensions (declarative catalog; state lives in the main process)
  listExtensions: () => invoke('extensions:list'),
  installExtension: (id) => invoke('extensions:install', id),
  updateExtension: (id) => invoke('extensions:update', id),
  setExtensionEnabled: (id, enabled) => invoke('extensions:set-enabled', { id, enabled }),
  uninstallExtension: (id) => invoke('extensions:uninstall', id),
  searchExtensions: (query) => invoke('extensions:search', { query }),
  installMarketplace: (payload) => invoke('extensions:install-market', payload),

  // language runtimes
  detectRuntimes: () => invoke('runtime:detect'),
};

contextBridge.exposeInMainWorld('novaApi', api);
