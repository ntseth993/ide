/**
 * Renderer-side client for the NovaCode preload bridge.
 *
 * Wraps window.novaApi with friendly error normalization so UI components
 * can surface problems without leaking stack traces, and degrades
 * gracefully when the IDE is viewed outside Electron (browser, tests).
 */
import { signInLocal, getAccountLocal, signOutLocal } from './localAccount';

export const nova = typeof window !== 'undefined' ? window.novaApi : undefined;
export const isDesktop = Boolean(nova);

/** Normalize an IPC failure into a user-presentable message. */
export function toUserMessage(error) {
  if (!error) return 'Something went wrong.';
  if (typeof error === 'string') return error;
  return error.message || 'Something went wrong.';
}

function requireDesktop() {
  if (!nova) {
    throw new Error('NovaCode runs as a desktop app. Launch it with "npm run dev" or the installed build.');
  }
}

/**
 * The renderer hot-reloads, but Electron's preload/main only load at app start.
 * When a bridge method is missing the running process is stale, so surface an
 * actionable "restart" hint instead of a raw "X is not a function".
 */
function requireBridgeMethod(name, feature) {
  requireDesktop();
  if (typeof nova[name] !== 'function') {
    throw new Error(`${feature} needs a NovaCode restart to load. Stop the app and run "npm run dev" again.`);
  }
}

export const client = {
  async chooseDirectory() {
    requireDesktop();
    return nova.chooseDirectory();
  },
  // Open a single file via the native picker (main process routes it back to
  // this window). Requires the desktop bridge.
  async openFile() {
    requireDesktop();
    return nova.openFile();
  },
  // Multi-window + lifecycle. Fire-and-forget: outside Electron they no-op.
  newWindow() {
    nova?.newWindow?.();
  },
  closeWindow() {
    nova?.closeWindow?.();
  },
  quitApp() {
    nova?.quitApp?.();
  },
  async validateWorkspace(root) {
    requireDesktop();
    return nova.validateWorkspace(root);
  },
  async readDir(root, target) {
    requireDesktop();
    return nova.readDir(root, target);
  },
  async readFile(root, filePath) {
    requireDesktop();
    return nova.readFile(root, filePath);
  },
  async writeFile(root, filePath, content) {
    requireDesktop();
    return nova.writeFile(root, filePath, content);
  },
  async createFile(root, dir, name) {
    requireDesktop();
    return nova.createFile(root, dir, name);
  },
  async createFolder(root, dir, name) {
    requireDesktop();
    return nova.createFolder(root, dir, name);
  },
  async renamePath(root, target, newName) {
    requireDesktop();
    return nova.renamePath(root, target, newName);
  },
  async deletePath(root, target) {
    requireDesktop();
    return nova.deletePath(root, target);
  },
  async searchWorkspace(root, options) {
    requireDesktop();
    return nova.searchWorkspace(root, options);
  },
  async applyAiEdit(root, filePath, content) {
    requireDesktop();
    return nova.applyAiEdit(root, filePath, content);
  },
  async listHistory(root) {
    requireDesktop();
    return nova.listHistory(root);
  },
  async restoreHistory(root, id) {
    requireDesktop();
    return nova.restoreHistory(root, id);
  },
  async startTerminal(payload) {
    requireDesktop();
    return nova.startTerminal(payload);
  },
  async terminalProfiles() {
    if (!nova || typeof nova.terminalProfiles !== 'function') {
      return { platform: 'browser', defaultId: '', profiles: [] };
    }
    return nova.terminalProfiles();
  },
  cancelTerminal(runId) {
    nova?.cancelTerminal(runId);
  },
  // AI Agent command execution. Degrades to a structured error (never throws)
  // when the bridge is missing or stale, so the agent loop can surface it.
  async runTerminalCapture(payload) {
    if (!nova || typeof nova.runTerminalCapture !== 'function') {
      return { output: '', code: null, error: 'Running commands needs a NovaCode restart to load. Stop the app and run "npm run dev" again.' };
    }
    return nova.runTerminalCapture(payload);
  },
  onTerminalEvent(callback) {
    return nova ? nova.onTerminalEvent(callback) : () => {};
  },
  // main -> renderer: `nova <folder|file>` was requested on the CLI
  onWorkspaceRequest(callback) {
    return nova ? nova.onWorkspaceRequest(callback) : () => {};
  },
  // main -> renderer: the native application menu dispatched a command
  onMenuCommand(callback) {
    return nova ? nova.onMenuCommand(callback) : () => {};
  },
  async getSettings() {
    if (!nova) return null;
    return nova.getSettings();
  },
  async saveSettings(patch) {
    requireDesktop();
    return nova.saveSettings(patch);
  },
  async setApiKey(provider, key) {
    requireDesktop();
    return nova.setApiKey(provider, key);
  },
  async clearApiKey(provider) {
    requireDesktop();
    return nova.clearApiKey(provider);
  },
  async apiKeyStatus(provider) {
    if (!nova) return { provider, hasKey: false, source: null };
    return nova.apiKeyStatus(provider);
  },
  async listAiProviders() {
    if (!nova) return [];
    return nova.listAiProviders();
  },
  async checkAiConnection(provider, baseUrl) {
    requireDesktop();
    return nova.checkAiConnection(provider, baseUrl);
  },
  async startChat(payload) {
    requireDesktop();
    return nova.startChat(payload);
  },
  // Inline completions must never break typing: outside Electron, or on any
  // failure, the answer is simply "no suggestion".
  async aiComplete(payload) {
    if (!nova || typeof nova.aiComplete !== 'function') return { text: '', reason: 'unavailable' };
    try {
      return await nova.aiComplete(payload);
    } catch {
      return { text: '', reason: 'error' };
    }
  },
  cancelChat(runId) {
    nova?.cancelChat(runId);
  },
  onAiEvent(callback) {
    return nova ? nova.onAiEvent(callback) : () => {};
  },

  // ---- accounts (local sign-in, per-email token, token budget) --------------
  async signIn(email, name) {
    if (!nova) return signInLocal({ email, name });
    return nova.signIn(email, name);
  },
  async getAccount() {
    if (!nova) return getAccountLocal();
    return nova.getAccount();
  },
  async signOut() {
    if (!nova) return signOutLocal();
    return nova.signOut();
  },
  // Open the default browser for sign-in; resolves with { ok, url } and the
  // resulting account arrives asynchronously via onAuthSession. In browser
  // mode there is no main process, so we return { local: true } and let the UI
  // collect the email in-app (backed by the renderer-side account store).
  async beginLogin() {
    if (!nova) return { ok: true, local: true, url: '' };
    return nova.beginLogin();
  },
  cancelLogin() {
    nova?.cancelLogin?.();
  },
  onAuthSession(callback) {
    return nova?.onAuthSession ? nova.onAuthSession(callback) : () => {};
  },
  // Sign-in provider config (Google/GitHub/Microsoft). Values are stored
  // encrypted in the main process; the renderer only sees presence booleans.
  async oauthStatus() {
    if (!nova || typeof nova.oauthStatus !== 'function') return [];
    return nova.oauthStatus();
  },
  async setOauthConfig(payload) {
    requireDesktop();
    return nova.setOauthConfig(payload);
  },
  openExternal(url) {
    nova?.openExternal(url);
  },
  async appInfo() {
    if (!nova) {
      return { version: 'dev', platform: 'browser', electron: '-', node: '-', chrome: '-' };
    }
    return nova.appInfo();
  },
  /**
   * Mirror the active theme onto native surfaces (window background, OS title
   * bar). Purely cosmetic, so it is fire-and-forget: in browser preview, on an
   * older bridge, or on any IPC failure the app simply keeps its web theme.
   */
  setWindowAppearance(payload) {
    try {
      const result = nova?.setWindowAppearance?.(payload);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      /* ignore */
    }
  },

  // ---- extensions ------------------------------------------------------------
  async listExtensions() {
    requireDesktop();
    return nova.listExtensions();
  },
  async installExtension(id) {
    requireDesktop();
    return nova.installExtension(id);
  },
  async updateExtension(id) {
    requireDesktop();
    return nova.updateExtension(id);
  },
  async setExtensionEnabled(id, enabled) {
    requireDesktop();
    return nova.setExtensionEnabled(id, enabled);
  },
  async uninstallExtension(id) {
    requireDesktop();
    return nova.uninstallExtension(id);
  },
  // Remote marketplace (Open VSX). Degrades to an empty, flagged result when
  // the bridge is absent so the Extensions view can show an offline notice.
  async searchExtensions(query) {
    if (!nova || typeof nova.searchExtensions !== 'function') {
      return { results: [], total: 0, unavailable: true };
    }
    return nova.searchExtensions(query);
  },
  async installMarketplace(payload) {
    requireDesktop();
    return nova.installMarketplace(payload);
  },

  // ---- language runtimes ------------------------------------------------------
  async detectRuntimes() {
    if (!nova) return { runtimes: [], detectedAt: null, unavailable: true };
    return nova.detectRuntimes();
  },

  // ---- NovaDB (the IDE's own database engine) --------------------------------
  // Outside Electron there is no main-process engine, so status resolves to an
  // empty, flagged snapshot and every execute needs the desktop bridge. The
  // Database workspace and the `novadb` terminal command share these methods.
  async novaDbStatus() {
    if (!nova || typeof nova.novaDbStatus !== 'function') {
      return { current: null, databases: [], storagePath: null, ready: false, unavailable: true };
    }
    return nova.novaDbStatus();
  },
  async novaDbExec(sql, params = []) {
    requireBridgeMethod('novaDbExec', 'NovaDB');
    return nova.novaDbExec(sql, params);
  },
  // NovaDB external connector (loopback TCP server). Status degrades gracefully
  // off-desktop; toggling it needs the desktop bridge.
  async novaDbConnectorStatus() {
    if (!nova || typeof nova.novaDbConnectorStatus !== 'function') {
      return { running: false, enabled: false, host: '127.0.0.1', port: 0, token: null, unavailable: true };
    }
    return nova.novaDbConnectorStatus();
  },
  async novaDbConnectorConfigure(patch) {
    requireBridgeMethod('novaDbConnectorConfigure', 'the NovaDB external connector');
    return nova.novaDbConnectorConfigure(patch);
  },

  // ---- Deploy (build / preview / export the opened project) -----------------
  // All of these need the desktop bridge (they run commands and touch the
  // workspace). Preview status degrades gracefully so the panel can render.
  async deployDetect(root) {
    requireBridgeMethod('deployDetect', 'Deploy');
    return nova.deployDetect(root);
  },
  async deployBuild(payload) {
    requireBridgeMethod('deployBuild', 'Deploy build');
    return nova.deployBuild(payload);
  },
  async deployExport(payload) {
    requireBridgeMethod('deployExport', 'Deploy export');
    return nova.deployExport(payload);
  },
  async deployPreviewStatus() {
    if (!nova || typeof nova.deployPreviewStatus !== 'function') {
      return { running: false, url: null, port: null };
    }
    return nova.deployPreviewStatus();
  },
  async deployPreviewStart(payload) {
    requireBridgeMethod('deployPreviewStart', 'Deploy preview');
    return nova.deployPreviewStart(payload);
  },
  async deployPreviewStop() {
    if (!nova || typeof nova.deployPreviewStop !== 'function') return { running: false, url: null, port: null };
    return nova.deployPreviewStop();
  },

  // ---- NovaLink peer-to-peer collaboration -----------------------------------
  // The panel renders a single state snapshot streamed from the main process.
  // Outside Electron there is no collaboration, so status resolves to an
  // empty, flagged snapshot and every action requires the desktop bridge.
  async novalinkStatus() {
    if (!nova || typeof nova.novalinkStatus !== 'function') {
      return {
        ready: false, unavailable: true, scanning: false, activeTransport: null,
        identity: null, transports: [], nearby: [], requests: { incoming: [], outgoing: [] },
        peers: [], chats: {}, transfers: [], bluetooth: null,
      };
    }
    return nova.novalinkStatus();
  },
  async novalinkDiscover() {
    requireDesktop();
    return nova.novalinkDiscover();
  },
  async novalinkStopDiscovery() {
    requireDesktop();
    return nova.novalinkStopDiscovery();
  },
  async novalinkEnableBluetooth() {
    requireBridgeMethod('novalinkEnableBluetooth', 'Bluetooth controls');
    return nova.novalinkEnableBluetooth();
  },
  async novalinkScanBluetooth() {
    requireBridgeMethod('novalinkScanBluetooth', 'Bluetooth device scanning');
    return nova.novalinkScanBluetooth();
  },
  async novalinkConnect(peerId) {
    requireDesktop();
    return nova.novalinkConnect(peerId);
  },
  async novalinkAcceptConnection(peerId) {
    requireDesktop();
    return nova.novalinkAcceptConnection(peerId);
  },
  async novalinkRejectConnection(peerId) {
    requireDesktop();
    return nova.novalinkRejectConnection(peerId);
  },
  async novalinkDisconnect(peerId) {
    requireDesktop();
    return nova.novalinkDisconnect(peerId);
  },
  async novalinkSendMessage(peerId, text) {
    requireDesktop();
    return nova.novalinkSendMessage(peerId, text);
  },
  async novalinkShareCode(payload) {
    requireDesktop();
    return nova.novalinkShareCode(payload);
  },
  async novalinkShareFile(payload) {
    requireDesktop();
    return nova.novalinkShareFile(payload);
  },
  async novalinkAcceptTransfer(transferId) {
    requireDesktop();
    return nova.novalinkAcceptTransfer(transferId);
  },
  async novalinkRejectTransfer(transferId) {
    requireDesktop();
    return nova.novalinkRejectTransfer(transferId);
  },
  async novalinkCancelTransfer(transferId) {
    requireDesktop();
    return nova.novalinkCancelTransfer(transferId);
  },
  async novalinkSaveTransfer(payload) {
    requireDesktop();
    return nova.novalinkSaveTransfer(payload);
  },
  onNovaLinkEvent(callback) {
    return nova?.onNovaLinkEvent ? nova.onNovaLinkEvent(callback) : () => {};
  },
};
