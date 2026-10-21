# Roadmap

Status legend: ✅ implemented & tested · 🟡 partially implemented · ⬜ planned

## Phase 1 — Secure foundation ✅
- ✅ Repository audit; module structure (`electron/services`, `electron/ipc`)
- ✅ Hardened Electron shell: context isolation, sandbox, CSP, sender checks
- ✅ Workspace-confined, validated IPC contract
- ✅ Structured logging with secret redaction
- ✅ Settings service (userData, sanitized writes)
- ✅ Working dev build (`npm run dev`) and production build (`npm run build`)

## Phase 2 — Core editing ✅
- ✅ Explorer: create/rename/delete, expand/collapse, badges
- ✅ Monaco tabs, dirty state, breadcrumbs, Ctrl+S, close confirmation
- ✅ Session restore (tabs + active file per workspace)
- ✅ Multi-file search with jump-to-line
- ✅ Command palette + quick open, keyboard shortcuts
- ✅ Three themes, accent color, font/tab settings, resizable panels
- 🟡 Split editor groups
- 🟡 Save As, external-change watching

## Phase 3 — Terminal & runtimes 🟡
- ✅ Streaming terminal: output, exit codes, cancel, clear, history
- 🟡 Multiple terminal tabs and persisted sessions
- ⬜ Runtime detection (node/python presence + install guidance)
- ⬜ "Run file" actions with per-language adapters
- ⬜ Optional isolated execution story (documented honestly)

## Phase 4 — AI assistant ✅ / 🟡
- ✅ Secure OpenAI-compatible streaming chat (main-process only)
- ✅ OS-encrypted key storage; env-var support for dev
- ✅ Level selector (beginner/intermediate/advanced), active-file context
- ✅ Diff-reviewed AI edits (accept/reject, nothing written without approval)
- ✅ Connection test, honest error surfacing (401/429/offline)
- 🟡 Saved conversations, prompt library
- ⬜ Project agent: plan → approved file edits → run tests → verify
- ⬜ Local model adapter (LM Studio/Ollama detection & docs)

## Phase 5 — Language & project intelligence ⬜
- ⬜ Git integration: status, diff, branch, commit (via system git)
- ⬜ Diagnostics pipeline (start: Node syntax via TypeScript worker, Python via pyflakes if present)
- ⬜ LSP client architecture with per-language adapters
- ⬜ Project understanding map
- ⬜ Project health center

## Phase 6 — Differentiators ⬜
- ⬜ Visual API studio · ⬜ Database explorer · ⬜ Smart templates
- ⬜ Workspace profiles · ⬜ Focus mode · ⬜ Documentation browser
- ⬜ Plugin architecture (permission-aware, documented API)
- ✅ Safe change history (AI edit journal with restore; restores are journaled too)

## Phase 7 — Distribution 🟡
- ✅ electron-builder config: NSIS (x64), dmg (x64+arm64), AppImage/deb
- ✅ CI: lint + tests + build on Windows/Ubuntu/macOS runners
- ✅ Tagged-release job producing `NovaCode-Setup-x64.exe` + SHA256 sums
- ⬜ Code signing (needs certificates — documented in SECURITY.md)
- ⬜ Verified macOS/Linux artifacts (require native runners/secrets)
- 🟡 Auto-update story

## Phase 8 — Website & docs 🟡
- ✅ README / ARCHITECTURE / SECURITY / ROADMAP / CONTRIBUTING / CHANGELOG
- ⬜ Usage/demo video (record after feature set stabilizes; show open folder → edit → save → terminal → AI diff review)
- ⬜ Official download website (only after artifacts exist — no placeholder links)
