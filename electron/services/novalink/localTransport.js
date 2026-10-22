/**
 * NovaLink local-network transport.
 *
 * This is the transport NovaCode can actually run today on the machines it
 * supports: it discovers nearby NovaCode instances over UDP multicast/broadcast
 * and exchanges NovaLink envelopes over TCP, each session sealed with an
 * ephemeral ECDH + AES-256-GCM channel (see cryptoChannel.js). It uses only
 * Node built-ins (net, dgram, crypto) — no native modules, nothing to compile.
 *
 * Why not Bluetooth here?  Web Bluetooth is central-only/GATT and cannot make
 * two desktop apps discover each other and stream arbitrary bytes; a BLE
 * peripheral on Windows via pure Node is not reliably supported. So Bluetooth
 * lives behind this same Transport interface with an honest "unsupported" state
 * (bluetoothTransport.js) instead of a fake connection. The abstraction is what
 * lets a future real Bluetooth transport drop in without touching the service.
 *
 * SECURITY NOTE: this transport reaches any NovaCode on the same link/LAN.
 * Discovery is not authentication; a peer only becomes a trusted connection
 * after the user approves the pairing request, and the fingerprint shown at
 * that moment is the peer's cryptographic identity (verify it out-of-band).
 */
const net = require('net');
const dgram = require('dgram');
const { EventEmitter } = require('events');

const {
  MESSAGE_TYPES,
  makeMessage,
} = require('./protocol');
const {
  createKeyPair,
  fingerprint,
  deriveSessionKey,
  seal,
  open,
} = require('./cryptoChannel');

const DISCOVERY_MAGIC = 'NOVALINK1';
const MULTICAST_GROUP = '239.255.77.88';
const DEFAULT_DISCOVERY_PORT = 41777;
const ANNOUNCE_INTERVAL_MS = 3000;
const PEER_TTL_MS = 10000;

/**
 * @param {object} deps
 * @param {{ peerId:string, publicKey:Buffer, privateKey:Buffer, fingerprint:string, name:string }} deps.identity
 * @param {(msg:string)=>void} [deps.logger]
 * @param {number} [deps.discoveryPort]
 * @param {number} [deps.tcpPort]        fixed TCP port (0 = ephemeral; tests rely on announce reporting the real port)
 */
function createLocalTransport({ identity, logger = console, discoveryPort = DEFAULT_DISCOVERY_PORT, tcpPort = 0 }) {
  const events = new EventEmitter();
  // peerId -> { peerId, fp, name, host, tcpPort, kind, seenAt }
  const nearby = new Map();
  // peerId -> { socket, reader, send, state }
  const channels = new Map();
  let server = null;
  let boundTcpPort = null;
  let discovery = null;       // { socket, announceTimer, probeTimer }
  let discoveryError = null;
  let started = false;

  const log = (level, message, meta) => {
    if (logger && typeof logger[level] === 'function') logger[level](message, meta);
  };

  // --- nearby map -----------------------------------------------------------
  function publishPeers() {
    events.emit('peers', [...nearby.values()]
      .filter((p) => Date.now() - p.seenAt < PEER_TTL_MS)
      .sort((a, b) => (a.name || '').localeCompare(b.name || '')));
  }

  function recordPeer(peer) {
    if (!peer || !peer.peerId || peer.peerId === identity.peerId) return;
    nearby.set(peer.peerId, { ...peer, seenAt: Date.now() });
    publishPeers();
  }

  // --- TCP server (inbound sessions) ----------------------------------------
  function startServer() {
    return new Promise((resolve) => {
      server = net.createServer((socket) => handleInbound(socket));
      server.on('error', (error) => {
        discoveryError = discoveryError || `server: ${error.message}`;
        events.emit('error', { message: error.message });
      });
      server.listen(tcpPort, '0.0.0.0', () => {
        boundTcpPort = server.address().port;
        resolve();
      });
    });
  }

  // The handshake is a single plaintext length-prefixed JSON frame; every frame
  // after both sides hold the derived key is sealed. `phase` flips the reader.
  function attachChannel(socket, role, peerHint) {
    const ephemeral = createKeyPair();
    const channel = {
      socket,
      role,
      phase: 'handshake',
      ecdh: ephemeral.ecdh, // ephemeral session key pair; also what we advertise
      key: null,
      peer: peerHint || null, // { peerId, fp, name, publicKey }
      reader: null,
      send: (envelope) => writeSealed(channel, envelope),
    };

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) break;
        const length = buf.readUInt32BE(0);
        if (length > 4 * 1024 * 1024) {
          fail(channel, 'frame too large');
          return;
        }
        if (buf.length < 4 + length) break;
        const body = buf.subarray(4, 4 + length);
        buf = buf.subarray(4 + length);
        if (channel.phase === 'handshake') {
          handleHandshake(channel, body);
        } else {
          handleSecure(channel, body);
        }
      }
    });
    socket.on('error', (error) => fail(channel, error.message));
    socket.on('close', () => {
      if (channel.peer && channels.get(channel.peer.peerId) === channel) {
        channels.delete(channel.peer.peerId);
        events.emit('connection', { peer: channel.peer, state: 'closed' });
      }
    });

    // Send our handshake immediately (both sides do; it is symmetric).
    socket.write(encodeHandshake(ephemeral));
    return channel;
  }

  function encodeHandshake(ephemeral) {
    const header = Buffer.alloc(4);
    const payload = Buffer.from(JSON.stringify({
      hs: 1,
      id: identity.peerId,
      ep: ephemeral.publicKey.toString('base64'),
      pk: identity.publicKey.toString('base64'),
      name: identity.name,
    }), 'utf8');
    header.writeUInt32BE(payload.length, 0);
    return Buffer.concat([header, payload]);
  }

  function handleHandshake(channel, body) {
    let hs;
    try {
      hs = JSON.parse(body.toString('utf8'));
    } catch {
      return fail(channel, 'malformed handshake');
    }
    if (!hs || hs.hs !== 1 || !hs.ep || !hs.pk) {
      return fail(channel, 'bad handshake');
    }
    const remoteEphemeral = Buffer.from(hs.ep, 'base64');
    const remoteIdentity = Buffer.from(hs.pk, 'base64');
    const fp = fingerprint(remoteIdentity);
    // Derive the same session key the peer derives (ECDH is symmetric). The
    // local ephemeral is the exact key pair whose public half we advertised.
    channel.key = deriveSessionKey(channel.ecdh, remoteEphemeral);
    channel.peer = { peerId: hs.id, fp, name: hs.name || 'peer', publicKey: remoteIdentity };
    channel.phase = 'secure';
    // Bind this channel to a peer id; if it already exists, keep the newest.
    channels.set(channel.peer.peerId, channel);
    events.emit('connection', { peer: channel.peer, state: 'open' });
  }

  function handleSecure(channel, body) {
    let plaintext;
    try {
      plaintext = open(channel.key, body);
    } catch {
      return fail(channel, 'decryption failed (dropped unauthenticated frame)');
    }
    let message;
    try {
      message = JSON.parse(plaintext.toString('utf8'));
    } catch {
      return; // ignore malformed; transport-level integrity already checked
    }
    events.emit('message', { peer: channel.peer, message });
  }

  function writeSealed(channel, envelope) {
    if (channel.phase !== 'secure' || !channel.key) {
      throw new Error('NovaLink channel is not ready yet.');
    }
    const sealed = seal(channel.key, Buffer.from(JSON.stringify(envelope), 'utf8'));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(sealed.length, 0);
    return new Promise((resolve, reject) => {
      channel.socket.write(Buffer.concat([header, sealed]), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  function fail(channel, reason) {
    log?.('warn', 'novalink channel error', { reason });
    try { channel.socket.destroy(); } catch { /* already gone */ }
    if (channel.peer) {
      if (channels.get(channel.peer.peerId) === channel) channels.delete(channel.peer.peerId);
      events.emit('connection', { peer: channel.peer, state: 'error', reason });
    }
  }

  function handleInbound(socket) {
    socket.setNoDelay(true);
    // attachChannel owns the ephemeral handshake key and flips the channel to
    // 'secure' once both handshake frames have been exchanged.
    attachChannel(socket, 'inbound');
  }

  // --- discovery (UDP) ------------------------------------------------------
  function startDiscovery() {
    return new Promise((resolve) => {
      let settled = false;
      const settle = () => { if (!settled) { settled = true; resolve(); } };
      let socket;
      try {
        socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      } catch (error) {
        discoveryError = error.message;
        settle();
        return;
      }

      socket.on('error', (error) => {
        discoveryError = error.message;
        // A bind/send failure must not stall start(); resolve once and degrade.
        settle();
      });

      socket.on('message', (msg, rinfo) => {
        let packet;
        try {
          packet = JSON.parse(msg.toString('utf8'));
        } catch {
          return;
        }
        if (!packet || packet.magic !== DISCOVERY_MAGIC) return;
        if (packet.kind === 'probe') {
          // A newcomer is asking who is here; answer directly (unicast).
          replyAnnounce(socket, rinfo);
          return;
        }
        if (packet.kind === 'announce' && packet.peerId !== identity.peerId) {
          recordPeer({
            peerId: packet.peerId,
            fp: packet.fp,
            name: packet.name,
            host: rinfo.address,
            tcpPort: packet.tcpPort,
            kind: 'lan',
          });
        }
      });

      socket.bind(discoveryPort, () => {
        try { socket.setBroadcast(true); } catch { /* optional */ }
        try { socket.setMulticastLoopback(true); } catch { /* optional */ }
        try { socket.setMulticastTTL(2); socket.addMembership(MULTICAST_GROUP); } catch {
          // No multicast (some sandboxes / adapters): fall back to broadcast.
        }
        const announceTimer = setInterval(() => sendAnnounce(socket), ANNOUNCE_INTERVAL_MS);
        announceTimer.unref();
        discovery = { socket, announceTimer };
        // Probe once for immediate discovery of peers already on the link.
        sendProbe(socket);
        sendAnnounce(socket);
        settle();
      });
    });
  }

  function announcePacket() {
    return Buffer.from(JSON.stringify({
      magic: DISCOVERY_MAGIC,
      kind: 'announce',
      peerId: identity.peerId,
      fp: identity.fingerprint,
      name: identity.name,
      tcpPort: boundTcpPort,
    }), 'utf8');
  }

  function sendAnnounce(socket) {
    const data = announcePacket();
    const deliver = (host) => {
      try { socket.send(data, 0, data.length, discoveryPort, host, () => {}); } catch { /* best effort */ }
    };
    deliver(MULTICAST_GROUP);
    deliver('255.255.255.255'); // broadcast fallback for same-link peers
  }

  function sendProbe(socket) {
    const data = Buffer.from(JSON.stringify({ magic: DISCOVERY_MAGIC, kind: 'probe' }), 'utf8');
    try { socket.send(data, 0, data.length, discoveryPort, MULTICAST_GROUP, () => {}); } catch { /* best effort */ }
    try { socket.send(data, 0, data.length, discoveryPort, '255.255.255.255', () => {}); } catch { /* best effort */ }
  }

  function replyAnnounce(socket, rinfo) {
    if (!boundTcpPort) return;
    const data = announcePacket();
    try { socket.send(data, 0, data.length, rinfo.port, rinfo.address, () => {}); } catch { /* best effort */ }
  }

  // --- public Transport interface -------------------------------------------
  return {
    id: 'lan',
    label: 'Local network (Wi-Fi / Ethernet)',
    kind: 'lan',
    on: (event, cb) => events.on(event, cb),
    off: (event, cb) => events.off(event, cb),

    async getStatus() {
      return {
        available: started,
        supported: true,
        detail: `TCP :${boundTcpPort ?? '-'} · UDP :${discoveryPort}${discoveryError ? ` · discovery degraded (${discoveryError})` : ''}`,
      };
    },

    async start() {
      if (started) return;
      await startServer();
      await startDiscovery();
      started = true;
    },

    async stop() {
      started = false;
      for (const [, channel] of channels) {
        try { channel.socket.destroy(); } catch { /* ignore */ }
      }
      channels.clear();
      if (discovery) {
        clearInterval(discovery.announceTimer);
        try { discovery.socket.close(); } catch { /* ignore */ }
        discovery = null;
      }
      await new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      });
      server = null;
    },

    async scan() {
      if (discovery) {
        sendProbe(discovery.socket);
        sendAnnounce(discovery.socket);
        // Reap expired peers so "nearby" reflects reality.
        const now = Date.now();
        for (const [id, peer] of nearby) {
          if (now - peer.seenAt >= PEER_TTL_MS) nearby.delete(id);
        }
        publishPeers();
      }
    },

    /** Inject a known peer (manual connect, or deterministic testing). */
    addPeer(peer) {
      recordPeer(peer);
    },

    /** Open an encrypted TCP session to a discovered peer. */
    async connect(peerId) {
      const peer = nearby.get(peerId);
      if (!peer) throw new Error('That device is no longer in range.');
      if (channels.has(peerId) && channels.get(peerId).phase === 'secure') return channels.get(peerId).peer;
      const socket = net.connect(peer.tcpPort, peer.host);
      socket.setNoDelay(true);
      const channel = attachChannel(socket, 'outbound');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Connection timed out.')), 8000);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('error', (error) => { clearTimeout(timer); reject(error); });
      });
      return channel.peer;
    },

    async close(peerId) {
      const channel = channels.get(peerId);
      if (!channel) return { ok: false };
      try {
        if (channel.phase === 'secure') {
          await channel.send(makeMessage(identity.peerId, identity.fingerprint, MESSAGE_TYPES.BYE));
        }
      } catch { /* best effort */ }
      try { channel.socket.destroy(); } catch { /* ignore */ }
      channels.delete(peerId);
      events.emit('connection', { peer: channel.peer, state: 'closed' });
      return { ok: true };
    },

    send(peerId, envelope) {
      const channel = channels.get(peerId);
      if (!channel || channel.phase !== 'secure') {
        throw new Error('No open NovaLink channel with that peer.');
      }
      return channel.send(envelope);
    },

    listPeers: () => [...nearby.values()],
    connectedIds: () => [...channels.keys()],
    tcpPort: () => boundTcpPort,
  };
}

module.exports = { createLocalTransport, DEFAULT_DISCOVERY_PORT, MULTICAST_GROUP };
