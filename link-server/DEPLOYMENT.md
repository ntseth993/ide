# NovaLink Live — deployment runbook

This is the operator guide for standing up the messaging backend so
NovaCode desktop users can chat across the internet. Read it end-to-end
before running `fly deploy` or clicking "Create" on Render.

The desktop build does NOT bundle a server. Users install NovaCode, it reads
the baked-in `NOVALINK_LIVE_URL` you provided at build time, and every chat
action talks HTTPS + WSS to *your* deployment. If this server is down, chat
is down for every user of that build.

## What runs where

```
NovaCode desktop (Electron)         link-server (Node 22+, no deps)
---------------------------         ---------------------------------
main process                        node server.js
  - liveClient.js (WS + HTTP)  ==>    - /health   (GET)
  - secretStore (OS vault)            - /api/*    (REST: accounts, chats, files)
                                      - /link     (WebSocket: auth + frames)
renderer                              SQLite at $LINK_DATA_DIR/link.sqlite
  - chat UI                           uploaded files at $LINK_DATA_DIR/files
```

There is no separate database service. The whole backend is one long-running
Node process; state fits in a JSON-on-disk SQLite file. Back that file up.

## Required environment

Every value below is validated at boot. Missing or unsafe values are logged by
`auditConfig()` in `link-server/config.js:132-156`; **treat each warning as a
blocker before pointing real users at the endpoint.**

| Variable | Default | Set this in production | Why |
|---|---|---|---|
| `LINK_HOST` | `127.0.0.1` | `0.0.0.0` | Bind a routable interface behind your proxy. |
| `LINK_PORT` | `8790` | `PORT` from PaaS (or your chosen port) | Server listens here. |
| `LINK_DATA_DIR` | `./data` | `/data` (persistent mount) | Where SQLite + uploaded files live. Losing this loses every account. |
| `LINK_TRUST_PROXY` | `false` | `1` when a proxy terminates TLS | Enables correct client-IP rate limiting buckets. Do NOT set on a bare plaintext bind. |
| `LINK_ALLOW_PLAINTEXT` | `true` only when loopback | `0` | Refuses to serve a routable interface without TLS. |
| `LINK_SERVER_SECRET` | empty | **required**, at least 32 random bytes | Session HMAC key. Generate with `openssl rand -hex 32`. If you lose it every user has to sign in again. |
| `LINK_REGISTRATION_OPEN` | `true` | your call | Turn off to invite-only. |
| `LINK_INVITE_CODE` | empty | set if registration is closed | The single code users must supply at registration. |
| `LINK_PASSWORD_MIN_LENGTH` | `12` | `12` or higher | Server rejects shorter on registration. |
| `LINK_SESSION_TTL_DAYS` | `30` | tune to your privacy policy | Bearer token lifetime in the OS secret store. |
| `LINK_TURN_URL` (+ username + credential) | empty | strongly recommended for calls | Without TURN, symmetric-NAT peers cannot complete WebRTC voice/video. Chat works regardless. |

Optional tuning: `LINK_RATE_*` (see `config.js:89-98`) governs per-IP buckets
for general, auth, message, upload, and WS-upgrade traffic. The defaults are
conservative for a small community. Increase them only after you have
monitoring.

## Choosing a host

| Platform | File | Persistent disk | TLS | Notes |
|---|---|---|---|---|
| fly.io | `link-server/fly.toml` | Volume `link_data` mounted at `/data` | Automatic (`force_https = true`) | Cheapest for a real deployment (shared-cpu-1x, ~$2/mo). WebSocket upgrade works out of the box. |
| render.com | `link-server/render.yaml` | Disk `/data`, 1 GB starter plan | Automatic | Blueprint auto-detects `render.yaml`. Starter plan has a 15-min idle timeout — desktop reconnects handle it. |
| Railway | Dockerfile (no config file) | Volumes | Automatic via edge | Set env through the dashboard; no `railway.json` is required. |
| VPS + nginx | Dockerfile + reverse proxy | Local path | Let's Encrypt or your own cert | Set `LINK_TRUST_PROXY=1`; make nginx pass `X-Forwarded-For` and `Upgrade`/`Connection` headers on the `/link` route. |

## Deploy with fly.io

```
cd link-server
fly launch --no-deploy                       # reads fly.toml
fly secrets set LINK_SERVER_SECRET="$(openssl rand -hex 32)"
fly secrets set LINK_INVITE_CODE="<optional>"
fly volumes create link_data --size 1
fly deploy
fly open                                     # shows the https://<app>.fly.dev URL
```

Verify:

```
curl https://<app>.fly.dev/health            # returns {ok:true, uptimeSeconds:…}
NOVALINK_LIVE_URL=https://<app>.fly.dev node ../scripts/smoke-deployed.js
```

The smoke script registers a temporary account, opens the WebSocket, sends a
message from A to B and back, and asserts each side received the other's
payload in real time. If it prints `PASS`, the endpoint is genuinely usable.

## Deploy with render.com

Push this repo to GitHub. On the Render dashboard: New + -> Blueprint ->
select the repo -> Render reads `link-server/render.yaml`. Fill the four
`sync: false` secret values in the dashboard before the first deploy.
Copy the resulting URL.

## Building the desktop against your endpoint

Once `NOVALINK_LIVE_URL` is set for the build, `scripts/generate-live-config.js`
writes `electron/services/novalink/liveConfig.generated.js` and packages that
file into the `.exe`. Ordinary users never see the URL.

```
cd <repo root>
set NODE_ENV=production
set NOVALINK_LIVE_URL=https://<your-app>.fly.dev
npm run dist:win
```

The prebuild step refuses to emit a packaged app if:

- `NOVALINK_LIVE_URL` is empty or unset,
- it points at `localhost`, `127.0.0.1`, `0.0.0.0`, `::1`, `example.com`,
  `link.example.com`, `your.host/`, or `change-me`,
- the protocol is not `https:`.

That is the enforcement behind spec acceptance test #11 ("no placeholder
URLs in production builds"). Do not skip `npm run prebuild`; `dist:win` runs
it automatically.

## Backup and restore

The whole backend state lives under `LINK_DATA_DIR`:

- `link.sqlite` — accounts, sessions, contacts, conversations, message bodies
  (attachments are pointers to `files/`), delivery + read receipts, reactions,
  call history, block list.
- `files/` — uploaded file bytes.
- `tmp/` — in-flight upload scratch; safe to purge any time.

To back up: `fly ssh console -C /data -c 'tar czf - link.sqlite files' >
backup-$(date +%F).tgz`. Test the restore path before you need it.

To wipe and start over: stop the app, delete the volume, redeploy. Every
bearer token becomes invalid; users will get close-code 1008 and the desktop
clears the stale token automatically.

## Rate limits and abuse protection

The server enforces five independent buckets per client IP: general (240/min),
auth (6/min, with 8-failure lockout over 15 min), message send (30/min),
upload (10/min), WebSocket upgrade (30/min). Tune them in `LINK_RATE_*` only
with real traffic data.

`LINK_TRUST_PROXY=1` is required for these buckets to key off the correct IP.
Without it, every user looks like your proxy's loopback and rate limits either
apply globally (denial-of-service on yourself) or bypass.

## Privacy + retention model

- Passwords are hashed on the server with the credential module
  (`link-server/credentials.js`). Recovery is reset-only, not undo.
- Message bodies are stored in SQLite in plaintext (SQLite at-rest). Anyone
  with the disk can read them. That is documented, not a bug. If you need
  server-side encryption at rest, apply LUKS or a PaaS disk-encryption flag.
- Uploaded files expire from the server after `LINK_ATTACHMENT_TTL_HOURS`
  (default 30 days). Set it to `0` to keep forever; set to a smaller number to
  reduce disk growth.
- Sessions are revocable individually via `POST /api/sessions/revoke`; a
  password change revokes every session except the current one.

## Common operator mistakes

1. Deploying without `LINK_SERVER_SECRET`. Server boots; every session
   identifier is predictable across restarts; rotate the secret and redeploy.
2. Setting `LINK_TRUST_PROXY=1` on a bare plaintext bind. Any client can pick
   its own rate-limit bucket by sending a fake `X-Forwarded-For`. Never do
   this.
3. Opening registration with no invite code and marketing the URL on Reddit.
   Consider `LINK_REGISTRATION_OPEN=0` + `LINK_INVITE_CODE=...` for the first
   two weeks of a new deployment.
4. Skipping TURN and expecting voice/video calls to work between two
   home-network users. They will not; the ICE handshake fails on
   symmetric-NAT.
5. Assuming the desktop reboots the server. It does not. The server is a
   separate process you deploy and monitor independently.

## Verifying acceptance tests #1–#12

- #1-#8 (install, open, sign in, chat both directions, restart, auto-reconnect):
  run the smoke script against your deployed URL with two accounts. It covers
  the whole flow programmatically.
- #9 (two computers, two networks): do it manually with two installs against
  the same deployed URL; verify messages arrive in real time.
- #10 (authz): integration tests in `tests/novalink/liveClient.test.js` boot
  link-server in-process and demonstrate the server rejects a session that
  tries to read a conversation it is not a participant in.
- #11 (no placeholder in production build): enforced by
  `scripts/generate-live-config.js`. A `NODE_ENV=production` build with a
  placeholder URL throws before electron-builder ever runs.
- #12 (installer without a separate server install): true as long as the
  backend is deployed and reachable; the installer itself carries no
  link-server binaries.
