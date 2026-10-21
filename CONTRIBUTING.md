# Contributing to NovaCode

Thanks for helping build NovaCode. This project favors a small amount of
**real, tested functionality** over many half-working features.

## Ground rules

1. **JavaScript only** (no TypeScript) — matches the project spec.
2. **Inspect before editing.** Read the module you are changing and its
   tests first.
3. **Preserve working behavior.** The IPC contract in
   `electron/ipc/registerIpc.js` + `electron/preload.js` is closed; new
   capabilities get new named channels with validation and sender checks.
4. **Security invariants are non-negotiable:**
   - every filesystem/terminal target passes `pathGuard`;
   - renderer never receives secrets;
   - no new `webPreferences` loosening, no remote content.
5. **Test what you ship.** Backend services get unit tests (they are
   Electron-free by design); UI behavior gets RTL tests in `tests/`.
6. **Run before you push:**
   ```bash
   npm test
   npm run lint
   npm run build
   ```

## Project layout

```
electron/          main process: main.js, preload.js, ipc/, services/
src/               React renderer: App.jsx, components/, hooks/, utils/
tests/             Vitest + RTL suites (mocked novaApi bridge)
.github/workflows  CI (lint/test/build matrix, tag → installer)
```

## Conventions

- CommonJS in `electron/` (Node runtime), ESM in `src/` (Vite runtime).
- Pure logic lives in dependency-free modules where practical so it can
  be unit tested without Electron.
- User-facing errors: short, actionable sentences. No stack traces in UI.
- Comments explain *why*, not *what*.
- Commit style: `area: summary` (e.g. `terminal: cancel running command on app quit`).

## Adding a feature — checklist

1. Design the IPC/UI contract first; write it into ARCHITECTURE.md if new.
2. Implement the main-process side with validation.
3. Extend `preload.js` and `src/services/novaClient.js` together.
4. Add the UI component; keep it presentational where possible.
5. Add tests for both sides; update ROADMAP.md status honestly.

## Reporting bugs

Include: OS/version, steps to reproduce, expected vs actual behavior, and
the relevant lines from `userData/logs/` (secrets are redacted, but
double-check before pasting).
