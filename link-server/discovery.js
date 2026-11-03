'use strict';
/**
 * LAN discovery responder for NovaLink Live.
 *
 * Goal: let NovaCode installs on the same Wi-Fi find this host without typing an
 * IP. The host advertises itself over UDP; clients query and read the replies.
 *
 * Design constraints that shaped this file:
 *   - Zero npm dependencies, like the rest of link-server. Discovery rides on
 *     Node's built-in `dgram` (UDP) — no mDNS/multicast-dns package, because the
 *     build environment cannot reach the npm registry and a chat server whose
 *     only requirement is a Node runtime is easier to audit.
 *   - No secrets on the wire. An announce carries only a display name, host
 *     name, LAN IPv4 addresses, the TCP port, a TLS flag, a protocol version and
 *     a per-instance id. Never a password, token, API key, or message content.
 *   - Untrusted input everywhere. Every inbound datagram is decoded and
 *     validated before it can cause a reply; malformed/oversized/wrong-service
 *     packets are dropped silently. Discovery is NOT trust: a discovered host
 *     still has to authenticate through the existing `/link` auth flow.
 *
 * The pure helpers (encode/decode/validate/selectLanAddresses/buildAnnounce/
 * respondToQuery) are exported so they can be unit-tested without opening a
 * socket; multicast cannot be exercised on CI runners.
 */
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');

const MAGIC = 'NOVALINK_LAN';
const PROTOCOL_VERSION = 1;
const SERVICE_ID = 'novalink-live';

// A discovery datagram is tiny by design: one JSON object, well under a network
// MTU. Anything larger is either a mistake or an attempt to make us allocate.
const MAX_PACKET_BYTES = 1024;
const MAX_NAME = 64;
const MAX_HOST = 64;
const MAX_ID = 64;
const MAX_IPS = 4;

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isValidIPv4(value) {
  if (typeof value !== 'string') return false;
  const m = IPV4_RE.exec(value);
  if (!m) return false;
  for (let i = 1; i <= 4; i += 1) {
    const octet = Number(m[i]);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return false;
  }
  return true;
}

function boundedString(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  // Control characters have no business in a display name.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Pick the IPv4 addresses worth advertising from os.networkInterfaces():
 * skip loopback/internal, IPv6, and link-local APIPA (169.254.x). When
 * `excludeVpn` is set, also skip adapters whose name looks like a tunnel/VPN so
 * we do not advertise an address other Wi-Fi peers cannot route back to.
 */
function selectLanAddresses(interfaces, { excludeVpn = true } = {}) {
  const VPN_RE = /(vpn|tap|tun|wg|utun|ppp|hamachi|tango|anyconnect|cisco|virtual|vethernet|veth|docker|wsl|hyper-?v|loopback)/i;
  const picked = [];
  for (const [name, list] of Object.entries(interfaces || {})) {
    if (!Array.isArray(list)) continue;
    if (excludeVpn && VPN_RE.test(name)) continue;
    for (const entry of list) {
      if (!entry || entry.internal) continue;
      const family = String(entry.family || '').toLowerCase();
      if (family !== 'ipv4' && family !== '4' && entry.ipv4 !== true) continue;
      const address = typeof entry.address === 'string' ? entry.address : '';
      if (!isValidIPv4(address)) continue;
      if (address.startsWith('169.254.')) continue; // link-local, not reachable
      if (address.startsWith('127.')) continue;      // loopback safety net
      picked.push({ name, address, netmask: entry.netmask || '' });
    }
  }
  return picked;
}

/** Serialize a discovery packet to a Buffer, refusing anything oversized. */
function encodePacket(packet) {
  const json = JSON.stringify(packet);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_PACKET_BYTES) {
    throw new Error(`discovery packet exceeds ${MAX_PACKET_BYTES} bytes (${bytes})`);
  }
  return Buffer.from(json, 'utf8');
}

/** Parse a datagram into an object, or null on any malformed/oversized input. */
function decodePacket(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length === 0 || buf.length > MAX_PACKET_BYTES) return null;
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.magic !== MAGIC) return null;
  if (parsed.v !== PROTOCOL_VERSION) return null;
  return parsed;
}

/** A well-formed client query: {op:'query', id}. The id is echoed in the reply. */
function validateQuery(packet) {
  if (!packet || packet.op !== 'query') return null;
  const id = boundedString(packet.id, MAX_ID);
  return { id: id || '' };
}

/**
 * A well-formed announce, normalized to a safe subset. Returns null if any
 * field is missing or invalid so the caller never trusts a peer's self-report.
 */
function validateAnnounce(packet) {
  if (!packet || packet.op !== 'announce' || packet.service !== SERVICE_ID) return null;
  const name = boundedString(packet.name, MAX_NAME);
  const host = boundedString(packet.host, MAX_HOST);
  const id = boundedString(packet.id, MAX_ID);
  if (!name || !host || !id) return null;
  const port = Number(packet.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const proto = Number(packet.proto);
  if (!Number.isInteger(proto) || proto < 1) return null;
  if (typeof packet.tls !== 'boolean') return null;
  if (!Array.isArray(packet.ips) || packet.ips.length === 0) return null;
  const ips = packet.ips.filter(isValidIPv4).slice(0, MAX_IPS);
  if (ips.length === 0) return null;
  const ts = Number(packet.ts);
  return {
    op: 'announce',
    service: SERVICE_ID,
    name,
    host,
    id,
    port,
    proto,
    tls: packet.tls,
    ips,
    ts: Number.isFinite(ts) ? ts : 0,
  };
}

/** Build the announce payload the responder multicasts and unicasts. */
function buildAnnounce({ displayName, hostName, ips, port, tls, serverId, now = Date.now }) {
  return {
    magic: MAGIC,
    v: PROTOCOL_VERSION,
    op: 'announce',
    service: SERVICE_ID,
    name: String(displayName || hostName || 'NovaLink').slice(0, MAX_NAME),
    host: String(hostName || 'host').slice(0, MAX_HOST),
    ips: (Array.isArray(ips) ? ips : []).filter(isValidIPv4).slice(0, MAX_IPS),
    port: Number(port),
    tls: Boolean(tls),
    proto: PROTOCOL_VERSION,
    id: String(serverId).slice(0, MAX_ID),
    ts: typeof now === 'function' ? now() : now,
  };
}

/**
 * Decide the reply for one inbound datagram. Pure and socket-free so it is
 * testable: given raw bytes and the sender, return a Buffer to send back, or
 * null to stay silent. Only a valid query from anyone earns an announce.
 */
function respondToQuery(buf, announcePacket) {
  const packet = decodePacket(buf);
  if (!packet) return null;
  const query = validateQuery(packet);
  if (!query) return null;
  const reply = { ...announcePacket, replyTo: query.id };
  try {
    return encodePacket(reply);
  } catch {
    return null;
  }
}

/**
 * Create the responder. `start()` opens a UDP socket, joins the multicast group
 * on every LAN interface, answers queries with an unicast announce, and pushes a
 * periodic announce to the group so clients that never queried still see us.
 * Every failure is logged and swallowed — discovery must never take the server
 * down. `stop()` is idempotent.
 */
function createDiscovery({
  config,
  logger = console,
  socketFactory = (opts) => dgram.createSocket(opts),
  interfacesProvider = () => os.networkInterfaces(),
  serverId,
} = {}) {
  const disc = (config && config.discovery) || {};
  const group = disc.group || '239.255.77.77';
  const port = disc.port || 53531;
  const intervalMs = disc.intervalMs || 10000;
  const excludeVpn = disc.excludeVpn !== false;
  const hostName = (config && config.hostname) || os.hostname();
  const displayName = disc.displayName || hostName;
  const tls = Boolean(config && config.tls);
  const tcpPort = (config && config.port) || 10000;
  const id = serverId || crypto.randomUUID().slice(0, MAX_ID);

  let socket = null;
  let timer = null;
  let running = false;

  function currentAnnounce() {
    const addrs = selectLanAddresses(interfacesProvider(), { excludeVpn });
    const ips = addrs.map((a) => a.address);
    // If we somehow have no LAN address (VPN-only host), fall back to the bind
    // host only when it is a concrete routable IPv4. Never advertise a wildcard
    // bind (0.0.0.0), an unspecified address, or loopback — a peer could not
    // connect back to any of those.
    if (ips.length === 0) {
      const bind = config && config.host;
      if (isValidIPv4(bind) && !bind.startsWith('127.') && bind !== '0.0.0.0') ips.push(bind);
    }
    return buildAnnounce({ displayName, hostName, ips, port: tcpPort, tls, serverId: id });
  }

  function multicast(buffer) {
    if (!socket) return;
    try {
      socket.send(buffer, 0, buffer.length, port, group);
    } catch (error) {
      logger.warn?.('discovery multicast failed', { error: String(error.message || error) });
    }
  }

  function start() {
    if (running) return false;
    const announce = currentAnnounce();
    if (announce.ips.length === 0) {
      logger.warn?.('discovery disabled: no advertisable LAN address');
      return false;
    }
    try {
      socket = socketFactory({ type: 'udp4', reuseAddr: true });
    } catch (error) {
      logger.warn?.('discovery socket creation failed', { error: String(error.message || error) });
      return false;
    }

    socket.on('error', (error) => {
      logger.warn?.('discovery socket error', { error: String(error.message || error) });
    });

    socket.on('message', (msg, rinfo) => {
      const reply = respondToQuery(msg, announce);
      if (!reply || !rinfo) return;
      try {
        socket.send(reply, 0, reply.length, rinfo.port, rinfo.address);
      } catch (error) {
        logger.warn?.('discovery reply failed', { error: String(error.message || error) });
      }
    });

    socket.on('listening', () => {
      try {
        socket.setBroadcast(true);
      } catch { /* best effort */ }
      try {
        socket.setMulticastTTL(2);
        socket.setMulticastLoopback(true);
      } catch { /* best effort */ }
      // Join on each LAN interface so a multi-had host advertises everywhere.
      const addrs = selectLanAddresses(interfacesProvider(), { excludeVpn });
      const joined = new Set();
      for (const a of addrs) {
        if (joined.has(a.address)) continue;
        joined.add(a.address);
        try {
          socket.addMembership(group, a.address);
        } catch {
          // Some platforms reject per-interface membership; the default route
          // join below still works on most single-NIC machines.
        }
      }
      if (joined.size === 0) {
        try { socket.addMembership(group); } catch { /* best effort */ }
      }
      running = true;
      multicast(encodePacket(announce));
      timer = setInterval(() => {
        // Rebuild each tick so an IP change (DHCP) is reflected without a restart.
        const fresh = currentAnnounce();
        if (fresh.ips.length === 0) return;
        try { multicast(encodePacket(fresh)); } catch { /* oversized, ignore */ }
      }, intervalMs);
      timer.unref?.();
      logger.info?.('discovery advertising', { group, port, ips: announce.ips, tcpPort });
    });

    try {
      socket.bind(port, '0.0.0.0');
    } catch (error) {
      logger.warn?.('discovery bind failed', { error: String(error.message || error) });
      socket = null;
      return false;
    }
    return true;
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    running = false;
    if (!socket) return;
    try {
      socket.close();
    } catch { /* already closed */ }
    socket = null;
  }

  function status() {
    return { running, group, port, intervalMs, serverId: id };
  }

  return { start, stop, status, currentAnnounce };
}

module.exports = {
  MAGIC,
  PROTOCOL_VERSION,
  SERVICE_ID,
  MAX_PACKET_BYTES,
  createDiscovery,
  encodePacket,
  decodePacket,
  validateQuery,
  validateAnnounce,
  buildAnnounce,
  respondToQuery,
  selectLanAddresses,
  isValidIPv4,
};
