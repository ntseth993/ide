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

## Classroom monitoring

NovaCode ships an opt-in **Classroom Monitor** so a teacher (an account
with `role='admin'` on the deployed `link-server`) can see what an
enrolled student is doing in the editor in real time. This is the most
powerful feature in the product and the easiest one to misuse, so the
guarantees below are load-bearing. Read them before you enable it in an
institution.

**Consent and control live with the student, not the teacher.**

- Enrollment requires the student to **actively paste a join code** into
  Settings → NovaLink → Classroom. A teacher cannot push monitoring onto
  a machine they do not physically control.
- Every enrolled student sees a permanent, non-dismissible
  **"Monitored" badge** in the status bar with a pulsing dot. The badge
  is rendered by `src/App.jsx` in the shell layer — a student cannot
  hide it with a workspace CSS override or by opening a different file.
- The student can unenroll at any time from the badge dialog. On
  unenroll, the `enrollments` row is deleted; subsequent
  `activity.report` frames for that enrollment id are refused by the
  server with `enrollment_not_found`.

**Data minimisation is enforced by the reporter, not by policy.**

- Only six event types are ever emitted: `editor.snapshot`, `file.open`,
  `file.rename`, `terminal.command`, `ai.prompt`, `app.focus`. There is
  no screen capture, no remote input, no keylogger, no filesystem scan,
  and no network-sniffer in this feature. The out-of-scope list in
  `NOVALINK_STATUS.md` is intentional.
- `editor.snapshot` reports the **first 200 characters** of the active
  file, the language, and the cursor position — not the full file, not
  files the student is not currently viewing, and not other tabs.
- Editor snapshots are **debounced to at most one frame every 2 s**, so
  a fast typist produces at most 30 payloads per minute rather than one
  per keystroke. Terminal commands, AI prompts, file renames and focus
  changes fire immediately (they are already low-frequency).
- Payloads are truncated at fixed budgets: 200 characters for editor
  content, 500 for terminal commands, 300 for AI prompts. Anything
  longer never leaves the machine.

**Transport and storage.**

- Activity frames ride the same `/link` WebSocket as chat, so on
  a properly deployed server (any of `link-server/fly.toml`,
  `render.yaml`, `Dockerfile` behind a TLS terminator) they are
  protected by WSS/TLS end-to-end. Do **not** run a classroom on
  plain HTTP; the `isLoopback` check in `link-server/config.js` allows
  plaintext only for development.
- The student app does **not** cache activity locally. Events go
  directly from the reporter to the socket. If the socket is down, the
  frame is dropped with a warning log — nothing queues to disk.
- The server writes events to `activity_events` with a **default 24-hour
  retention window** (`ADMIN_RETENTION_HOURS`, pruned on startup and
  hourly). Nothing older than that survives a server restart.
- Enrollment tokens (class id, enrollment id, join code) are persisted
  in the **OS credential store** via `electron/services/secretStore.js`
  (Windows DPAPI, macOS Keychain, Linux libsecret), the same path used
  for OpenAI API keys. The renderer never sees them; only the four
  `novalinkLive:classroom*` IPC channels touch them.

**Authorization model.**

- `role='admin'` is assigned **only** during registration of the account
  whose username matches `ADMIN_BOOTSTRAP_USERNAME`. There is no
  promotion path. To add a second admin, the operator restarts
  `link-server` with a new bootstrap handle and re-registers; there is
  deliberately no `/api/admin/role` endpoint.
- Every `/api/admin/*` route calls `requireAdmin(userId)` before
  touching data. `admin.subscribe` frames are refused with
  `Only admin accounts can subscribe` if the socket's session user is
  not an admin, and further refused with `class_not_owned` if the admin
  tries to subscribe to a class whose `teacher_user_id` is not them.
- A student socket can only report activity for its **own** enrollment.
  `adminHub.handleActivityReport` looks up the enrollment by the
  socket's `sessionId`, not by the `enrollmentId` in the frame, so
  forging a peer's enrollment id from a student socket has no effect.

**Threats this feature does not defend against.**

- A malicious teacher. Once a student is enrolled, the teacher can see
  everything the reporter sends. There is no teacher-behaviour audit
  trail beyond the server's own structured logs, and no appeal path.
  Deploy only in environments where you already trust the administrator.
- A compromised `link-server`. TLS terminates at the server, which
  holds plaintext events for up to `ADMIN_RETENTION_HOURS` and holds
  every enrollment's identity. The reporter trusts the server's
  certificate; it does not pin. If the deployed host cannot be trusted,
  do not enroll.
- A compromised student machine. Nothing here hardens against a student
  who edits the local app source and rebuilds — the badge and unenroll
  are the honest-client contract, not a security boundary against the
  user's own device.

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
