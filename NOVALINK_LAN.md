# NovaLink LAN — connecting two Windows PCs on the same Wi‑Fi (no internet)

This guide is for **NovaCode** users who want two or more Windows computers on the
**same Wi‑Fi network** to find each other's **NovaLink Live** server and chat, with
**no Render, no Fly.io, no cloud, and no paid hosting**. One PC runs the server
(the **host**); the other PCs (the **clients**) find it automatically.

Everything here uses the code that already ships in this repo:

- the **host** is the existing `link-server` (accounts, chat, presence, SQLite) —
  it is *not* a second server;
- **discovery** is a tiny UDP announcement built into `link-server`
  (`link-server/discovery.js`) and a matching finder in NovaCode
  (`electron/services/novalink/lanDiscovery.js`);
- the **client** is the existing NovaLink Live connection — discovering a host
  only fills in the server address for you. **You still sign in normally.**

---

## 1. The two roles

| Role | What it does | How to do it |
|------|--------------|--------------|
| **Host PC** | Runs the NovaLink Live server and advertises it on the LAN. | In NovaCode: open **NovaLink**, click **LAN options → Start hosting**. <br>Or from a terminal: `npm run link:dev` (see §3). |
| **Client PC** | Searches the LAN, picks the host, signs in, chats. | In NovaCode: open **NovaLink → LAN options → Search the network → Connect**. |

The **same PC can be both** if you want. The host PC does not need to be signed in
to chat as its own user — it just needs to be running the server and staying awake.

---

## 2. Which ports / addresses are used

- **TCP `10000`** — the NovaLink Live HTTP + WebSocket server (`/link`). This is the
  port the actual chat runs over.
- **UDP `53531`** — LAN discovery. The host answers "are you there?" queries on this
  UDP port and multicasts to the group `239.255.77.77`. Discovery packets carry only
  a display name, host name, IP addresses, port, and protocol version —
  **never a password, token, or message.**

NovaCode figures out the host PC's **local Wi‑Fi IPv4 address automatically**
(it skips loopback, VPN/tunnel adapters, and `169.254.x` "no network" addresses).
You do **not** hard‑code an IP. The manual‑IP box (§6) is only a fallback.

---

## 3. Starting the host

### Option A — from the NovaCode UI (recommended)

1. On the **host PC**, open NovaCode → the **NovaLink** panel.
2. Click **LAN options** → **Start hosting**.
3. The panel shows the address peers should reach you at, e.g.
   `http://192.168.1.42:10000`. Keep NovaCode open on this PC.

NovaCode starts the real `link-server` in the background using the Node runtime
bundled with the app (no separate Node install needed). Its database and uploaded
files live under your NovaCode user data folder, so accounts and history persist.

### Option B — from a terminal (developer / troubleshooting)

From the project folder, on the host PC:

```powershell
$env:LINK_HOST="0.0.0.0"
$env:LINK_PORT="10000"
$env:LINK_DISCOVERY="1"
$env:LINK_ALLOW_PLAINTEXT="1"
npm run link:dev
```

You should see `NovaLink Live listening` and `discovery advertising` in the log.
Leave this window open. To stop, press `Ctrl+C`.

> The server **binds `0.0.0.0` by default**, which is what makes it reachable from
> other machines. Binding only `127.0.0.1` would keep it local and defeat the point.

---

## 4. Windows Firewall — allow NovaLink on **Private** networks only

The first time the host listens, Windows usually pops up a firewall prompt. **Check
"Private networks"** and click **Allow**. If you dismissed it, or nothing prompts,
add the rules yourself. Open **PowerShell as Administrator** and run:

```powershell
# Allow the chat port (TCP 10000) on PRIVATE networks only.
New-NetFirewallRule -DisplayName "NovaLink Live (TCP 10000, Private)" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 10000 `
  -Profile Private

# Allow LAN discovery (UDP 53531) on PRIVATE networks only.
New-NetFirewallRule -DisplayName "NovaLink Discovery (UDP 53531, Private)" `
  -Direction Inbound -Action Allow -Protocol UDP -LocalPort 53531 `
  -Profile Private
```

If you changed the port from `10000`, use that number in both commands.

**Do NOT** enable all networks or **Public**:

- Never run `Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled False`.
  That turns the firewall off — do not do it.
- Keep both rules scoped to `-Profile Private`. A home/office Wi‑Fi should be a
  *Private* network. If Windows calls your Wi‑Fi **Public**, make it Private:
  **Settings → Network & internet → Wi‑Fi → (your network) → Set as Private**.

To verify the rules exist later:

```powershell
Get-NetFirewallRule -DisplayName "NovaLink*" | Format-Table DisplayName,Enabled,Action,Profile
```

To remove them (e.g. you are done hosting):

```powershell
Remove-NetFirewallRule -DisplayName "NovaLink Live (TCP 10000, Private)"
Remove-NetFirewallRule -DisplayName "NovaLink Discovery (UDP 53531, Private)"
```

---

## 5. Keep the host awake while it serves others

A sleeping host stops answering. On the **host PC**:

- **Settings → System → Power → Screen & sleep → "When asleep, ... put my PC to sleep when I'm away"** → set to **Never** (at least when plugged in).
- Or run this in PowerShell to keep the machine awake only while the app hosts:

```powershell
# Prevent sleep while a NovaCode / link-server window is open.
powercfg -change -standby-timeout-ac 0
powercfg -change -hibernate-timeout-ac 0
```

Laptops should stay **plugged into power**. Keep the NovaCode window (or terminal)
running on the host.

---

## 6. Finding the host on a client PC

1. On the **client PC**, open NovaCode → **NovaLink → LAN options**.
2. Click **Search the network**. The badge reads **Searching…** then **NovaLink host
   found** with the host's name and IP.
3. Click **Connect** on that host. NovaCode points the existing connection at it —
   the badge moves to **Connecting**, then you sign in (or create an account) on
   the host, exactly as normal.

### If discovery finds nothing (manual IP fallback)

Some Wi‑Fi — especially **guest networks** and **"AP client isolation"** — block the
UDP discovery. Use the manual box instead (type the **host's** Wi‑Fi IPv4 and port):

```
Address: 192.168.1.42      Port: 10000
```

Find the host's IP on the **host PC**:

```powershell
ipconfig | Select-String -Context 0,6 "Wi-Fi"
```

Look for **IPv4 Address** under your Wi‑Fi adapter (usually `192.168.x.x` or
`10.x.x.x`). Use that in the manual box.

---

## 7. Diagnosing connectivity (PowerShell)

Run these to confirm the path is open **before** blaming NovaCode.

**From the client PC, can you reach the host's chat port?**

```powershell
Test-NetConnection -ComputerName 192.168.1.42 -Port 10000
```

- `TcpTestSucceeded : True` → the TCP path and firewall are fine; the problem is
  elsewhere (server not running, wrong IP).
- `False` → the host is asleep/off, the server isn't running, the IP is wrong, or
  the firewall is blocking (go back to §4).

**Is it a discovery (UDP) problem specifically?** If `Test-NetConnection` to port
10000 succeeds but auto‑search finds nothing, discovery is being blocked — use the
manual IP fallback (§6), and check §8.

**Is your Wi‑Fi isolating clients from each other?** If two PCs on the *same*
network **cannot** ping each other even with firewalls open, the router is probably
enabling **AP / client isolation**:

```powershell
ping 192.168.1.42
```

If ping fails between two known‑good, awake machines on the same SSID, log into
your router and turn **off** "AP isolation" / "Client Isolation" / "Guest network
privacy", or move both PCs to the same non‑guest SSID. This is a router setting —
no amount of NovaCode configuration can bypass it.

---

## 8. Wi‑Fi that blocks multicast

Discovery uses UDP multicast (and a broadcast fallback). Some networks filter it.
Symptoms and fixes:

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Auto‑search finds nothing, but manual IP works | Multicast/broadcast filtered | Use manual IP (§6) |
| Two PCs can't ping each other at all | AP / client isolation | Router setting (§7) |
| Host found but connect fails | Firewall on TCP 10000 | Add the private rule (§4) |
| Works, then stops after a while | Host slept, or Wi‑Fi re‑assigned IP | Keep host awake (§5); re‑search after an IP change |

Because NovaCode re‑searches automatically and the host re‑announces every few
seconds, a **host IP change** (the router handing out a new address) is picked up on
the next search without restarting anything.

---

## 9. Security notes (please read)

- **Discovery is not trust.** Finding a host on the LAN does **not** log you in,
  does **not** grant admin, and does **not** skip authentication. Every private
  message, admin action, and support session is still authorized **on the server**,
  exactly as before. An attacker on your Wi‑Fi cannot read chat by "discovering" a
  host — they still need a valid login.
- **`ws://` on a LAN is unencrypted.** For first‑run convenience the host allows
  plain‑text (`LINK_ALLOW_PLAINTEXT=1`). On a **trusted, isolated home/office LAN**
  that is usually acceptable, but **anyone who can capture Wi‑Fi traffic on that
  network could read the traffic in transit.** Treat it like talking in an open room.
- **To make it private (recommended for real or sensitive data): use TLS/WSS.**
  Put a certificate on the host and it will serve `https://`/`wss://` — the client
  follows automatically because the announce carries a `tls` flag:

  ```powershell
  $env:LINK_TLS_CERT="C:\path\fullchain.pem"
  $env:LINK_TLS_KEY="C:\path\privkey.pem"
  # Leave LINK_ALLOW_PLAINTEXT unset (or 0): a routable bind then requires TLS.
  npm run link:dev
  ```
- **Never expose the host to the public internet from this feature.** LAN discovery
  and the Wi‑Fi bind are intentional; do **not** port‑forward TCP 10000 on your
  router. If you ever need remote (non‑LAN) access, that is a separate, deliberate,
  TLS‑terminated deployment — not what this does.
- **Discovery packets carry no secrets** (name/host/IP/port/version only) and are
  size‑ and field‑validated on both sides; malformed packets are dropped.

---

## 10. Manual test with two Windows PCs

This is the real end‑to‑end check the feature is built for.

1. Put **both PCs on the same Wi‑Fi**, plugged into power, both running NovaCode.
2. On **PC A** (host): **NovaLink → LAN options → Start hosting**. Note the shown
   address (e.g. `http://192.168.1.42:10000`). Allow the firewall prompt (Private).
3. On **PC B** (client): **NovaLink → LAN options → Search the network**.
   - You should see **NovaLink host found — PC A**. If not, run §4 (firewall) and §8
     (multicast), then use the manual IP from PC A.
4. On **PC B**, click **Connect**, then **Create an account** (e.g. `alice`) — the
   account is stored on the **host's** SQLite DB.
5. On **PC A**, sign in / create a second account (e.g. `bob`) against its own host
   (or use a third PC as another client).
6. Add each other as contacts and **send a private message**. Both should show
   online presence, and messages should deliver in real time.

### What to verify (checklist)

- [ ] Two PCs on one Wi‑Fi discover/connect/chat (the primary scenario).
- [ ] Three or more clients connect to the same host simultaneously.
- [ ] Authentication works over the LAN; private messages are authorized **on the
      server** (a client cannot read another's conversation).
- [ ] Stopping and restarting the host recovers cleanly; clients reconnect.
- [ ] A client keeps working after a brief Wi‑Fi drop (auto‑reconnect).
- [ ] Changing the host's IP is picked up on the next search.
- [ ] A malformed / non‑NovaLink UDP packet is ignored (no crash — covered by tests).
- [ ] A PC with multiple adapters advertises its Wi‑Fi address, not VPN/loopback.
- [ ] With the firewall rule removed, search/connect fails as expected; re‑adding it
      (Private only) fixes it.
- [ ] On an AP‑isolated network, discovery finds nothing and manual IP is required.
- [ ] Start/Stop hosting toggles exactly one server (no duplicate port‑in‑use errors).

---

## 11. Troubleshooting quick table

| Problem | First things to try |
|---------|---------------------|
| "No hosts found" | Is the host running? Firewall UDP 53531 (§4)? Else use manual IP (§6). |
| Found but "Connecting…" forever | `Test-NetConnection host 10000` (§7). Firewall TCP 10000? Wrong IP? |
| "server unreachable: fetch failed" | The host isn't listening on that address/port yet. Restart hosting. |
| Works then breaks | Host slept (§5) or got a new IP — re‑search. |
| "port in use" / double server | You already have `npm run link:dev` running — don't also "Start hosting". |
| Can't reach a second device on Wi‑Fi | Router AP isolation (§7/§8). |
