# Changelog

All notable changes to NovaCode are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning uses [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-10-18

### Security
- **Workspace confinement for all file IPC**: every read/write/create/
  rename/delete/search target is validated against the opened folder
  (`pathGuard`); traversal, absolute escapes, and reserved names are
  refused. Previously any path on the machine could be targeted.
- Sender validation on all IPC handlers; closed, named-channel preload
  bridge (no generic invoke passthrough).
- Strict Content-Security-Policy delivered as a real response header via
  a custom `app://` protocol in packaged builds; dev-server CSP tightened.
- `sandbox: true` for the renderer; navigation guards; http(s)-only
  external links; single-instance lock.
- API keys stored with OS-level encryption (`safeStorage`); the renderer
  can never read them back; env-var alternative (`NOVACODE_OPENAI_API_KEY`).
- Structured logs with automatic secret redaction.

### Added
- AI assistant: streaming chat (OpenAI-compatible endpoints), explanation
  levels, active-file context attach, connection test, provider error
  mapping, run cancellation.
- Diff-review workflow for AI-proposed edits (accept/reject; nothing is
  written without explicit approval).
- Safe change history: accepted AI edits are journaled in the main process
  (`fs:apply-ai-edit` — the only path an AI edit can take to disk) with a
  Change History panel to restore any edit; restores are journaled too, so
  undo of the undo works. Journal lives in userData as JSONL with crash-safe
  appends, per-workspace filtering, and size-capped entries.
- Multi-file workspace search with regex/case options and jump-to-line.
- Streaming terminal: exit codes, stop/cancel (process-tree kill on
  Windows), command history, clear.
- Monaco bundled locally (offline-first; CDN dependency removed).
- Session restore of open tabs per workspace; optional autosave.
- Command palette (Ctrl+P) with fuzzy commands + quick file open.
- Status bar (cursor, language, AI state), resizable panels, toasts,
  modal dialogs replacing window.prompt/confirm.
- Settings persistence in userData with sanitized, whitelisted writes.
- Test suite (47 tests: path guard, fs service, SSE parsing, provider
  errors, settings sanitization, renderer flows), ESLint (incl.
  react-hooks), CI matrix (Windows/Ubuntu/macOS) and a tag-triggered
  Windows NSIS release job with checksums.
- Docs: ARCHITECTURE.md, SECURITY.md, ROADMAP.md, CONTRIBUTING.md.

### Changed
- Frontend decomposed from a single 620-line component into
  feature components with an App-level orchestrator.
- `npm run dist` now builds the renderer before packaging; added
  `dist:win`, `test`, `test:watch`, `lint` scripts.

## [0.1.0] — initial Phase 1 shell
- Electron + Vite + React + Monaco (CDN) desktop shell with folder
  explorer, basic tabs, blocking terminal run, localStorage settings.
