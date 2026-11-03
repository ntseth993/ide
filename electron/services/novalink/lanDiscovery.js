'use strict';
/**
 * LAN discovery *client* — runs in the Electron main process.
 *
 * This is the counterpart to `link-server/discovery.js`, which is the responder
 * a host runs. Here we do the searching: quietly ask "any NovaLink Live hosts
 * out there?" over UDP, collect the replies, keep only the ones that check out,
 * and hand the renderer a de-duplicated, self-expiring host list. When the user
 * picks one we translate it into a `http://<ip>:<port>` base URL and feed it to
 * the existing NovaLink Live client — no second protocol, no second socket.
 *
 * Why this lives in the main process and not the renderer:
 *   - UDP (`dgram`) is a Node capability; the renderer is sandboxed with
 *     `nodeIntegration:false` and must never open raw sockets.
 *   - One long-lived scanner per app, independent of how many times the React
 *     window reloads. The renderer only subscribes to results over IPC.
 *
 * We reuse the responder's packet vocabulary and validators (encodePacket /
 * decodePacket / validateAnnounce) rather than inventing a second format, so a
 * packet this client accepts is by construction the same one a host emits.
 *
 * Security posture (mirrors the spec):
 *   - No trust from discovery. A discovered host is just an address; the user
 *     still authenticates through the normal `/link` flow. We never bypass that.
 *   - We only ever build URLs to well-formed IPv4 literals on the validated
 *     port — never to a hostname or an address that failed validation.
 *   - Malformed / oversized / wrong-service datagrams are dropped silently.
 */
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');

// Reuse the shared packet layer. The relative path survives packaging because
// `link-server/**` is listed in the electron-builder `files` set.
const {
  MAGIC,
  PROTOCOL_VERSION,
  SERVICE_ID,
  encodePacket,
  decodePacket,
  validateAnnounce,
  isValidIPv4,
  selectLanAddresses,
} = require('../../../link-server/discovery.js');

const DEFAULT_GROUP = '239.255.77.77';
const DEFAULT_PORT = 53531;
const DEFAULT_QUERY_INTERVAL_MS = 3000;   // how often we re-ask
const DEFAULT_TTL_MS = 12000;             // a host we stop hearing from expires
const MAX_HOSTS = 32;                     // cap the map so a flood can't balloon it

/**
 * Turn a validated announce into a base URL for the Live client, choosing the
 * first routable IPv4 the host advertised. Returns null if nothing usable.
 */
function announceToBaseUrl(announce) {
  if (!announce || !Array.isArray(announce.ips)) return null;
  const ip = announce.ips.find(isValidIPv4);
  if (!ip) return null;
  const scheme = announce.tls ? 'https' : 'http';
  return `${scheme}://${ip}:${announce.port}`;
}

/**
 * Manual IP fallback for networks that block multicast (AP client isolation,
 * "guest" Wi-Fi, enterprise mDNS filtering). Validates strictly before building
 * a URL: only a dotted-quad IPv4 or an explicit `localhost`, and only a real
 * port. We deliberately do NOT accept arbitrary hostnames here — a discovered
 * or typed value must be a concrete address, which keeps the address bar from
 * becoming an SSRF vector against the main process.
 */
function manualBaseUrl({ address, port, tls = false } = {}) {
  const host = typeof address === 'string' ? address.trim() : '';
  if (!host) throw new Error('Enter the host computer\u2019s IP address (for example 192.168.1.42).');
  if (host !== 'localhost' && !isValidIPv4(host)) {
    throw new Error('That address is not a valid IPv4. On a LAN, type the host\u2019s IP like 192.168.1.42.');
  }
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error('Port must be a number between 1 and 65535.');
  }
  const scheme = tls ? 'https' : 'http';
  return `${scheme}://${host}:${n}`;
}

/**
 * @param {object} deps
 * @param {(hosts: object[]) => void} [deps.onHosts]     Pushed on every change.
 * @param {object} [deps.logger]
 * @param {(opts: object) => object} [deps.socketFactory]  seam for tests (dgram.createSocket)
 * @param {() => object} [deps.interfacesProvider]          seam for tests (os.networkInterfaces)
 * @param {string} [deps.group]
 * @param {number} [deps.port]
 * @param {number} [deps.queryIntervalMs]
 * @param {number} [deps.ttlMs]
 * @param {typeof Date.now} [deps.now]
 */
function createLanDiscovery({
  onHosts,
  logger = console,
  socketFactory = (opts) => dgram.createSocket(opts),
  interfacesProvider = () => os.networkInterfaces(),
  group = DEFAULT_GROUP,
  port = DEFAULT_PORT,
  queryIntervalMs = DEFAULT_QUERY_INTERVAL_MS,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
} = {}) {
  const queryId = crypto.randomBytes(6).toString('hex');
  // id -> { id, name, host, ips, port, tls, baseUrl, lastSeen }
  const hosts = new Map();

  let socket = null;
  let queryTimer = null;
  let pruneTimer = null;
  let scanning = false;

  function buildQuery() {
    // A query is tiny and carries no data beyond protocol framing — nothing an
    // eavesdropper or a hostile host can turn into credentials.
    return encodePacket({ magic: MAGIC, v: PROTOCOL_VERSION, op: 'query', id: queryId });
  }

  function emitHosts() {
    if (typeof onHosts !== 'function') return;
    const list = [...hosts.values()]
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
      .slice(0, MAX_HOSTS)
      .map((h) => ({ ...h }));
    try { onHosts(list); } catch (error) { logger.warn?.('lan host listener threw', { error: String(error.message || error) }); }
  }

  function upsert(announce) {
    const baseUrl = announceToBaseUrl(announce);
    if (!baseUrl) return;
    const existing = hosts.get(announce.id);
    const entry = {
      id: announce.id,
      name: announce.name,
      host: announce.host,
      ips: announce.ips.slice(),
      port: announce.port,
      tls: announce.tls,
      proto: announce.proto,
      baseUrl,
      lastSeen: now(),
    };
    hosts.set(announce.id, entry);
    // Only notify when something actually changed, to keep the renderer quiet.
    if (!existing
      || existing.baseUrl !== baseUrl
      || existing.name !== entry.name
      || existing.ips.join(',') !== entry.ips.join(',')) {
      emitHosts();
    } else {
      // Refresh seen-time silently; a prune pass will still re-emit if it drops.
      hosts.set(announce.id, entry);
    }
  }

  function prune() {
    const cutoff = now() - ttlMs;
    let dropped = false;
    for (const [id, entry] of hosts) {
      if ((entry.lastSeen || 0) < cutoff) {
        hosts.delete(id);
        dropped = true;
      }
    }
    if (dropped) emitHosts();
  }

  function sendQuery() {
    if (!socket) return;
    let buf;
    try { buf = buildQuery(); } catch { return; }
    // Multicast to the group; a host joined to it and hears us.
    try { socket.send(buf, 0, buf.length, port, group); } catch (error) { logger.warn?.('lan query multicast failed', { error: String(error.message || error) }); }
    // Broadcast too, so a responder bound without multicast membership (some
    // Wi-Fi APs / routers) still gets the probe.
    try { socket.send(buf, 0, buf.length, port, '255.255.255.255'); } catch { /* best effort */ }
    try { socket.send(buf, 0, buf.length, port, 'localhost'); } catch { /* loopback host on same machine */ }
  }

  function handleMessage(msg) {
    const packet = decodePacket(msg);
    if (!packet) return;
    const announce = validateAnnounce(packet);
    if (!announce) return;
    upsert(announce);
  }

  function start() {
    if (scanning) return false;
    try {
      socket = socketFactory({ type: 'udp4', reuseAddr: true });
    } catch (error) {
      logger.warn?.('lan discovery socket creation failed', { error: String(error.message || error) });
      socket = null;
      return false;
    }

    socket.on('error', (error) => {
      logger.warn?.('lan discovery socket error', { error: String(error.message || error) });
    });
    socket.on('message', (msg) => handleMessage(msg));

    socket.on('listening', () => {
      scanning = true;
      try { socket.setBroadcast(true); } catch { /* best effort */ }
      try { socket.setMulticastTTL(2); socket.setMulticastLoopback(true); } catch { /* best effort */ }
      // Join the group on every LAN interface so a multi-adapter machine (Wi-Fi
      // + Ethernet, or several Wi-Fi radios) hears spontaneous announces no
      // matter which NIC the host answered on. Fall back to the default route
      // when we can't enumerate interfaces, so single-NIC laptops still work.
      let joined = 0;
      try {
        const addrs = selectLanAddresses(interfacesProvider(), { excludeVpn: true });
        const seen = new Set();
        for (const a of addrs) {
          if (!a || !a.address || seen.has(a.address)) continue;
          seen.add(a.address);
          try { socket.addMembership(group, a.address); joined += 1; } catch { /* per-interface not supported */ }
        }
      } catch (error) { logger.warn?.('lan discovery interface scan failed', { error: String(error.message || error) }); }
      if (joined === 0) { try { socket.addMembership(group); } catch { /* best effort — queries still reach unicast responders */ } }
      sendQuery();
      queryTimer = setInterval(sendQuery, queryIntervalMs);
      queryTimer.unref?.();
      pruneTimer = setInterval(prune, Math.max(2000, Math.floor(ttlMs / 3)));
      pruneTimer.unref?.();
      logger.info?.('lan discovery scanning', { group, port });
    });

    try {
      // Bind an ephemeral local port; responders reply to us via unicast there.
      socket.bind(0, '0.0.0.0');
    } catch (error) {
      logger.warn?.('lan discovery bind failed', { error: String(error.message || error) });
      socket = null;
      scanning = false;
      return false;
    }
    return true;
  }

  function stop() {
    if (queryTimer) { clearInterval(queryTimer); queryTimer = null; }
    if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
    scanning = false;
    if (socket) {
      try { socket.close(); } catch { /* already closed */ }
      socket = null;
    }
    // Keep the last known host list — a brief rescan shouldn't blank the UI —
    // but stop refreshing so entries age out via their stored lastSeen.
  }

  function listHosts() {
    prune();
    return [...hosts.values()].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)).slice(0, MAX_HOSTS);
  }

  /** Resolve a specific host id to a base URL, or null if unknown/expired. */
  function selectHost(id) {
    const trimmed = typeof id === 'string' ? id.trim() : '';
    const entry = hosts.get(trimmed);
    if (!entry) return null;
    if ((entry.lastSeen || 0) < now() - ttlMs) { hosts.delete(trimmed); emitHosts(); return null; }
    return { baseUrl: entry.baseUrl, name: entry.name, host: entry.host, ips: entry.ips.slice(), port: entry.port, tls: entry.tls };
  }

  function status() {
    return { scanning, hosts: listHosts(), group, port };
  }

  // Test seam: feed a raw datagram as if it arrived from a responder.
  function __ingestForTests(buffer) {
    handleMessage(buffer);
  }

  return { start, stop, listHosts, selectHost, status, SERVICE_ID, __ingestForTests };
}

module.exports = { createLanDiscovery, announceToBaseUrl, manualBaseUrl, DEFAULT_GROUP, DEFAULT_PORT };
