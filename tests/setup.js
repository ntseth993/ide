/**
 * Shared Vitest setup: jest-dom matchers, a mock of the preload bridge
 * (window.novaApi) available as globalThis.__mockNova, and Monaco stubs so
 * UI tests never load the real editor bundle.
 */
import { vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';

export const mockNova = {
  chooseDirectory: vi.fn(async () => null),
  validateWorkspace: vi.fn(async (root) => root),
  readDir: vi.fn(async () => []),
  readFile: vi.fn(async () => ''),
  writeFile: vi.fn(async () => ({ path: '' })),
  createFile: vi.fn(async () => ({ path: '' })),
  createFolder: vi.fn(async () => ({ path: '' })),
  renamePath: vi.fn(async () => ({ path: '' })),
  deletePath: vi.fn(async () => ({ ok: true })),
  searchWorkspace: vi.fn(async () => ({ results: [], searchedFiles: 0, truncated: false })),
  applyAiEdit: vi.fn(async () => ({ id: 'ch-test', ts: '2026-10-18T00:00:00.000Z', filePath: '' })),
  listHistory: vi.fn(async () => []),
  restoreHistory: vi.fn(async () => ({ filePath: '', content: null })),
  startTerminal: vi.fn(async () => ({ runId: 'term-test' })),
  cancelTerminal: vi.fn(async () => ({ ok: true })),
  runTerminalCapture: vi.fn(async () => ({ output: '', code: 0, signal: null })),
  terminalProfiles: vi.fn(async () => ({
    platform: 'win32',
    defaultId: 'powershell',
    profiles: [
      { id: 'powershell', label: 'PowerShell', default: true },
      { id: 'cmd', label: 'Command Prompt', default: false },
    ],
  })),
  onTerminalEvent: vi.fn(() => () => {}),
  onWorkspaceRequest: vi.fn(() => () => {}),
  onMenuCommand: vi.fn(() => () => {}),
  listExtensions: vi.fn(async () => ({ installed: [], available: [], exampleCatalog: true })),
  installExtension: vi.fn(async () => ({ ok: true })),
  updateExtension: vi.fn(async () => ({ ok: true, updated: false })),
  setExtensionEnabled: vi.fn(async () => ({ ok: true })),
  uninstallExtension: vi.fn(async () => ({ ok: true })),
  searchExtensions: vi.fn(async () => ({ results: [], total: 0 })),
  installMarketplace: vi.fn(async () => ({ ok: true })),
  detectRuntimes: vi.fn(async () => ({ runtimes: [], detectedAt: null })),
  // ---- Deploy workspace ------------------------------------------------------
  // These literals deliberately mirror the shapes produced by
  // electron/services/deploy/{deployService,deployController}.js. They are
  // written out instead of imported so a change to the real contract breaks a
  // UI test rather than silently passing.
  deployDetect: vi.fn(async () => ({
    kind: 'node', hasPackageJson: true, framework: 'vite', ssr: false,
    buildCommand: 'npm run build', devCommand: 'npm run dev', scripts: { build: 'vite build' },
    packageManager: 'npm', projectName: 'acme-site', outputDir: 'dist', outputExists: true,
    warnings: [], nodeModulesInstalled: true, dependencies: { vite: '^5.0.0' },
    providerConfig: { vercel: null, netlify: null, viteOutDir: null, nextStaticExport: false },
    backend: { detected: false, evidence: [] },
    deployMode: 'prebuilt', targetKind: 'static', deployable: true, blockers: [], frontendOnly: false,
  })),
  deployBuild: vi.fn(async () => ({ output: 'built', code: 0, signal: null })),
  deployExport: vi.fn(async () => ({ dest: '', files: 3, bytes: 1200, sourceDir: '' })),
  deployPreviewStatus: vi.fn(async () => ({ running: false, url: null, port: null })),
  deployPreviewStart: vi.fn(async () => ({ running: true, url: 'http://127.0.0.1:4173/', port: 4173 })),
  deployPreviewStop: vi.fn(async () => ({ running: false, url: null, port: null })),
  // ---- Hosting providers (Vercel / Netlify) ---------------------------------
  deployProviders: vi.fn(async () => ([
    {
      id: 'vercel', label: 'Vercel', available: true, requiresGit: false, reason: null,
      consoleHome: 'https://vercel.com/dashboard', tokenUrl: 'https://vercel.com/account/tokens',
      instructions: ['Create a token named “NovaCode” on your Vercel account tokens page.'],
      supports: { static: true, next: true, providerBuild: true, nodeServerless: true, envVars: true, customDomain: true, logs: true, cancel: true },
    },
    {
      id: 'netlify', label: 'Netlify', available: true, requiresGit: false, reason: null,
      consoleHome: 'https://app.netlify.com/user/sites', tokenUrl: 'https://app.netlify.com/user/applications',
      instructions: ['Create a personal access token in Netlify → Applications.'],
      supports: { static: true, next: false, providerBuild: false, nodeServerless: false, envVars: true, customDomain: true, logs: true, cancel: false, rollback: true },
    },
    {
      id: 'cloudflare', label: 'Cloudflare Pages', available: false, requiresGit: false,
      reason: 'Adapter slot reserved. Not implemented yet.', consoleHome: 'https://dash.cloudflare.com',
      tokenUrl: null, instructions: [], supports: {},
    },
  ])),
  deployConnections: vi.fn(async () => ([
    {
      id: 'vercel', label: 'Vercel', available: true, connected: true, hasToken: true, storage: 'os-encrypted',
      account: { id: 'usr_1', handle: 'ada', email: 'ada@example.com' },
      teams: [{ id: 'team_acme', name: 'Acme', slug: 'acme' }], verifiedAt: '2026-10-29T00:00:00.000Z', error: null,
    },
    {
      id: 'netlify', label: 'Netlify', available: true, connected: false, hasToken: false, storage: null,
      account: null, teams: [], verifiedAt: null, error: null,
    },
    {
      id: 'cloudflare', label: 'Cloudflare Pages', available: false, connected: false, hasToken: false, storage: null,
      account: null, teams: [], verifiedAt: null, error: null,
    },
  ])),
  deployConnect: vi.fn(async () => ({
    ok: true, provider: 'vercel', storage: 'os-encrypted',
    account: { id: 'usr_1', handle: 'ada' }, teams: [], verifiedAt: '2026-10-29T00:00:00.000Z',
  })),
  deployDisconnect: vi.fn(async () => ({ ok: true, provider: 'vercel' })),
  deployTeams: vi.fn(async () => ({ provider: 'vercel', account: { handle: 'ada' }, teams: [] })),
  deployProjects: vi.fn(async () => ([{ id: 'prj_1', name: 'acme-site', framework: 'vite', productionUrl: null }])),
  deployDeploys: vi.fn(async () => ([])),
  deployDomains: vi.fn(async () => ({ domains: [], instructions: ['Add a domain in the dashboard.'] })),
  deployProviderLogs: vi.fn(async () => ({ text: 'build log line', deploymentId: 'dpl_1', provider: 'vercel' })),
  deployPlan: vi.fn(async () => ({
    root: 'C:\\w', provider: 'vercel', providerLabel: 'Vercel', teamId: '', project: '',
    profile: {
      kind: 'node', framework: 'vite', projectName: 'acme-site', deployMode: 'prebuilt',
      buildCommand: 'npm run build', outputDir: 'dist', frontendOnly: false, blockers: [], warnings: [],
    },
    build: { buildCommand: 'npm run build', installCommand: null, outputDir: 'dist', framework: 'vite' },
    env: { required: [{ key: 'API_URL', source: 'src/api.js', buildTime: false }], missing: ['API_URL'], providerDefined: [], locallyDefined: [], warnings: [] },
    checks: [
      { id: 'project', label: 'vite detected', ok: true, detail: 'Project name: acme-site' },
      { id: 'account', label: 'Vercel account', ok: true, detail: 'Connected' },
      { id: 'git', label: 'No Git repository needed', ok: true, detail: 'Vercel accepts a direct file upload.' },
      { id: 'env', label: '1 environment variable(s) not set', ok: false, detail: 'Missing (names only): API_URL' },
    ],
    blockers: [], warnings: [],
    needs: { confirmProduction: false, confirmBuild: false, acknowledgeFrontendOnly: false, needsEnvValues: true },
    deployMode: 'prebuilt',
    supports: { providerBuild: true, cancel: true },
  })),
  deployStart: vi.fn(async () => ({
    runId: 'run_test', provider: 'vercel', phase: 'deploying', state: 'queued', target: 'production',
    message: 'Uploading.', publicUrl: null, deploymentId: null, dashboardUrl: null, log: [], final: false,
  })),
  deployRedeploy: vi.fn(async () => ({ runId: 'run_test', provider: 'vercel', state: 'queued', log: [], publicUrl: null })),
  deployStatus: vi.fn(async () => ({ runId: 'run_test', state: 'building', phase: 'deploying', publicUrl: null })),
  deployRuns: vi.fn(async () => ([])),
  deployRefresh: vi.fn(async () => ({ runId: 'run_test', state: 'ready', phase: 'live', publicUrl: 'https://acme.vercel.app' })),
  deployCancel: vi.fn(async () => ({ ok: true, providerCancelled: true, message: 'Cancelled.', run: { runId: 'run_test', state: 'canceled' } })),
  deployRunLogs: vi.fn(async () => ({ text: 'log', state: 'ready', phase: 'live' })),
  // Default is the silent path (no assistant configured); tests that want an
  // written answer override it.
  deployDiagnose: vi.fn(async () => ({
    runId: 'run_test', text: '', reason: 'no-key', hints: [],
    evidence: { text: '', facts: [], hintIds: [] },
  })),
  deployHistory: vi.fn(async () => ([{
    id: 'dep_1', provider: 'vercel', teamId: null, target: 'production', state: 'ready',
    publicUrl: 'https://acme.vercel.app', message: 'Live', fileCount: 12, totalBytes: 4096,
    createdAt: '2026-10-29T00:00:00.000Z',
  }])),
  deployHistoryClear: vi.fn(async () => ({ ok: true, removed: 1 })),
  deployPreferences: vi.fn(async () => ({ provider: 'vercel', teams: { vercel: '' } })),
  deploySetPreferences: vi.fn(async () => ({ ok: true, provider: 'vercel', teamId: '' })),
  onDeployEvent: vi.fn(() => () => {}),
  // NovaLink Live — mocked preload surface for the web-mode component tests.
  // Names mirror electron/preload.js so a stale test that reaches for the old
  // LAN `novalink*` methods fails loudly instead of returning `undefined` and
  // letting a component crash mid-render.
  novalinkLiveStatus: vi.fn(async () => ({
    configured: true,
    baseUrl: 'https://link.example.test',
    signedIn: false,
    connected: false,
    ready: false,
    user: null,
    privacy: null,
    server: { rtc: { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }], turnConfigured: false }, limits: { maxMessageChars: 8000, maxFileBytes: 25 * 1024 * 1024 }, sessions: [] },
    reconnectAttempt: 0,
    lastError: null,
    lastErrorAt: null,
  })),
  novalinkLiveBoot: vi.fn(async () => ({ ok: true })),
  novalinkLiveConfigure: vi.fn(async () => ({ ok: true })),
  novalinkLiveReconnect: vi.fn(async () => ({ ok: true })),
  novalinkLiveRegister: vi.fn(async () => ({ user: { username: 'tester' }, sessions: [] })),
  novalinkLiveLogin: vi.fn(async () => ({ user: { username: 'tester' }, sessions: [] })),
  novalinkLiveLogout: vi.fn(async () => ({ ok: true })),
  novalinkLiveMe: vi.fn(async () => ({ user: { username: 'tester' } })),
  novalinkLiveBootstrap: vi.fn(async () => ({ user: { username: 'tester' }, contacts: [], conversations: [], requests: { incoming: [], outgoing: [] }, unread: 0 })),
  novalinkLiveUpdateProfile: vi.fn(async () => ({ user: { displayName: 'Tester' } })),
  novalinkLiveUploadAvatar: vi.fn(async () => ({ user: { avatarId: 'a'.repeat(8) + '-0000-0000-0000-000000000000' } })),
  novalinkLiveDeleteAvatar: vi.fn(async () => ({ ok: true })),
  novalinkLiveChangePassword: vi.fn(async () => ({ ok: true, sessions: [] })),
  novalinkLiveUpdatePrivacy: vi.fn(async () => ({ privacy: {} })),
  novalinkLiveSearchUsers: vi.fn(async () => ({ users: [] })),
  novalinkLiveGetUser: vi.fn(async (userId) => ({ user: { id: userId } })),
  novalinkLiveListContacts: vi.fn(async () => ({ contacts: [] })),
  novalinkLiveListRequests: vi.fn(async () => ({ incoming: [], outgoing: [] })),
  novalinkLiveRequestConnection: vi.fn(async () => ({ request: { id: 'r'.repeat(8) + '-0000-0000-0000-000000000000' } })),
  novalinkLiveAcceptRequest: vi.fn(async (requestId) => ({ ok: true, requestId })),
  novalinkLiveRejectRequest: vi.fn(async (requestId) => ({ ok: true, requestId })),
  novalinkLiveRemoveContact: vi.fn(async (userId) => ({ ok: true, userId })),
  novalinkLiveListBlocked: vi.fn(async () => ({ blocked: [] })),
  novalinkLiveBlockUser: vi.fn(async (userId) => ({ ok: true, userId })),
  novalinkLiveUnblockUser: vi.fn(async (userId) => ({ ok: true, userId })),
  novalinkLiveReportUser: vi.fn(async () => ({ ok: true })),
  novalinkLiveListConversations: vi.fn(async () => ({ conversations: [] })),
  novalinkLiveCreateConversation: vi.fn(async () => ({ conversation: { id: 'c'.repeat(8) + '-0000-0000-0000-000000000000' } })),
  novalinkLiveGetConversation: vi.fn(async (conversationId) => ({ conversation: { id: conversationId } })),
  novalinkLiveListMessages: vi.fn(async () => ({ messages: [] })),
  novalinkLiveSendMessage: vi.fn(async () => ({ message: { id: 'm'.repeat(8) + '-0000-0000-0000-000000000000' } })),
  novalinkLiveMarkRead: vi.fn(async () => ({ ok: true })),
  novalinkLiveListAttachments: vi.fn(async (conversationId) => ({ attachments: [], conversationId })),
  novalinkLiveSearchMessages: vi.fn(async () => ({ results: [] })),
  novalinkLiveAddReaction: vi.fn(async () => ({ ok: true })),
  novalinkLiveRemoveReaction: vi.fn(async () => ({ ok: true })),
  novalinkLiveUploadFile: vi.fn(async () => ({ file: { id: 'f'.repeat(8) + '-0000-0000-0000-000000000000' } })),
  novalinkLiveDownloadFile: vi.fn(async (fileId) => ({ bytes: new Uint8Array(0), mimeType: 'application/octet-stream', fileId })),
  novalinkLiveDeleteFile: vi.fn(async (fileId) => ({ ok: true, fileId })),
  novalinkLiveAvatarUrl: vi.fn(async (avatarId) => ({ url: `https://link.example.test/api/avatars/${avatarId}` })),
  novalinkLiveFetchAvatar: vi.fn(async (avatarId) => ({ bytes: new Uint8Array(0), mimeType: 'image/png', avatarId })),
  novalinkLiveStartCall: vi.fn(async () => ({ call: { id: 'd'.repeat(8) + '-0000-0000-0000-000000000000' }, ringing: [], relayWarning: null })),
  novalinkLiveAcceptCall: vi.fn(async (callId) => ({ ok: true, callId })),
  novalinkLiveDeclineCall: vi.fn(async (callId) => ({ ok: true, callId })),
  novalinkLiveEndCall: vi.fn(async (payload) => ({ ok: true, ...payload })),
  novalinkLiveCancelCall: vi.fn(async (callId) => ({ ok: true, callId })),
  novalinkLiveCurrentCall: vi.fn(async () => ({ call: null })),
  novalinkLiveCallHistory: vi.fn(async () => ({ calls: [] })),
  novalinkLiveSendPing: vi.fn(async () => ({ ok: true })),
  novalinkLiveSendPresence: vi.fn(async (payload) => ({ ok: true, ...payload })),
  novalinkLiveSendTyping: vi.fn(async (payload) => ({ ok: true, ...payload })),
  novalinkLiveSendMessageRead: vi.fn(async (payload) => ({ ok: true, ...payload })),
  novalinkLiveSendCallSignal: vi.fn(async (payload) => ({ ok: true, ...payload })),
  novalinkLiveNotify: vi.fn(async (payload) => ({ ok: true, ...payload })),
  // Classroom monitor (see link-server/adminHub.js + electron/services/classroom).
  // The badge component and Settings section read status on mount; default to
  // `enrolled: false` so unrelated App tests render without the badge.
  novalinkLiveClassroomStatus: vi.fn(async () => ({ enrolled: false, status: null })),
  novalinkLiveClassroomEnroll: vi.fn(async (payload) => ({ ok: true, enrollment: { enrollmentId: 'e'.repeat(8) + '-0000-0000-0000-000000000000', ...payload } })),
  novalinkLiveClassroomUnenroll: vi.fn(async () => ({ ok: true })),
  novalinkLiveClassroomReport: vi.fn(async (payload) => ({ ok: true, ...payload })),
  onNovaLinkLiveEvent: vi.fn(() => () => {}),
  onNovaLinkLiveStatus: vi.fn(() => () => {}),
  onNovaLinkLiveOpenConversation: vi.fn(() => () => {}),
  getSettings: vi.fn(async () => null),
  saveSettings: vi.fn(async (patch) => patch),
  setApiKey: vi.fn(async () => ({ storage: 'os-encrypted' })),
  clearApiKey: vi.fn(async () => ({ ok: true })),
  apiKeyStatus: vi.fn(async () => ({ hasKey: false, source: null })),
  listAiProviders: vi.fn(async () => ([
    { id: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', models: ['gpt-4o-mini'], requiresKey: true },
    { id: 'ollama', label: 'Ollama (local)', kind: 'ollama', baseUrl: 'http://localhost:11434', defaultModel: 'llama3.1', models: [], requiresKey: false },
  ])),
  checkAiConnection: vi.fn(async () => ({ ok: true, models: ['gpt-test'] })),
  startChat: vi.fn(async () => ({ runId: 'ai-test' })),
  aiComplete: vi.fn(async () => ({ text: '', reason: 'unavailable' })),
  setWindowAppearance: vi.fn(async () => ({ ok: true })),
  cancelChat: vi.fn(async () => ({ ok: true })),
  onAiEvent: vi.fn(() => () => {}),
  signIn: vi.fn(async (email) => ({ email, name: email, token: 'nova_test', plan: 'Starter', tokensQuota: 1_000_000_000, tokensUsed: 0, tokensRemaining: 1_000_000_000 })),
  getAccount: vi.fn(async () => null),
  signOut: vi.fn(async () => ({ ok: true })),
  beginLogin: vi.fn(async () => ({ ok: true, url: 'http://127.0.0.1:54321/signin?state=test' })),
  cancelLogin: vi.fn(async () => ({ ok: true })),
  onAuthSession: vi.fn(() => () => {}),
  oauthStatus: vi.fn(async () => ([
    { id: 'google', label: 'Google', requiresSecret: false, hasClientId: false, hasSecret: false, fromEnv: false, live: false },
    { id: 'github', label: 'GitHub', requiresSecret: true, hasClientId: false, hasSecret: false, fromEnv: false, live: false },
    { id: 'microsoft', label: 'Microsoft', requiresSecret: false, hasClientId: false, hasSecret: false, fromEnv: false, live: false },
  ])),
  setOauthConfig: vi.fn(async () => ({ ok: true })),
  openExternal: vi.fn(async () => undefined),
  appInfo: vi.fn(async () => ({
    version: 'test',
    platform: 'win32',
    electron: 'test',
    node: 'test',
    chrome: 'test',
  })),
};

globalThis.__mockNova = mockNova;

if (typeof window !== 'undefined') {
  window.novaApi = mockNova;
}

vi.mock('@monaco-editor/react', () => {
  const editorStub = (props) =>
    React.createElement('div', {
      'data-testid': 'monaco-stub',
      'data-language': props.language || '',
      'data-value': props.value || '',
    });
  const diffStub = (props) =>
    React.createElement('div', {
      'data-testid': 'monaco-diff-stub',
      'data-original': props.original || '',
      'data-modified': props.modified || '',
    });
  return {
    default: editorStub,
    Editor: editorStub,
    DiffEditor: diffStub,
    loader: { config: vi.fn() },
  };
});
