# NovaCode IDE

NovaCode is a professional, AI-powered, cross-platform **desktop** IDE built with Electron, React, Vite, and Monaco. It is fully usable offline — editing, multi-file search, project management, and an integrated terminal — and connects to OpenAI-compatible AI providers securely when you add your own API key.

## Feature status

### Implemented and tested
- Secure Electron shell: context isolation, sandboxed renderer, strict Content-Security-Policy, single-instance lock, navigation guards
- Workspace-confined file operations (every IPC target is validated against the opened folder; traversal is refused)
- File explorer: create/rename/delete files and folders, expand/collapse, type badges
- Monaco editor bundled **locally** (works fully offline), multiple tabs, dirty indicators, breadcrumbs, Ctrl+S save, unsaved-close confirmation, optional autosave
- Session restore: open tabs and active file are restored per workspace
- Multi-file workspace search (plain text or regex, case toggle, result jump-to-line)
- Integrated terminal: streaming output, exit codes, command history (↑/↓), stop/cancel, clear
- AI assistant: streaming chat via the OpenAI-compatible chat-completions API, explanation levels (beginner/intermediate/advanced), optional active-file context, AI error surfacing (401/429/network)
- AI-proposed edits go through a **diff review** overlay — nothing is written until you accept
- API key storage with OS-level encryption (Windows DPAPI / macOS Keychain / Linux libsecret) or `NOVACODE_OPENAI_API_KEY` env var for development; the key never reaches the renderer
- Command palette (Ctrl+P): fuzzy commands + quick file open
- Settings: dark / light / high-contrast themes, accent color, font size, tab size, word wrap, minimap, autosave, AI provider (base URL, model, temperature)
- Status bar with cursor position, language, and AI connection state
- Resizable panels (sidebar width, terminal height, AI panel width)
- 47 automated tests (Vitest + React Testing Library), ESLint, production build

### Partially implemented
- Terminal: single stream with history (multi-tab terminals planned)
- AI chat: single-conversation thread per session (persisted threads and project-agent actions planned)

### Planned (see ROADMAP.md)
- Git integration, language services/diagnostics, project understanding map, visual API studio, database explorer, plugin architecture, macOS/Linux signed builds, official website

## Getting started (beginner-friendly)

Requirements: [Node.js](https://nodejs.org) 20 or newer.

```bash
# 1. Install dependencies (once)
npm install

# 2. Start NovaCode in development mode
npm run dev
```

The Vite dev server starts on `http://localhost:5173` and the Electron window opens automatically.

### Using the AI assistant
1. Get an API key from your OpenAI-compatible provider (or point the base URL at a local runtime such as LM Studio/Ollama's OpenAI endpoint).
2. In the AI panel, paste the key and press **Save** — it is encrypted with your OS credential store and never enters the source code or the renderer.
3. Chat away. Use the level selector for beginner/intermediate/advanced explanations, and "Review latest answer as an edit" to diff-review proposed changes before applying.
4. For development you can instead set the environment variable `NOVACODE_OPENAI_API_KEY` (documented, never committed).

> Running project code in the terminal executes it **on your machine with your permissions**. Only run code you trust.

## Production build & installer

```bash
npm run build        # build the renderer into dist/
npm run dist:win     # build + package a Windows NSIS installer into release/
```

Outputs `release/NovaCode-Setup-x64.exe`. macOS (dmg) and Linux (AppImage/deb) packaging configs are included; build them on the respective operating systems or via the CI `release` job (tag `v*`).

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server + Electron shell with live reload |
| `npm test` | Run the full Vitest suite once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run lint` | ESLint across `src/`, `electron/`, `tests/` |
| `npm run build` | Production renderer build into `dist/` |
| `npm run start` | Launch Electron against an existing `dist/` build |
| `npm run dist:win` | Build + package the Windows installer |

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — processes, IPC contract, services, security model
- [SECURITY.md](SECURITY.md) — threat model, key storage, IPC policy
- [ROADMAP.md](ROADMAP.md) — phases and feature status
- [CONTRIBUTING.md](CONTRIBUTING.md) — workflow and conventions
- [CHANGELOG.md](CHANGELOG.md) — release history
