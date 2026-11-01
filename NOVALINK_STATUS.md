# NovaLink Live — honest status

This document maps every one of the twelve acceptance tests in the spec to
what is actually implemented, what actually passes today, and what is
gated on a step only the operator can take (deploying the backend, code
signing the installer, running two physical machines).

Read this before deciding whether NovaLink Live is "done" for your use.

## What shipped in this increment

- **Bridge** (`electron/services/novalink/liveClient.js`, `electron/ipc/registerIpc.js`,
  `electron/preload.js`, `src/services/novaClient.js`) — WebSocket client,
  REST client, OS-keystore-backed bearer session, reconnect with backoff
  `[500, 1500, 4000, 10000, 30000]`, close-code 1008 clears the token.
- **Backend** (`link-server/`) — dependency-free Node 22 server:
  `node:sqlite` for storage, hand-rolled RFC 6455 WebSocket framing on
  `/link`, REST under `/api/*`, `/health` probe, five per-IP rate buckets,
  password hashing, session HMAC, attachment scanner. Booted in-process
  inside the integration tests; nothing is mocked.
- **Renderer store** (`src/services/novalinkLiveStore.js`) — a
  `useSyncExternalStore`-compatible observable. Consumes every frame the
  main process forwards; owns optimistic send / reconcile, typing decay at
  3 s, unread aggregation, delivery + read receipts, and the native
  notification side effect when the window is unfocused.
- **Chat workspace** (`src/components/NovaLinkLive/*`) — AuthScreen,
  ChatWorkspace, ConversationList, UserDirectory, MessageThread, Composer,
  CodeSnippet, FileAttachment, DiagnosticsPanel, NovaLinkLiveRoot. The old
  324-line `NovaLinkView.jsx` is a thin wrapper around NovaLinkLiveRoot.
- **Endpoint baking** (`scripts/generate-live-config.js` +
  `electron/services/novalink/liveConfig.js`) — a `NODE_ENV=production`
  build without a real `NOVALINK_LIVE_URL` fails the packaging step before
  `electron-builder` ever runs. Ordinary users never see a URL field.
- **Native notifications** (`novalinkLive:notify` IPC channel) — Electron
  `Notification` bridged behind an argument-shaping guard; click-to-focus
  hands the conversation id back to the renderer.
- **Deploy recipes** (`link-server/Dockerfile`, `link-server/fly.toml`,
  `link-server/render.yaml`) and the operator runbook
  (`link-server/DEPLOYMENT.md`).
- **Classroom Monitor** (`link-server/admin.js`, `link-server/adminHub.js`,
  `link-server/admin-ui.html`, `electron/services/classroom/*`,
  `src/components/NovaLinkLive/ClassroomBadge.jsx`) — a teacher (an account
  with `role='admin'`) creates classes and receives a 6-character join code;
  students paste that code in **Settings → NovaLink → Classroom** to enroll.
  Enrolled students stream structured activity frames
  (`editor.snapshot`, `file.open`, `file.rename`, `terminal.command`,
  `ai.prompt`, `app.focus`) over the same `/link` WebSocket chat already
  uses; the server stores them in `activity_events` (default 24-hour
  retention, `ADMIN_RETENTION_HOURS`) and fans them out in real time to
  any admin socket that has issued `admin.subscribe`. A persistent
  "Monitored" badge in the status bar cannot be hidden by CSS because it
  renders in the App shell, not inside the workspace. See
  `SECURITY.md` for the full consent and data-handling model.

### Classroom Monitor — first-run checklist

1. Deploy `link-server` with `ADMIN_BOOTSTRAP_USERNAME=<handle>` set in the
   environment. The **first** account registered whose username matches
   (case-insensitive) is stamped `role='admin'`. Every subsequent account
   is a plain `user`. There is no in-app way to promote an account later;
   rotate the env var and re-bootstrap if you need a second admin.
2. Teacher signs into the dashboard at `http://<host>/admin`, creates a
   class, and copies the join code.
3. Student opens NovaCode → Settings → NovaLink → Classroom, pastes the
   code. The badge appears in the status bar within a second, and the
   teacher's dashboard tile for that student goes live.
4. Student can unenroll at any time by clicking the badge → Unenroll; the
   enrollment row is deleted server-side and no further events are stored
   for that enrollment id.

## Acceptance test status

| # | Test | Status | Evidence |
|---|------|--------|----------|
| 1 | Fresh install opens NovaCode and shows NovaLink without any URL field | **Implemented — you must produce the installer** | The chat workspace renders without ever showing a URL. The DiagnosticsPanel is gated behind `settings.developer.novalinkDiagnostics === true` OR `window.__novaEnv.NOVALINK_DEV === '1'`; a packaged build with those unset never sees the field. Proving #1 end-to-end requires running `npm run dist:win` against a deployed URL. |
| 2 | Register a NovaLink account from inside the app | **Passing** (integration + component tests) | `tests/novalink/liveClient.test.js` boots real link-server and exercises register + WS auth. `tests/novalink/authScreen.test.jsx` proves the submit path. |
| 3 | Sign in from inside the app | **Passing** (same harness) | Login + WS `auth` frame + `ready` reply verified against real link-server. |
| 4 | Send a message; second client receives it in real time | **Passing** | `tests/novalink/liveClient.test.js` opens two clients against the same booted server, sends A→B, waits for B's `message` frame. |
| 5 | Send a message back; original sender receives it | **Passing** | Same integration test verifies B→A. |
| 6 | Restart the app; the session is restored automatically | **Passing** at bridge level | `liveClient.js` reads the bearer from the OS secret store on `boot()`, reconnects to the WS automatically. Covered by `liveClient.test.js` reconnect case. Note: the OS keystore itself is not exercised in tests; a memory stub stands in. |
| 7 | Auto-reconnect after network drop | **Passing** at bridge level | `liveClient.test.js` tears the socket, asserts reconnect + `ready` within the backoff budget. Also asserts close code 1008 clears the stored token. |
| 8 | Delivery + read receipts appear without a manual refresh | **Passing** | `tests/novalink/liveClient.test.js` + `tests/novalink/novalinkLiveStore.test.js` cover both the wire frames and the store's transition. |
| 9 | Two real computers on two real networks chat through the internet | **Blocked on your deployment** | Nothing in this repo can complete this test without a deployed endpoint. I wrote `scripts/smoke-deployed.js` as a programmatic substitute: run `NOVALINK_LIVE_URL=https://<your-host> node scripts/smoke-deployed.js` after `fly deploy` (or the render equivalent); it registers two throwaway accounts, opens two WebSockets, exchanges a message in each direction, and asserts a `message.read` frame propagates. If it prints `PASS`, #9 is effectively satisfied at the wire level. |
| 10 | Authorization: a session cannot read a conversation it isn't a member of | **Passing** server-side | `tests/link-server/messaging.test.js` asserts a stranger's REST GET on someone else's conversation returns 403. The bridge inherits this; the WS hub filters by participant list before emitting a `message` frame. |
| 11 | Production build never carries a placeholder URL | **Passing** | `tests/liveConfig.test.js` asserts `main()` throws when `NODE_ENV=production` and `NOVALINK_LIVE_URL` is empty, malformed, non-https, or matches any of the placeholder patterns. |
| 12 | Installer does not require the user to install a server | **Conditionally true** | Correct as long as you deploy `link-server` (any of the three recipes) and bake `NOVALINK_LIVE_URL` at packaging time. If you instead choose to bundle link-server into the installer, this flips to a different acceptance criterion (packaging size, port collision, auto-update of the server binary) that the current design does **not** address. That variant is a separate piece of work. |

## What the tests in this repo actually run

- `npm test` boots `link-server` in-process for `tests/novalink/liveClient.test.js`
  and for every file under `tests/link-server/`. No `nock`, no fake socket.
- Renderer tests use `@testing-library/react` in jsdom against the
  `window.novaApi` stub in `tests/setup.js`. They prove the component and
  the store's contract; they never hit a real socket.
- `tests/registerIpc.test.js` registers the real `electron/ipc/registerIpc.js`
  with injected service stubs and calls every channel the way Electron
  does. The `novalinkLive:notify` shape guard is covered here.
- `tests/liveConfig.test.js` exercises the build-time URL generator against
  a temp output directory, and the runtime reader via `__resetForTests`.
- `tests/link-server/classroom.test.js` (17 cases) boots a real SQLite
  database, registers a teacher (via `ADMIN_BOOTSTRAP_USERNAME`) and
  students, and asserts the full class CRUD + enrollment + activity
  storage + WS-frame routing pipeline — including the admin-role guard on
  `admin.subscribe` and the 24-hour prune.
- `tests/novalink/classroomReporter.test.js` (14 cases) uses vitest fake
  timers to verify the debounced `editor.snapshot` collapses rapid edits
  into one frame every `DEBOUNCE_MS`, truncates long content to 200
  characters, and flushes pending snapshots on file switch. Terminal,
  AI-prompt, file-rename, and app-focus frames fire immediately.

## What I cannot verify in this environment

- Any command that reaches the public internet. `fly deploy`, `docker push`,
  `git push`, `render deploy` — none are executed from this session.
- Actual OS credential-vault behaviour. The tests substitute an in-memory
  secret store; if Windows Credential Manager misbehaves on a real install,
  you will discover it in the field.
- Code signing on Windows. That requires a signing certificate and a build
  host configured with it; nothing in this repo does that step.
- Notification UX on real desktops. The IPC shape is tested; the visual
  toast, click-to-focus, and per-OS quiet-hours behaviour can only be
  observed by running the packaged app.
- Voice / video calls end-to-end between two home-network peers. Chat works
  without TURN; WebRTC calls require the TURN env vars called out in
  `link-server/DEPLOYMENT.md`, and their success is only verifiable on
  real networks.
- Android. Not in scope for this repository.

## If you only do one thing after this

Deploy `link-server` to fly.io with the recipe in `link-server/fly.toml`
(cheapest and closest to a supported Node runtime), run
`NOVALINK_LIVE_URL=https://<app>.fly.dev node scripts/smoke-deployed.js`,
confirm it prints `PASS`, then build the installer with the same URL baked
in:

```
set NODE_ENV=production
set NOVALINK_LIVE_URL=https://<app>.fly.dev
npm run dist:win
```

If `prebuild` throws, that is the placeholder guard doing its job — fix the
URL, do not bypass the check.
