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
  novalinkStatus: vi.fn(async () => ({
    ready: true, scanning: false, activeTransport: 'lan',
    identity: { peerId: 'me', fingerprint: 'AAAA-BBBB-CCCC-DDDD', name: 'NovaCode @ test' },
    transports: [
      { id: 'lan', label: 'Local network (Wi-Fi / Ethernet)', kind: 'lan', available: true, supported: true, detail: 'TCP :1234 · UDP :41777' },
      { id: 'bluetooth', label: 'Bluetooth', kind: 'bluetooth', available: false, supported: false, power: 'off', reason: 'not supported', adapters: [{ kind: 'bluetooth', label: 'Bluetooth radio', state: 'disabled', detail: 'Off' }] },
    ],
    nearby: [], requests: { incoming: [], outgoing: [] }, peers: [], chats: {}, transfers: [], bluetooth: null,
  })),
  novalinkDiscover: vi.fn(async () => ({ ok: true })),
  novalinkStopDiscovery: vi.fn(async () => ({ ok: true })),
  novalinkEnableBluetooth: vi.fn(async () => ({ ok: true, detail: 'Bluetooth enabled.' })),
  novalinkScanBluetooth: vi.fn(async () => ({ ok: true, power: 'on', devices: [], scannedAt: Date.now() })),
  novalinkConnect: vi.fn(async () => ({ ok: true })),
  novalinkAcceptConnection: vi.fn(async () => ({ ok: true })),
  novalinkRejectConnection: vi.fn(async () => ({ ok: true })),
  novalinkDisconnect: vi.fn(async () => ({ ok: true })),
  novalinkSendMessage: vi.fn(async () => ({ ok: true, id: 'msg-1' })),
  novalinkShareCode: vi.fn(async () => ({ ok: true, id: 'code-1' })),
  novalinkShareFile: vi.fn(async () => ({ ok: true, transferId: 't-1' })),
  novalinkAcceptTransfer: vi.fn(async () => ({ ok: true })),
  novalinkRejectTransfer: vi.fn(async () => ({ ok: true })),
  novalinkCancelTransfer: vi.fn(async () => ({ ok: true })),
  novalinkSaveTransfer: vi.fn(async () => ({ ok: true, path: 'C:\\w\\NovaLink\\file.txt' })),
  onNovaLinkEvent: vi.fn(() => () => {}),
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
