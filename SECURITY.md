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
10. **Hosting credentials** — Vercel and Netlify access tokens live in the
    same encrypted store as AI keys (`hosting-<provider>-token`). They are
    read inside the main process immediately before a provider call and are
    never returned over IPC, written to settings, or printed. A revoked or
    wrong token is reported as a failed connection, never as a connected
    account.
11. **Deploy diagnosis** — the "Explain this failure" button is the only
    deployment action that can reach a language model, and it runs only when
    clicked. Evidence (run state, counts, the tail of the local and host
    logs) is masked for bearer headers, known token prefixes, private-key
    blocks, signed URLs and `*SECRET=*` pairs before it becomes prompt text,
    and the stored access token is passed as a never-send literal. The
    model's answer is masked again before it is displayed. Nothing is
    uploaded when no assistant is configured: the same evidence is matched
    against built-in failure causes, and the panel labels which route was
    used.
12. **Project build scripts** — a deploy can run the project's own
    `build` script. That child process is given the environment with the
    hosting tokens removed, so a repository cannot read the credential that
    publishes it. The interactive terminal is **not** filtered: it is your
    own shell, and you can already read your own environment there.

## What NovaCode deliberately does NOT sandbox

Running a command in the integrated terminal (or the AI applying an edit
you approved) executes **on your machine with your user permissions**.
NovaCode warns about this. Do not run untrusted project code.

A deployment build is the one project script NovaCode runs on its own
initiative, so it is gated: the Deploy panel shows the exact command and
requires your approval before executing it, and the child process does not
see your hosting tokens (see item 12 above).

## Known limitations (honest list)

- On Linux systems without a working keyring, `safeStorage` encryption is
  unavailable; the key is stored base64-with-`plain:` marker and the app
  logs a warning. Prefer the environment variable there.
- The CSP allows `unsafe-inline` styles (required by Monaco).
- Language servers, Git integration, and plugin sandboxing are not yet
  implemented (see ROADMAP.md).
- The publish path has been verified against the real Vercel and Netlify
  APIs only for **rejection** (an invalid token is refused, an unreachable
  API is reported as a failure). No successful deployment has been executed
  end to end from this build, so the happy path is covered by tests with a
  simulated provider rather than by a live host.

## Reporting a vulnerability

Please open a private security advisory via GitHub ("Security" →
"Report a vulnerability") or contact the maintainers directly. Do not
open public issues for exploitable findings.

## Supported versions

Security fixes land on the latest release tag. Versioned installers and
checksums are produced by the CI release workflow.
