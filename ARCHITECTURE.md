# NovaCode Architecture

## Overview

NovaCode is an Electron desktop application with three strict runtime boundaries:

```
┌────────────────────────────────────────────────────────────┐
│  Main process (Node.js, privileged)                        │
│  electron/main.js            lifecycle, window, CSP        │
│  electron/ipc/registerIpc.js explicit IPC contract         │
│  electron/services/                                        │
│    ├ pathGuard.js    pure path validation                  │
│    ├ fsService.js    workspace-confined filesystem ops     │
│    ├ terminalService.js  streaming command execution       │
│    ├ settingsService.js  validated settings persistence    │
│    ├ secretStore.js    OS-encrypted API key storage        │
│    └ aiService.js + ai/openaiProvider.js  streaming chat   │
└──────────────┬─────────────────────────────────────────────┘
               │ ipcRenderer.invoke / webContents.send
               │ (named channels only, sender-verified)
┌──────────────▼─────────────────────────────────────────────┐
│  Preload bridge (sandboxed)                                │
│  electron/preload.js — exposes `window.novaApi`, a closed  │
│  set of named methods; no generic invoke passthrough       │
└──────────────┬─────────────────────────────────────────────┘
               │ contextBridge
┌──────────────▼─────────────────────────────────────────────┐
│  Renderer (React 18 + Vite, sandboxed, no Node)            │
│  src/App.jsx              state orchestration              │
│  src/components/          ActivityBar, Explorer, Search,   │
│                           EditorArea, Terminal, AIPanel,   │
│                           Settings, StatusBar, Palette,    │
│                           Dialogs, DiffReview, Toasts      │
│  src/services/novaClient.js  bridge client + error wrap    │
│  src/hooks/useSettings.js    settings state                │
│  src/utils/                  language + path helpers       │
│  src/monacoSetup.js          bundled Monaco (offline)      │
└────────────────────────────────────────────────────────────┘
```

## Production loading

The packaged app is served from `app://novacode/index.html`. A custom
`protocol.handle('app')` streams files out of `dist/` and attaches the
Content-Security-Policy as a real response header (plain `file://`
responses cannot carry headers). Vite builds with `base: './'` so asset
URLs are relative and protocol-agnostic. In dev the renderer loads from
the Vite server (`http://localhost:5173`, strict port) and CSP is added
via `onHeadersReceived` (with `unsafe-inline` scripts allowed only there
for HMR).

## Security model

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`
- Every privileged handler verifies `event.sender === win.webContents`
- Every filesystem/terminal target passes `pathGuard.resolveWithin(root, …)`:
  paths are resolved and proven to stay inside the opened workspace
- User-supplied names (`new file`, rename) pass `assertPlainName`
  (separators, traversal, control chars, Windows reserved names)
- The workspace root itself cannot be renamed or deleted
- Secrets: API keys are encrypted with `safeStorage` (DPAPI/Keychain/
  libsecret) inside userData; the renderer can set/clear/check a key but
  never reads it back. AI network calls happen only in the main process
- Outbound `shell.openExternal` allows only `http(s)`; in-window
  navigation away from our own origins is blocked
- Structured JSON logs in `userData/logs/` with secret redaction

## IPC contract (closed set)

| Channel | Direction | Purpose |
| --- | --- | --- |
| `dialog:choose-directory` | invoke | native folder picker |
| `workspace:validate` | invoke | verify a folder exists |
| `fs:read-dir` `fs:read-file` `fs:write-file` `fs:create-file` `fs:create-folder` `fs:rename` `fs:delete` `fs:search` | invoke | workspace-confined file operations |
| `terminal:start` `terminal:cancel` | invoke | run/cancel commands |
| `terminal:event` | event | `{ runId, type: stdout\|stderr\|error\|exit, data }` |
| `settings:get` `settings:set` | invoke | validated settings persistence |
| `ai:set-key` `ai:clear-key` `ai:key-status` | invoke | key lifecycle (write-only) |
| `ai:chat` `ai:cancel` | invoke | streaming chat runs |
| `ai:check-connection` | invoke | provider connectivity test |
| `ai:event` | event | `{ runId, type: start\|delta\|error\|done, data }` |
| `shell:open-external` | invoke | http(s) links only |
| `app:info` | invoke | versions/platform |

## AI provider layer

`aiService` resolves the API key (secret store → `NOVACODE_OPENAI_API_KEY`),
sanitizes messages (role whitelist, size caps), assigns a run id, and
streams via `openaiProvider.streamChat` (fetch + SSE parser). Providers
speak the OpenAI chat-completions protocol, so any compatible endpoint
(including local runtimes) works by changing the base URL. HTTP failures
are mapped to actionable messages (401/403/404/429/5xx). Run cancellation
uses `AbortController`.

## Editor

Monaco is bundled from npm (no CDN) with Vite `?worker` imports, so
syntax highlighting and IntelliSense workers work offline. Custom themes
`novacode-dark` / `novacode-light` are registered in `src/monacoSetup.js`.

## Testing

`tests/` covers the security-critical core without launching Electron:
path guard, fs service (against real temp directories), SSE parser,
provider error mapping, settings sanitization, language/path utils, and
renderer behavior via React Testing Library with a mocked `novaApi`
bridge. Run with `npm test`.
