# Security Policy

## Scope of this document

How NovaCode protects your machine and your data, what the current
guarantees are, and how to report problems.

## Threat model

NovaCode grants a renderer (which displays editor content that can come
from any repository you open) access to privileged capabilities. The
design assumes the renderer **will** eventually be attacked, and contains
what it can do:

1. **Filesystem confinement** — every file operation is validated against
   the opened workspace folder. Path traversal (`../`), absolute paths
   outside the workspace, reserved device names, and path separators in
   new names are refused by `electron/services/pathGuard.js` before any
   disk access. The workspace root cannot be renamed or deleted.
2. **No arbitrary IPC** — the renderer has no generic `invoke` channel.
   `electron/preload.js` exposes a closed set of named methods; each main
   handler verifies the sender is the IDE window's webContents.
3. **Sandboxed renderer** — `sandbox: true`, `contextIsolation: true`,
   `nodeIntegration: false`, no `webview`. A compromised renderer cannot
   reach Node APIs.
4. **Strict CSP** — served as an HTTP header for both dev and packaged
   modes (`app://` protocol): `default-src 'self'`, no remote script
   sources, no `object`, no framing. Monaco is bundled locally so the app
   never contacts a CDN.
5. **Navigation & popups** — in-window navigation away from our own
   origins is blocked; window.open is denied; external links go to the
   system browser only over http(s).
6. **Secrets** — OpenAI API keys are encrypted with the OS credential
   store (Windows DPAPI, macOS Keychain, Linux libsecret via
   `safeStorage`) and stored under `userData/novacode-secrets.json`. The
   renderer can store, clear, or check *existence* — it never reads the
   key back. For development, `NOVACODE_OPENAI_API_KEY` is supported.
   Never commit keys; `.gitignore` excludes `.env*`.
7. **AI requests** — performed only by the main process. Provider errors
   are surfaced verbatim-but-mapped (401/403/404/429/5xx) without leaking
   the key. Conversation text (including any attached file contents) is
   sent to the configured provider; the AI panel shows exactly what is
   attached before you send.
8. **Logging** — structured JSON logs in `userData/logs/` with automatic
   redaction of key/token/password patterns.
9. **Single instance** — `requestSingleInstanceLock` prevents
   multi-instance races; child terminal processes are killed on quit.

## What NovaCode deliberately does NOT sandbox

Running a command in the integrated terminal (or the AI applying an edit
you approved) executes **on your machine with your user permissions**.
NovaCode warns about this. Do not run untrusted project code.

## Known limitations (honest list)

- On Linux systems without a working keyring, `safeStorage` encryption is
  unavailable; the key is stored base64-with-`plain:` marker and the app
  logs a warning. Prefer the environment variable there.
- The CSP allows `unsafe-inline` styles (required by Monaco).
- Language servers, Git integration, and plugin sandboxing are not yet
  implemented (see ROADMAP.md).

## Reporting a vulnerability

Please open a private security advisory via GitHub ("Security" →
"Report a vulnerability") or contact the maintainers directly. Do not
open public issues for exploitable findings.

## Supported versions

Security fixes land on the latest release tag. Versioned installers and
checksums are produced by the CI release workflow.
