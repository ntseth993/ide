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
  openFile: () => invoke('dialog:open-file'),
  validateWorkspace: (root) => invoke('workspace:validate', root),
  // multi-window: open/close a window, quit the app
  newWindow: () => invoke('window:new'),
  closeWindow: () => invoke('window:close'),
  quitApp: () => invoke('app:quit'),
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
  runTerminalCapture: (payload) => invoke('terminal:run-capture', payload),
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

  // NovaDB — the IDE's own database engine (Database workspace + `novadb` cmd).
  novaDbStatus: () => invoke('db:status'),
  novaDbExec: (sql, params) => invoke('db:execute', { sql, params }),
  // NovaDB external connector (loopback TCP server for separate programs).
  novaDbConnectorStatus: () => invoke('db:connectorStatus'),
  novaDbConnectorConfigure: (patch) => invoke('db:connectorConfigure', patch),

  // Deploy — build / preview / export the opened project (all workspace-confined).
  deployDetect: (root) => invoke('deploy:detect', root),
  deployBuild: (payload) => invoke('deploy:build', payload),
  deployExport: (payload) => invoke('deploy:export', payload),
  deployPreviewStatus: () => invoke('deploy:previewStatus'),
  deployPreviewStart: (payload) => invoke('deploy:previewStart', payload),
  deployPreviewStop: () => invoke('deploy:previewStop'),

  // Hosting providers (Vercel / Netlify). These channels are the renderer's only
  // route to a real publish: an access token is written once through
  // deployConnect and is never read back — every response carries account info,
  // statuses and URLs, never the credential itself.
  deployProviders: () => invoke('deploy:providers'),
  deployConnections: () => invoke('deploy:connections'),
  deployConnect: (payload) => invoke('deploy:connect', payload),
  deployDisconnect: (payload) => invoke('deploy:disconnect', payload),
  deployTeams: (payload) => invoke('deploy:teams', payload),
  deployProjects: (payload) => invoke('deploy:projects', payload),
  deployDeploys: (payload) => invoke('deploy:deploys', payload),
  deployDomains: (payload) => invoke('deploy:domains', payload),
  deployProviderLogs: (payload) => invoke('deploy:providerLogs', payload),
  deployPlan: (payload) => invoke('deploy:plan', payload),
  deployStart: (payload) => invoke('deploy:start', payload),
  deployRedeploy: (payload) => invoke('deploy:redeploy', payload),
  deployStatus: (payload) => invoke('deploy:status', payload),
  deployRuns: () => invoke('deploy:runs'),
  deployRefresh: (payload) => invoke('deploy:refresh', payload),
  deployCancel: (payload) => invoke('deploy:cancel', payload),
  deployRunLogs: (payload) => invoke('deploy:runLogs', payload),
  // Ask for a written explanation of a failed run. Explicit click only, and the
  // answer is built from evidence the main process has already stripped of secrets.
  deployDiagnose: (payload) => invoke('deploy:diagnose', payload),
  deployHistory: (payload) => invoke('deploy:history', payload),
  deployHistoryClear: (payload) => invoke('deploy:historyClear', payload),
  deployPreferences: () => invoke('deploy:preferences'),
  deploySetPreferences: (payload) => invoke('deploy:setPreferences', payload),
  // main -> renderer: progress of a running deployment (phase/state/log lines).
  onDeployEvent: (callback) => subscribe('deploy:event', callback),

  // NovaLink Live — internet-connected team collaboration.
  //
  // Each method is bound to exactly one validated IPC channel in the main
  // process. The session bearer token never crosses back to the renderer, and
  // every server frame arrives on one subscription channel (`novalinkLive:event`)
  // so the renderer never has to poll. Names mirror the main-process service
  // 1:1 for auditability.
  novalinkLiveStatus: () => invoke('novalinkLive:status'),
  novalinkLiveBoot: (payload) => invoke('novalinkLive:boot', payload || {}),
  novalinkLiveConfigure: (payload) => invoke('novalinkLive:configure', payload || {}),
  novalinkLiveReconnect: () => invoke('novalinkLive:reconnect'),

  // auth & profile
  novalinkLiveRegister: (payload) => invoke('novalinkLive:register', payload || {}),
  novalinkLiveLogin: (payload) => invoke('novalinkLive:login', payload || {}),
  novalinkLiveLogout: () => invoke('novalinkLive:logout'),
  novalinkLiveMe: () => invoke('novalinkLive:me'),
  novalinkLiveBootstrap: () => invoke('novalinkLive:bootstrap'),
  novalinkLiveUpdateProfile: (payload) => invoke('novalinkLive:updateProfile', payload || {}),
  novalinkLiveUploadAvatar: (payload) => invoke('novalinkLive:uploadAvatar', payload || {}),
  novalinkLiveDeleteAvatar: () => invoke('novalinkLive:deleteAvatar'),
  novalinkLiveChangePassword: (payload) => invoke('novalinkLive:changePassword', payload || {}),
  novalinkLiveUpdatePrivacy: (payload) => invoke('novalinkLive:updatePrivacy', payload || {}),

  // directory & connections
  novalinkLiveSearchUsers: (payload) => invoke('novalinkLive:searchUsers', payload || {}),
  novalinkLiveGetUser: (userId) => invoke('novalinkLive:getUser', { userId }),
  novalinkLiveListContacts: () => invoke('novalinkLive:listContacts'),
  novalinkLiveListRequests: () => invoke('novalinkLive:listRequests'),
  novalinkLiveRequestConnection: (payload) => invoke('novalinkLive:requestConnection', payload || {}),
  novalinkLiveAcceptRequest: (requestId) => invoke('novalinkLive:acceptRequest', { requestId }),
  novalinkLiveRejectRequest: (requestId) => invoke('novalinkLive:rejectRequest', { requestId }),
  novalinkLiveRemoveContact: (userId) => invoke('novalinkLive:removeContact', { userId }),
  novalinkLiveListBlocked: () => invoke('novalinkLive:listBlocked'),
  novalinkLiveBlockUser: (userId) => invoke('novalinkLive:blockUser', { userId }),
  novalinkLiveUnblockUser: (userId) => invoke('novalinkLive:unblockUser', { userId }),
  novalinkLiveReportUser: (payload) => invoke('novalinkLive:reportUser', payload || {}),

  // conversations & messages
  novalinkLiveListConversations: () => invoke('novalinkLive:listConversations'),
  novalinkLiveCreateConversation: (payload) => invoke('novalinkLive:createConversation', payload || {}),
  novalinkLiveGetConversation: (conversationId) => invoke('novalinkLive:getConversation', { conversationId }),
  novalinkLiveListMessages: (payload) => invoke('novalinkLive:listMessages', payload || {}),
  novalinkLiveSendMessage: (payload) => invoke('novalinkLive:sendMessage', payload || {}),
  novalinkLiveMarkRead: (payload) => invoke('novalinkLive:markRead', payload || {}),
  novalinkLiveListAttachments: (conversationId) => invoke('novalinkLive:listAttachments', { conversationId }),
  novalinkLiveSearchMessages: (payload) => invoke('novalinkLive:searchMessages', payload || {}),
  novalinkLiveAddReaction: (payload) => invoke('novalinkLive:addReaction', payload || {}),
  novalinkLiveRemoveReaction: (payload) => invoke('novalinkLive:removeReaction', payload || {}),

  // files & avatars
  novalinkLiveUploadFile: (payload) => invoke('novalinkLive:uploadFile', payload || {}),
  novalinkLiveDownloadFile: (fileId) => invoke('novalinkLive:downloadFile', { fileId }),
  novalinkLiveDeleteFile: (fileId) => invoke('novalinkLive:deleteFile', { fileId }),
  novalinkLiveAvatarUrl: (avatarId) => invoke('novalinkLive:avatarUrl', { avatarId }),
  novalinkLiveFetchAvatar: (avatarId) => invoke('novalinkLive:fetchAvatar', { avatarId }),

  // calls
  novalinkLiveStartCall: (payload) => invoke('novalinkLive:startCall', payload || {}),
  novalinkLiveAcceptCall: (callId) => invoke('novalinkLive:acceptCall', { callId }),
  novalinkLiveDeclineCall: (callId) => invoke('novalinkLive:declineCall', { callId }),
  novalinkLiveEndCall: (payload) => invoke('novalinkLive:endCall', payload || {}),
  novalinkLiveCancelCall: (callId) => invoke('novalinkLive:cancelCall', { callId }),
  novalinkLiveCurrentCall: () => invoke('novalinkLive:currentCall'),
  novalinkLiveCallHistory: (payload) => invoke('novalinkLive:callHistory', payload || {}),

  // realtime frames — the closed set the server accepts on the socket.
  novalinkLiveSendPing: (payload) => invoke('novalinkLive:sendPing', payload || {}),
  novalinkLiveSendPresence: (payload) => invoke('novalinkLive:sendPresence', payload || {}),
  novalinkLiveSendTyping: (payload) => invoke('novalinkLive:sendTyping', payload || {}),
  novalinkLiveSendMessageRead: (payload) => invoke('novalinkLive:sendMessageRead', payload || {}),
  novalinkLiveSendCallSignal: (payload) => invoke('novalinkLive:sendCallSignal', payload || {}),
  novalinkLiveNotify: (payload) => invoke('novalinkLive:notify', payload || {}),

  // main -> renderer: every server-pushed frame in one stream.
  onNovaLinkLiveEvent: (callback) => subscribe('novalinkLive:event', callback),
  // main -> renderer: signed snapshot of the connection state (used by StatusBar).
  onNovaLinkLiveStatus: (callback) => subscribe('novalinkLive:status-event', callback),
  // main -> renderer: fired when the user clicks a native notification bubble.
  onNovaLinkLiveOpenConversation: (callback) => subscribe('novalinkLive:open-conversation', callback),
};

contextBridge.exposeInMainWorld('novaApi', api);
