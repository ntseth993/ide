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

  // ---- Hosting providers (real Vercel / Netlify deployments) ----------------
  // Provider descriptors are readable without the desktop bridge so the panel
  // can explain what is missing; everything that touches an account or the
  // network needs the bridge. An access token only ever goes IN — no method
  // returns one.
  async deployProviders() {
    // Resolves to an empty list outside Electron: the panel then explains that
    // deploying needs the desktop app, instead of pretending there are no hosts.
    if (!nova || typeof nova.deployProviders !== 'function') return [];
    return nova.deployProviders();
  },
  async deployConnections() {
    requireBridgeMethod('deployConnections', 'Hosting account status');
    return nova.deployConnections();
  },
  async deployConnect(payload) {
    requireBridgeMethod('deployConnect', 'Connecting a hosting account');
    return nova.deployConnect(payload);
  },
  async deployDisconnect(payload) {
    requireBridgeMethod('deployDisconnect', 'Disconnecting a hosting account');
    return nova.deployDisconnect(payload);
  },
  async deployTeams(payload) {
    requireBridgeMethod('deployTeams', 'Team listing');
    return nova.deployTeams(payload);
  },
  async deployProjects(payload) {
    requireBridgeMethod('deployProjects', 'Project listing');
    return nova.deployProjects(payload);
  },
  async deployDeploys(payload) {
    requireBridgeMethod('deployDeploys', 'Deployment listing');
    return nova.deployDeploys(payload);
  },
  async deployDomains(payload) {
    requireBridgeMethod('deployDomains', 'Custom domain status');
    return nova.deployDomains(payload);
  },
  async deployProviderLogs(payload) {
    requireBridgeMethod('deployProviderLogs', 'Provider build logs');
    return nova.deployProviderLogs(payload);
  },
  async deployPlan(payload) {
    requireBridgeMethod('deployPlan', 'The deployment review screen');
    return nova.deployPlan(payload);
  },
  async deployStart(payload) {
    requireBridgeMethod('deployStart', 'Deploying to a host');
    return nova.deployStart(payload);
  },
  async deployRedeploy(payload) {
    requireBridgeMethod('deployRedeploy', 'Redeploying');
    return nova.deployRedeploy(payload);
  },
  async deployStatus(payload) {
    requireBridgeMethod('deployStatus', 'Deployment status');
    return nova.deployStatus(payload);
  },
  async deployRuns() {
    if (!nova || typeof nova.deployRuns !== 'function') return [];
    return nova.deployRuns();
  },
  async deployRefresh(payload) {
    requireBridgeMethod('deployRefresh', 'Refreshing deployment status');
    return nova.deployRefresh(payload);
  },
  async deployCancel(payload) {
    requireBridgeMethod('deployCancel', 'Cancelling a deployment');
    return nova.deployCancel(payload);
  },
  async deployRunLogs(payload) {
    requireBridgeMethod('deployRunLogs', 'Deployment logs');
    return nova.deployRunLogs(payload);
  },
  // A written explanation of a failed deployment. Only ever called when the
  // developer clicks it; the answer comes from the main process, where the
  // evidence has already been stripped of credentials.
  async deployDiagnose(payload) {
    requireBridgeMethod('deployDiagnose', 'Explaining a failed deployment');
    return nova.deployDiagnose(payload);
  },
  async deployHistory(payload) {
    requireBridgeMethod('deployHistory', 'Deployment history');
    return nova.deployHistory(payload);
  },
  async deployHistoryClear(payload) {
    requireBridgeMethod('deployHistoryClear', 'Clearing deployment history');
    return nova.deployHistoryClear(payload);
  },
  async deployPreferences() {
    if (!nova || typeof nova.deployPreferences !== 'function') return { provider: '', teams: {} };
    return nova.deployPreferences();
  },
  async deploySetPreferences(payload) {
    requireBridgeMethod('deploySetPreferences', 'Deploy preferences');
    return nova.deploySetPreferences(payload);
  },
  // main -> renderer: live progress of the deployment this window started.
  onDeployEvent(callback) {
    return nova?.onDeployEvent ? nova.onDeployEvent(callback) : () => {};
  },

  // ---- NovaLink Live (internet-connected team collaboration) ------------
  //
  // Outside Electron there is no live socket: `novalinkLiveStatus` resolves to
  // a signed-off snapshot so the panel can render a "not available in the web
  // preview" hint without throwing. Every other method requires the desktop
  // bridge; if the bridge is missing we throw rather than returning a fake
  // success, because silently faking an online action would leave a developer
  // staring at a message they think was sent that never hit the server.
  //
  // Names mirror the preload surface 1:1. Nothing here is a passthrough: there
  // is no generic invoke exposed to React.
  async novalinkLiveStatus() {
    if (!nova || typeof nova.novalinkLiveStatus !== 'function') {
      return {
        configured: false, baseUrl: '', signedIn: false, connected: false, ready: false,
        user: null, privacy: null, server: null,
        reconnectAttempt: 0, lastError: null, lastErrorAt: null,
      };
    }
    return nova.novalinkLiveStatus();
  },

  // lifecycle
  novalinkLiveBoot(payload) { requireDesktop(); return nova.novalinkLiveBoot(payload); },
  novalinkLiveConfigure(payload) { requireDesktop(); return nova.novalinkLiveConfigure(payload); },
  novalinkLiveReconnect() { requireDesktop(); return nova.novalinkLiveReconnect(); },

  // auth & profile
  novalinkLiveRegister(payload) { requireDesktop(); return nova.novalinkLiveRegister(payload); },
  novalinkLiveLogin(payload) { requireDesktop(); return nova.novalinkLiveLogin(payload); },
  novalinkLiveLogout() { requireDesktop(); return nova.novalinkLiveLogout(); },
  novalinkLiveMe() { requireDesktop(); return nova.novalinkLiveMe(); },
  novalinkLiveBootstrap() { requireDesktop(); return nova.novalinkLiveBootstrap(); },
  novalinkLiveUpdateProfile(payload) { requireDesktop(); return nova.novalinkLiveUpdateProfile(payload); },
  novalinkLiveUploadAvatar(payload) { requireDesktop(); return nova.novalinkLiveUploadAvatar(payload); },
  novalinkLiveDeleteAvatar() { requireDesktop(); return nova.novalinkLiveDeleteAvatar(); },
  novalinkLiveChangePassword(payload) { requireDesktop(); return nova.novalinkLiveChangePassword(payload); },
  novalinkLiveUpdatePrivacy(payload) { requireDesktop(); return nova.novalinkLiveUpdatePrivacy(payload); },

  // directory & connections
  novalinkLiveSearchUsers(payload) { requireDesktop(); return nova.novalinkLiveSearchUsers(payload); },
  novalinkLiveGetUser(userId) { requireDesktop(); return nova.novalinkLiveGetUser(userId); },
  novalinkLiveListContacts() { requireDesktop(); return nova.novalinkLiveListContacts(); },
  novalinkLiveListRequests() { requireDesktop(); return nova.novalinkLiveListRequests(); },
  novalinkLiveRequestConnection(payload) { requireDesktop(); return nova.novalinkLiveRequestConnection(payload); },
  novalinkLiveAcceptRequest(requestId) { requireDesktop(); return nova.novalinkLiveAcceptRequest(requestId); },
  novalinkLiveRejectRequest(requestId) { requireDesktop(); return nova.novalinkLiveRejectRequest(requestId); },
  novalinkLiveRemoveContact(userId) { requireDesktop(); return nova.novalinkLiveRemoveContact(userId); },
  novalinkLiveListBlocked() { requireDesktop(); return nova.novalinkLiveListBlocked(); },
  novalinkLiveBlockUser(userId) { requireDesktop(); return nova.novalinkLiveBlockUser(userId); },
  novalinkLiveUnblockUser(userId) { requireDesktop(); return nova.novalinkLiveUnblockUser(userId); },
  novalinkLiveReportUser(payload) { requireDesktop(); return nova.novalinkLiveReportUser(payload); },

  // conversations & messages
  novalinkLiveListConversations() { requireDesktop(); return nova.novalinkLiveListConversations(); },
  novalinkLiveCreateConversation(payload) { requireDesktop(); return nova.novalinkLiveCreateConversation(payload); },
  novalinkLiveGetConversation(conversationId) { requireDesktop(); return nova.novalinkLiveGetConversation(conversationId); },
  novalinkLiveListMessages(payload) { requireDesktop(); return nova.novalinkLiveListMessages(payload); },
  novalinkLiveSendMessage(payload) { requireDesktop(); return nova.novalinkLiveSendMessage(payload); },
  novalinkLiveMarkRead(payload) { requireDesktop(); return nova.novalinkLiveMarkRead(payload); },
  novalinkLiveListAttachments(conversationId) { requireDesktop(); return nova.novalinkLiveListAttachments(conversationId); },
  novalinkLiveSearchMessages(payload) { requireDesktop(); return nova.novalinkLiveSearchMessages(payload); },
  novalinkLiveAddReaction(payload) { requireDesktop(); return nova.novalinkLiveAddReaction(payload); },
  novalinkLiveRemoveReaction(payload) { requireDesktop(); return nova.novalinkLiveRemoveReaction(payload); },

  // files & avatars
  novalinkLiveUploadFile(payload) { requireDesktop(); return nova.novalinkLiveUploadFile(payload); },
  novalinkLiveDownloadFile(fileId) { requireDesktop(); return nova.novalinkLiveDownloadFile(fileId); },
  novalinkLiveDeleteFile(fileId) { requireDesktop(); return nova.novalinkLiveDeleteFile(fileId); },
  novalinkLiveAvatarUrl(avatarId) { requireDesktop(); return nova.novalinkLiveAvatarUrl(avatarId); },
  novalinkLiveFetchAvatar(avatarId) { requireDesktop(); return nova.novalinkLiveFetchAvatar(avatarId); },

  // calls
  novalinkLiveStartCall(payload) { requireDesktop(); return nova.novalinkLiveStartCall(payload); },
  novalinkLiveAcceptCall(callId) { requireDesktop(); return nova.novalinkLiveAcceptCall(callId); },
  novalinkLiveDeclineCall(callId) { requireDesktop(); return nova.novalinkLiveDeclineCall(callId); },
  novalinkLiveEndCall(payload) { requireDesktop(); return nova.novalinkLiveEndCall(payload); },
  novalinkLiveCancelCall(callId) { requireDesktop(); return nova.novalinkLiveCancelCall(callId); },
  novalinkLiveCurrentCall() { requireDesktop(); return nova.novalinkLiveCurrentCall(); },
  novalinkLiveCallHistory(payload) { requireDesktop(); return nova.novalinkLiveCallHistory(payload); },

  // realtime frames
  novalinkLiveSendPing(payload) { requireDesktop(); return nova.novalinkLiveSendPing(payload); },
  novalinkLiveSendPresence(payload) { requireDesktop(); return nova.novalinkLiveSendPresence(payload); },
  novalinkLiveSendTyping(payload) { requireDesktop(); return nova.novalinkLiveSendTyping(payload); },
  novalinkLiveSendMessageRead(payload) { requireDesktop(); return nova.novalinkLiveSendMessageRead(payload); },
  novalinkLiveSendCallSignal(payload) { requireDesktop(); return nova.novalinkLiveSendCallSignal(payload); },
  novalinkLiveNotify(payload) { requireDesktop(); return nova.novalinkLiveNotify(payload); },

  // main -> renderer subscriptions
  onNovaLinkLiveEvent(callback) {
    return nova?.onNovaLinkLiveEvent ? nova.onNovaLinkLiveEvent(callback) : () => {};
  },
  onNovaLinkLiveStatus(callback) {
    return nova?.onNovaLinkLiveStatus ? nova.onNovaLinkLiveStatus(callback) : () => {};
  },
  onNovaLinkLiveOpenConversation(callback) {
    return nova?.onNovaLinkLiveOpenConversation ? nova.onNovaLinkLiveOpenConversation(callback) : () => {};
  },
};
