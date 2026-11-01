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
- Hosting tokens (`hosting-vercel-token`, `hosting-netlify-token`) use the
  same encrypted store and the same one-way rule: they are read inside the
  main process immediately before a provider call and never cross IPC
- Project scripts run for a deployment (`npm run build`) inherit the
  environment with the hosting tokens stripped, so the code being published
  cannot read the credential that publishes it
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
| `deploy:detect` `deploy:build` `deploy:export` `deploy:preview-*` | invoke | local build and preview of the opened folder |
| `deploy:providers` `deploy:connections` `deploy:connect` `deploy:disconnect` `deploy:teams` `deploy:projects` `deploy:deploys` `deploy:domains` `deploy:providerLogs` | invoke | hosting account and project reads (no credential ever returned) |
| `deploy:plan` `deploy:start` `deploy:redeploy` `deploy:status` `deploy:runs` `deploy:refresh` `deploy:cancel` `deploy:runLogs` `deploy:diagnose` `deploy:history` `deploy:historyClear` `deploy:preferences` `deploy:setPreferences` | invoke | the publish pipeline and its history |
| `deploy:event` | event | `{ runId, type: start\|phase\|state\|progress\|log, … }` |

## AI provider layer

`aiService` resolves the API key (secret store → `NOVACODE_OPENAI_API_KEY`),
sanitizes messages (role whitelist, size caps), assigns a run id, and
streams via `openaiProvider.streamChat` (fetch + SSE parser). Providers
speak the OpenAI chat-completions protocol, so any compatible endpoint
(including local runtimes) works by changing the base URL. HTTP failures
are mapped to actionable messages (401/403/404/429/5xx). Run cancellation
uses `AbortController`.

## Deployment

Publishing is split so the renderer never holds a credential or decides
what is true:

- `services/deploy/providers/` — one adapter per host (`verify`,
  `listProjects`, `listEnvKeys`, `setEnvVars`, `startDeploy`, `status`,
  `cancel`, `listDeploys`, `logs`, `domains`), talking to the official REST
  APIs. `supports.providerBuild` is the dividing line between a host that
  builds for you (Vercel) and one that expects an upload (Netlify). Cloudflare
  Pages, Render and Railway are declared descriptors with no adapter, and the
  controller refuses to build one rather than pretending.
- `services/deploy/sourceFiles.js` — collects the bundle without Git,
  honouring `.gitignore` and the provider's ignore files, excluding keys and
  databases by rule, and digesting files with SHA1 so a host can skip what it
  already has. Hard budgets cap file count, file size and total size.
- `services/deploy/deployService.js` `detect()` — classifies the project
  (static, Vite/React, Next.js, other Node, desktop app, unsupported) and
  reports whether a backend exists, because a frontend-only upload is not a
  full deployment.
- `services/deploy/deployController.js` — the pipeline the panel drives:
  `validating → configuring → building → packing → uploading → deploying →
  live`, with confirmation gates before a production publish, before running
  the project's own build command, and before shipping only the frontend. A
  URL is attached to a run only when the provider reports it live.
- `services/deploy/deployDiagnostics.js` — turns a failed run into a written
  explanation. It assembles the run, its own log tail and the host's build
  log, masks every credential shape (plus the stored token, handed in as a
  never-send literal), and asks the assistant already configured for the AI
  panel. If that assistant cannot answer, the same evidence is matched
  against built-in failure causes and the panel labels which route was used.
  It never states anything about the host's state — that stays the
  controller's job.

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
