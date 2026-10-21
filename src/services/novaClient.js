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

export const client = {
  async chooseDirectory() {
    requireDesktop();
    return nova.chooseDirectory();
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
};
