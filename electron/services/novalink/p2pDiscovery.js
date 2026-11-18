'use strict';
/**
 * P2P peer discovery for automatic local network sharing.
 *
 * This service automatically discovers other NovaCode instances on the same LAN
 * using UDP multicast/broadcast. Every instance both announces itself and listens
 * for peers. No server required - pure peer-to-peer.
 *
 * Protocol:
 * - Peers announce their identity (id, displayName, hostname, ip, port) over UDP
 * - Multicast group: 239.255.88.88, port: 53532
 * - Announce interval: 5 seconds
 * - Peer TTL: 15 seconds (if no announce, peer is removed)
 */
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');

const MAGIC = 'NOVALINK_P2P';
const PROTOCOL_VERSION = 1;
const DEFAULT_GROUP = '239.255.88.88';
const DEFAULT_PORT = 53532;
const ANNOUNCE_INTERVAL_MS = 5000;
const PEER_TTL_MS = 15000;
const MAX_PEERS = 64;
const MAX_PACKET_BYTES = 1024;
const MAX_NAME = 32;
const MAX_HOST = 64;

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
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

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
      if (address.startsWith('169.254.')) continue;
      if (address.startsWith('127.')) continue;
      picked.push({ name, address, netmask: entry.netmask || '' });
    }
  }
  return picked;
}

function encodePacket(packet) {
  const json = JSON.stringify(packet);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_PACKET_BYTES) {
    throw new Error(`P2P packet exceeds ${MAX_PACKET_BYTES} bytes (${bytes})`);
  }
  return Buffer.from(json, 'utf8');
}

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

function validateAnnounce(packet) {
  if (!packet || packet.op !== 'announce') return null;
  const id = boundedString(packet.id, MAX_NAME);
  const displayName = boundedString(packet.displayName, MAX_NAME);
  const hostname = boundedString(packet.hostname, MAX_HOST);
  if (!id || !displayName || !hostname) return null;
  const port = Number(packet.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!Array.isArray(packet.ips) || packet.ips.length === 0) return null;
  const ips = packet.ips.filter(isValidIPv4).slice(0, 4);
  if (ips.length === 0) return null;
  const ts = Number(packet.ts);
  return {
    op: 'announce',
    id,
    displayName,
    hostname,
    port,
    ips,
    ts: Number.isFinite(ts) ? ts : 0,
  };
}

/**
 * @param {object} deps
 * @param {object} deps.identity - { id, displayName, hostname }
 * @param {number} deps.port - TCP port for P2P connections
 * @param {(peers: object[]) => void} [deps.onPeers]
 * @param {object} [deps.logger]
 * @param {(opts: object) => object} [deps.socketFactory]
 * @param {() => object} [deps.interfacesProvider]
 * @param {string} [deps.group]
 * @param {number} [deps.port]
 * @param {number} [deps.announceIntervalMs]
 * @param {number} [deps.peerTtlMs]
 * @param {typeof Date.now} [deps.now]
 */
function createP2PDiscovery({
  identity,
  port,
  onPeers,
  logger = console,
  socketFactory = (opts) => dgram.createSocket(opts),
  interfacesProvider = () => os.networkInterfaces(),
  group = DEFAULT_GROUP,
  announceIntervalMs = ANNOUNCE_INTERVAL_MS,
  peerTtlMs = PEER_TTL_MS,
  now = () => Date.now(),
} = {}) {
  if (!identity || !identity.id) throw new Error('createP2PDiscovery requires identity with id');
  if (!port) throw new Error('createP2PDiscovery requires port');

  const peers = new Map(); // id -> { id, displayName, hostname, ips, port, lastSeen }
  let socket = null;
  let announceTimer = null;
  let pruneTimer = null;
  let running = false;

  function buildAnnounce() {
    const addrs = selectLanAddresses(interfacesProvider(), { excludeVpn: true });
    const ips = addrs.map((a) => a.address);
    if (ips.length === 0) return null;
    return {
      magic: MAGIC,
      v: PROTOCOL_VERSION,
      op: 'announce',
      id: identity.id,
      displayName: identity.displayName || 'Unknown',
      hostname: identity.hostname || 'host',
      port: port,
      ips: ips,
      ts: now(),
    };
  }

  function emitPeers() {
    if (typeof onPeers !== 'function') return;
    const list = [...peers.values()]
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
      .slice(0, MAX_PEERS)
      .map((p) => ({ ...p }));
    try { onPeers(list); } catch (error) { logger.warn?.('p2p peer listener threw', { error: String(error.message || error) }); }
  }

  function upsert(announce, sourceIp) {
    // Don't add ourselves
    if (announce.id === identity.id) return;

    const existing = peers.get(announce.id);
    const entry = {
      id: announce.id,
      displayName: announce.displayName,
      hostname: announce.hostname,
      ips: announce.ips.slice(),
      port: announce.port,
      lastSeen: now(),
      sourceIp: sourceIp || null,
    };
    peers.set(announce.id, entry);

    if (!existing || existing.displayName !== entry.displayName || existing.ips.join(',') !== entry.ips.join(',')) {
      emitPeers();
    }
  }

  function prune() {
    const cutoff = now() - peerTtlMs;
    let dropped = false;
    for (const [id, entry] of peers) {
      if ((entry.lastSeen || 0) < cutoff) {
        peers.delete(id);
        dropped = true;
      }
    }
    if (dropped) emitPeers();
  }

  function multicast(buffer) {
    if (!socket) return;
    try {
      socket.send(buffer, 0, buffer.length, DEFAULT_PORT, group);
    } catch (error) {
      logger.warn?.('p2p multicast failed', { error: String(error.message || error) });
    }
    try {
      socket.send(buffer, 0, buffer.length, DEFAULT_PORT, '255.255.255.255');
    } catch { /* best effort */ }
  }

  function handleMessage(msg, rinfo) {
    const packet = decodePacket(msg);
    if (!packet) return;
    const announce = validateAnnounce(packet);
    if (!announce) return;
    upsert(announce, rinfo?.address);
  }

  function start() {
    if (running) return false;
    try {
      socket = socketFactory({ type: 'udp4', reuseAddr: true });
    } catch (error) {
      logger.warn?.('p2p discovery socket creation failed', { error: String(error.message || error) });
      return false;
    }

    socket.on('error', (error) => {
      logger.warn?.('p2p discovery socket error', { error: String(error.message || error) });
    });

    socket.on('message', (msg, rinfo) => {
      logger.debug?.('p2p discovery received message', { from: rinfo?.address, size: msg.length });
      handleMessage(msg, rinfo);
    });

    socket.on('listening', () => {
      running = true;
      logger.info?.('p2p discovery socket listening', { port: socket.address()?.port });
      
      try { socket.setBroadcast(true); } catch (e) { logger.warn?.('setBroadcast failed', { error: String(e.message || e) }); }
      try { socket.setMulticastTTL(2); socket.setMulticastLoopback(true); } catch (e) { logger.warn?.('multicast setup failed', { error: String(e.message || e) }); }

      const addrs = selectLanAddresses(interfacesProvider(), { excludeVpn: true });
      logger.info?.('p2p discovery LAN addresses', { addrs: addrs.map(a => a.address) });
      
      const joined = new Set();
      for (const a of addrs) {
        if (joined.has(a.address)) continue;
        joined.add(a.address);
        try { socket.addMembership(group, a.address); } catch (e) { logger.warn?.('addMembership failed for interface', { address: a.address, error: String(e.message || e) }); }
      }
      if (joined.size === 0) {
        try { socket.addMembership(group); } catch (e) { logger.warn?.('addMembership failed (default)', { error: String(e.message || e) }); }
      }

      const announce = buildAnnounce();
      if (announce) {
        logger.info?.('p2p discovery sending initial announce', { ips: announce.ips });
        multicast(encodePacket(announce));
      } else {
        logger.warn?.('p2p discovery no LAN addresses available for announce');
      }

      announceTimer = setInterval(() => {
        const fresh = buildAnnounce();
        if (fresh) multicast(encodePacket(fresh));
      }, announceIntervalMs);
      announceTimer.unref?.();

      pruneTimer = setInterval(prune, Math.max(2000, Math.floor(peerTtlMs / 3)));
      pruneTimer.unref?.();

      logger.info?.('p2p discovery started', { group, port: DEFAULT_PORT, identityId: identity.id });
    });

    try {
      socket.bind(DEFAULT_PORT, '0.0.0.0');
    } catch (error) {
      logger.warn?.('p2p discovery bind failed', { error: String(error.message || error) });
      try { socket.close(); } catch { /* already closed */ }
      socket = null;
      return false;
    }
    return true;
  }

  function stop() {
    if (announceTimer) { clearInterval(announceTimer); announceTimer = null; }
    if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
    running = false;
    if (socket) {
      try { socket.close(); } catch { /* already closed */ }
      socket = null;
    }
  }

  function listPeers() {
    prune();
    return [...peers.values()].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)).slice(0, MAX_PEERS);
  }

  function getPeer(id) {
    const entry = peers.get(id);
    if (!entry) return null;
    if ((entry.lastSeen || 0) < now() - peerTtlMs) {
      peers.delete(id);
      emitPeers();
      return null;
    }
    return { ...entry };
  }

  function status() {
    return { running, peers: listPeers(), group, port: DEFAULT_PORT };
  }

  return { start, stop, listPeers, getPeer, status };
}

module.exports = {
  createP2PDiscovery,
  encodePacket,
  decodePacket,
  validateAnnounce,
  selectLanAddresses,
  isValidIPv4,
  DEFAULT_GROUP,
  DEFAULT_PORT,
};
