/**
 * NovaLink collaboration service (main process).
 *
 * Sits above the transport abstraction and owns ALL collaboration state the
 * UI renders: identity, nearby devices, pairing (explicit user approval), the
 * connected-peer list, developer chat, and safe code/file sharing. It never
 * touches sockets itself — it drives whatever transports it is handed
 * (local-network today; Bluetooth is a real-but-unsupported transport), so the
 * two concerns stay independent and testable.
 *
 * Safety rules baked in here (map to the NovaLink spec §4/§5):
 *   • Sharing is always sender-initiated; the receiver must approve an incoming
 *     transfer before a single byte is accepted.
 *   • Received files are buffered in memory only up to a size cap, verified
 *     against the offered SHA-256, previewed, and written ONLY into a
 *     user-chosen folder inside the workspace, resolved through pathGuard so a
 *     hostile "../" name can never escape the workspace.
 *   • Received code is displayed/previewed, never executed or auto-saved.
 *   • Existing files are never overwritten without an explicit overwrite flag.
 *   • Device names are treated as labels only; peer identity is the transport
 *     handshake fingerprint.
 */
const path = require('path');
const fsp = require('fs').promises;
const crypto = require('crypto');

const {
  MESSAGE_TYPES,
  LIMITS,
  makeMessage,
  newId,
  sha256,
  MessageDeduper,
  readMessageType,
} = require('./protocol');
const { resolveWithin, assertPlainName } = require('../pathGuard');

const MAX_CHAT_PER_PEER = 300;
const TEXT_PREVIEW_BYTES = 256 * 1024; // preview text files up to 256 KB in the UI

function isProbablyText(name, buffer) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (/\.(js|mjs|cjs|ts|jsx|tsx|json|md|markdown|txt|css|scss|html|htm|xml|yml|yaml|toml|ini|cfg|conf|sh|ps1|bat|cmd|py|rb|go|rs|java|c|h|cpp|hpp|csv|env|gitignore|sql)$/.test(ext)) {
    return true;
  }
  // Heuristic: no NUL bytes in the first 8 KB.
  const head = buffer.subarray(0, 8192);
  return !head.includes(0);
}

function createNovaLinkService({ identity, transports = [], logger = console, onEvent = () => {} }) {
  const log = (level, message, meta) => {
    if (logger && typeof logger[level] === 'function') logger[level](message, meta);
  };

  // --- state ---------------------------------------------------------------
  const state = {
    ready: false,
    scanning: false,
    activeTransport: null,
    nearby: new Map(), // peerId -> { peerId, fp, name, kind, host }
    incoming: new Map(), // peerId -> { peerId, name, fp, ts, expiresAt } (pairing offers to US)
    outgoing: new Map(), // peerId -> { peerId, name, fp, ts } (offers WE sent, awaiting accept)
    peers: new Map(), // peerId -> { peerId, name, fp, kind, connectedAt }
    transportFor: new Map(), // peerId -> transportId (who carries this peer)
    pendingConnect: new Set(), // peerIds the user asked to connect (send pair-request on open)
    chats: new Map(), // peerId -> [ message ]
    transfers: new Map(), // transferId -> Transfer
    bluetooth: null, // { power, devices, lastEnable, scannedAt } — OS-visible discovery, not peers
  };
  const deduper = new MessageDeduper();
  const timers = new Map(); // transferId -> idle timer

  function snapshot() {
    return {
      ready: state.ready,
      scanning: state.scanning,
      activeTransport: state.activeTransport,
      identity: { peerId: identity.peerId, fingerprint: identity.fingerprint, name: identity.name },
      transports: [], // filled by getStatus (async)
      nearby: [...state.nearby.values()],
      requests: {
        incoming: [...state.incoming.values()],
        outgoing: [...state.outgoing.values()],
      },
      peers: [...state.peers.values()],
      chats: Object.fromEntries([...state.chats.entries()].map(([k, v]) => [k, v])),
      transfers: [...state.transfers.values()].map((t) => ({
        id: t.id,
        peerId: t.peerId,
        peerName: t.peerName,
        direction: t.direction,
        kind: t.kind,
        name: t.name,
        size: t.size,
        received: t.received,
        sha256: t.sha256,
        status: t.status,
        preview: t.preview,
        savedPath: t.savedPath,
        error: t.error,
        ts: t.ts,
      })),
      bluetooth: state.bluetooth,
    };
  }

  let emitQueued = false;
  function emitState() {
    if (emitQueued) return;
    emitQueued = true;
    setImmediate(() => {
      emitQueued = false;
      onEvent(snapshot());
    });
  }

  // --- transport plumbing --------------------------------------------------
  function byTransport(peerId) {
    const id = state.transportFor.get(peerId);
    return transports.find((t) => t.id === id);
  }

  function attach(transport) {
    transport.on('peers', (peers) => {
      // Replace nearby set for this transport's kind; other transports kept.
      for (const [id, p] of [...state.nearby]) {
        if (p.kind === transport.kind && !peers.some((x) => x.peerId === id)) state.nearby.delete(id);
      }
      for (const p of peers) {
        if (p.peerId === identity.peerId) continue;
        state.nearby.set(p.peerId, {
          peerId: p.peerId, fp: p.fp, name: p.name || 'peer', kind: transport.kind, host: p.host,
        });
      }
      emitState();
    });

    transport.on('connection', ({ peer, state: connState, reason }) => {
      if (!peer) return;
      if (connState === 'open') {
        state.transportFor.set(peer.peerId, transport.id);
        // If the user asked to reach this peer, offer pairing now.
        if (state.pendingConnect.has(peer.peerId)) {
          state.pendingConnect.delete(peer.peerId);
          sendPairRequest(transport, peer);
        }
        emitState();
      } else if (connState === 'closed' || connState === 'error') {
        dropPeer(peer.peerId, connState === 'error' ? reason : undefined);
      }
    });

    transport.on('message', ({ peer, message }) => {
      try {
        handleMessage(transport, peer, message);
      } catch (error) {
        log?.('error', 'novalink message handling failed', { error: error.message });
      }
    });

    transport.on('error', ({ message }) => {
      log?.('warn', 'novalink transport error', { transport: transport.id, message });
    });
  }

  // --- messaging -----------------------------------------------------------
  function send(peerId, fields) {
    const transport = byTransport(peerId);
    if (!transport) throw new Error('That peer is not connected.');
    const envelope = makeMessage(identity.peerId, identity.fingerprint, fields.type, fields);
    return transport.send(peerId, envelope);
  }

  function sendPairRequest(transport, peer) {
    const name = state.nearby.get(peer.peerId)?.name || peer.name;
    state.outgoing.set(peer.peerId, { peerId: peer.peerId, name, fp: peer.fp, ts: Date.now() });
    transport.send(peer.peerId, makeMessage(identity.peerId, identity.fingerprint, MESSAGE_TYPES.PAIR_REQUEST, { name: identity.name }));
    emitState();
  }

  function addChat(peerId, entry) {
    if (!state.chats.has(peerId)) state.chats.set(peerId, []);
    const list = state.chats.get(peerId);
    list.push(entry);
    if (list.length > MAX_CHAT_PER_PEER) list.splice(0, list.length - MAX_CHAT_PER_PEER);
  }

  function requireConnected(peerId) {
    if (!state.peers.has(peerId)) throw new Error('Connect with that developer first.');
  }

  // --- incoming transfer helpers -------------------------------------------
  function clearTransferTimer(transferId) {
    const timer = timers.get(transferId);
    if (timer) { clearTimeout(timer); timers.delete(transferId); }
  }

  function armTransferTimeout(transfer) {
    clearTransferTimer(transfer.id);
    const timer = setTimeout(() => {
      transfer.status = 'failed';
      transfer.error = 'Transfer timed out (no data received).';
      clearTransferTimer(transfer.id);
      emitState();
    }, LIMITS.TRANSFER_IDLE_TIMEOUT_MS);
    timer.unref?.();
    timers.set(transfer.id, timer);
  }

  function getTransfer(transferId) {
    if (typeof transferId !== 'string') return null;
    return state.transfers.get(transferId) || null;
  }

  // --- message dispatch ----------------------------------------------------
  function handleMessage(transport, peer, message) {
    const type = readMessageType(message);
    if (!type) return;
    // Identity is the handshake fingerprint; ignore the name claim.
    const peerId = peer.peerId;

    // Acks/cancels/errors reference a transferId, not necessarily a new id.
    if (type !== MESSAGE_TYPES.FILE_CHUNK) {
      if (!deduper.accept(message.id)) return; // duplicate envelope
    }

    switch (type) {
      case MESSAGE_TYPES.HELLO:
        // Peer announced its display name; store it (label only).
        labelPeer(peerId, message.name);
        break;

      case MESSAGE_TYPES.PAIR_REQUEST: {
        if (state.peers.has(peerId)) break; // already paired
        state.incoming.set(peerId, {
          peerId, name: message.name || peer.name || 'peer', fp: peer.fp, ts: Date.now(),
          expiresAt: Date.now() + LIMITS.PAIR_TIMEOUT_MS,
        });
        armPairTimeout(peerId);
        emitState();
        break;
      }

      case MESSAGE_TYPES.PAIR_ACCEPT: {
        state.outgoing.delete(peerId);
        markConnected(peer, transport, message.name);
        emitState();
        break;
      }

      case MESSAGE_TYPES.PAIR_REJECT: {
        state.outgoing.delete(peerId);
        state.pendingConnect.delete(peerId);
        emitState();
        break;
      }

      case MESSAGE_TYPES.TEXT: {
        if (!requireConnectedForMessage(peerId)) break;
        addChat(peerId, {
          id: message.id, from: 'peer', kind: 'text', text: clampText(message.text), ts: message.ts || Date.now(),
        });
        ack(peerId, message.id);
        emitState();
        break;
      }

      case MESSAGE_TYPES.CODE: {
        if (!requireConnectedForMessage(peerId)) break;
        addChat(peerId, {
          id: message.id, from: 'peer', kind: 'code',
          text: clampText(message.text), language: safeName(message.language, 40), path: safeName(message.path, 200),
          ts: message.ts || Date.now(),
        });
        ack(peerId, message.id);
        emitState();
        break;
      }

      case MESSAGE_TYPES.FILE_META: {
        if (!requireConnectedForMessage(peerId)) break;
        startIncomingTransfer(peer, transport, message);
        break;
      }

      case MESSAGE_TYPES.FILE_CHUNK: {
        appendChunk(peerId, message);
        break;
      }

      case MESSAGE_TYPES.FILE_DONE: {
        finishIncomingTransfer(peerId, message);
        break;
      }

      case MESSAGE_TYPES.ACK: {
        handleAck(peerId, message);
        break;
      }

      case MESSAGE_TYPES.CANCEL: {
        const transfer = getTransfer(message.transferId);
        if (transfer) {
          transfer.status = 'cancelled';
          clearTransferTimer(transfer.id);
          emitState();
        }
        break;
      }

      case MESSAGE_TYPES.ERROR: {
        const transfer = getTransfer(message.transferId);
        if (transfer) { transfer.status = 'failed'; transfer.error = clampText(message.message) || 'Peer reported an error.'; emitState(); }
        break;
      }

      case MESSAGE_TYPES.BYE:
        dropPeer(peerId);
        break;

      default:
        break;
    }
  }

  function requireConnectedForMessage(peerId) {
    // Peer must be paired (user-approved) before semantic messages are honored.
    if (!state.peers.has(peerId)) {
      // Silently ignore unsolicited payloads from unpaired devices.
      return false;
    }
    return true;
  }

  function labelPeer(peerId, name) {
    const clean = name ? safeName(name, 60) : null;
    if (!clean) return;
    const peer = state.peers.get(peerId);
    if (peer) peer.name = clean;
    const near = state.nearby.get(peerId);
    if (near) near.name = clean;
  }

  function ack(peerId, refId) {
    try { send(peerId, { type: MESSAGE_TYPES.ACK, refId }); } catch { /* peer may have gone */ }
  }

  function clampText(value) {
    if (typeof value !== 'string') return '';
    return value.length > LIMITS.MAX_TEXT_BYTES ? value.slice(0, LIMITS.MAX_TEXT_BYTES) : value;
  }

  function safeName(value, max) {
    if (typeof value !== 'string') return '';
    return value.replace(/[^\w.\- ]/g, '').slice(0, max);
  }

  // --- pairing lifecycle ---------------------------------------------------
  function armPairTimeout(peerId) {
    const req = state.incoming.get(peerId);
    if (!req) return;
    const delay = Math.max(0, req.expiresAt - Date.now());
    const timer = setTimeout(() => {
      if (state.incoming.get(peerId) === req) {
        state.incoming.delete(peerId);
        emitState();
      }
    }, delay);
    timer.unref?.();
  }

  function markConnected(peer, transport, displayName) {
    const peerId = peer.peerId;
    state.transportFor.set(peerId, transport.id);
    if (!state.activeTransport) state.activeTransport = transport.id;
    const existing = state.peers.get(peerId) || {};
    state.peers.set(peerId, {
      peerId,
      name: displayName || existing.name || state.nearby.get(peerId)?.name || peer.name || 'peer',
      fp: peer.fp,
      kind: transport.kind,
      connectedAt: existing.connectedAt || Date.now(),
    });
    state.incoming.delete(peerId);
    state.nearby.delete(peerId);
    // Greet the freshly-paired peer so names sync both ways.
    try { transport.send(peerId, makeMessage(identity.peerId, identity.fingerprint, MESSAGE_TYPES.HELLO, { name: identity.name })); } catch { /* ignore */ }
  }

  function dropPeer(peerId, reason) {
    state.peers.delete(peerId);
    state.outgoing.delete(peerId);
    state.incoming.delete(peerId);
    state.pendingConnect.delete(peerId);
    state.transportFor.delete(peerId);
    // Interrupt any in-flight transfer with this peer.
    for (const transfer of state.transfers.values()) {
      if (transfer.peerId !== peerId) continue;
      if (['pending', 'offered', 'receiving', 'transferring', 'sent', 'received'].includes(transfer.status)) {
        transfer.status = 'failed';
        transfer.error = reason ? 'Connection lost mid-transfer.' : 'Peer disconnected before the transfer finished.';
        clearTransferTimer(transfer.id);
      }
    }
    emitState();
  }

  // --- transfers -----------------------------------------------------------
  function startIncomingTransfer(peer, transport, message) {
    const peerId = peer.peerId;
    const transferId = message.transferId;
    if (typeof transferId !== 'string') return;
    if (state.transfers.has(transferId)) return; // duplicate offer
    const size = Number(message.size);
    const name = safeName(message.name, 120) || 'shared-file';
    const hashOk = /^[0-9a-f]{64}$/i.test(String(message.sha256 || ''));

    const transfer = {
      id: transferId,
      peerId,
      peerName: state.peers.get(peerId)?.name || peer.name || 'peer',
      transportId: transport.id,
      direction: 'in',
      kind: 'file',
      name,
      size: Number.isFinite(size) ? size : 0,
      sha256: hashOk ? String(message.sha256).toLowerCase() : null,
      received: 0,
      status: 'pending', // awaiting the local user's approval to receive
      preview: null,
      savedPath: null,
      chunks: [],
      hash: crypto.createHash('sha256'),
      expectedIndex: 0,
    };

    // Reject oversized offers up-front; still record so the UI shows why.
    if (!Number.isFinite(size) || size <= 0 || size > LIMITS.MAX_FILE_BYTES) {
      transfer.status = 'failed';
      transfer.error = size > LIMITS.MAX_FILE_BYTES
        ? `File is too large (${(size / 1048576).toFixed(1)} MB; limit ${LIMITS.MAX_FILE_BYTES / 1048576} MB).`
        : 'Invalid file size offered.';
      state.transfers.set(transferId, transfer);
      try { transport.send(peerId, makeMessage(identity.peerId, identity.fingerprint, MESSAGE_TYPES.ACK, { refId: message.id, transferId, status: 'rejected' })); } catch { /* ignore */ }
      emitState();
      return;
    }

    state.transfers.set(transferId, transfer);
    emitState(); // show the offer with name/size/source for approval
  }

  function appendChunk(peerId, message) {
    const transfer = getTransfer(message.transferId);
    if (!transfer || transfer.direction !== 'in') return;
    if (transfer.status !== 'receiving') return; // not approved yet → drop bytes
    if (message.index !== transfer.expectedIndex) {
      failTransfer(transfer, 'Transfer chunks arrived out of order.');
      return;
    }
    let data;
    try { data = Buffer.from(message.data, 'base64'); } catch { return; }
    if (transfer.received + data.length > LIMITS.MAX_FILE_BYTES || transfer.received + data.length > transfer.size) {
      failTransfer(transfer, 'Transfer exceeded the offered size.');
      return;
    }
    transfer.chunks.push(data);
    transfer.hash.update(data);
    transfer.received += data.length;
    transfer.expectedIndex += 1;
    armTransferTimeout(transfer);
    emitState();
  }

  function finishIncomingTransfer(peerId, message) {
    const transfer = getTransfer(message.transferId);
    if (!transfer || transfer.direction !== 'in') return;
    clearTransferTimer(transfer.id);
    if (transfer.status !== 'receiving') return;
    const digest = transfer.hash.digest('hex');
    transfer.receivedBuffer = Buffer.concat(transfer.chunks);
    delete transfer.chunks;
    delete transfer.hash;

    if (transfer.sha256 && digest !== transfer.sha256) {
      failTransfer(transfer, 'Integrity check failed (checksum mismatch).');
      return;
    }
    if (transfer.received !== transfer.size) {
      failTransfer(transfer, 'Integrity check failed (size mismatch).');
      return;
    }

    // Received + verified into staging. Preview text; await explicit SAVE.
    transfer.status = 'received';
    if (isProbablyText(transfer.name, transfer.receivedBuffer) && transfer.size <= TEXT_PREVIEW_BYTES) {
      transfer.preview = transfer.receivedBuffer.toString('utf8').slice(0, TEXT_PREVIEW_BYTES);
    }
    ack(peerId, message.id);
    emitState();
  }

  function failTransfer(transfer, error) {
    transfer.status = 'failed';
    transfer.error = error;
    clearTransferTimer(transfer.id);
    emitState();
  }

  function handleAck(peerId, message) {
    const transfer = getTransfer(message.transferId);
    if (!transfer || transfer.direction !== 'out') return;
    if (message.status === 'ready') {
      streamOutgoingTransfer(transfer).catch((error) => failTransfer(transfer, error.message));
    } else if (message.status === 'rejected') {
      transfer.status = 'rejected';
      transfer.error = 'The developer declined the transfer.';
      clearTransferTimer(transfer.id);
      emitState();
    } else if (message.status === 'received' || message.status === 'saved') {
      transfer.status = 'complete';
      clearTransferTimer(transfer.id);
      emitState();
    }
  }

  async function streamOutgoingTransfer(transfer) {
    const transport = transports.find((t) => t.id === transfer.transportId);
    if (!transport) return failTransfer(transfer, 'Transport is no longer available.');
    transfer.status = 'transferring';
    emitState();
    const buffer = transfer.buffer;
    const total = buffer.length;
    let index = 0;
    for (let offset = 0; offset < total; offset += LIMITS.CHUNK_BYTES, index += 1) {
      const slice = buffer.subarray(offset, Math.min(offset + LIMITS.CHUNK_BYTES, total));
      await transport.send(transfer.peerId, makeMessage(
        identity.peerId, identity.fingerprint, MESSAGE_TYPES.FILE_CHUNK,
        { transferId: transfer.id, index, data: slice.toString('base64') },
      ));
      transfer.sent = offset + slice.length;
      if (index % 4 === 0) emitState();
    }
    delete transfer.buffer;
    await transport.send(transfer.peerId, makeMessage(
      identity.peerId, identity.fingerprint, MESSAGE_TYPES.FILE_DONE,
      { transferId: transfer.id, sha256: transfer.sha256 },
    ));
    transfer.status = 'sent';
    emitState();
  }

  // --- public API (used by IPC handlers) -----------------------------------
  return {
    snapshot,

    async getStatus() {
      const statuses = [];
      for (const transport of transports) {
        try {
          const base = await transport.getStatus();
          statuses.push({ id: transport.id, label: transport.label, kind: transport.kind, ...base });
        } catch (error) {
          statuses.push({ id: transport.id, label: transport.label, kind: transport.kind, available: false, supported: false, reason: error.message });
        }
      }
      return { ...snapshot(), transports: statuses };
    },

    async start() {
      for (const transport of transports) {
        attach(transport);
        try { await transport.start(); } catch (error) { log?.('error', 'novalink transport start failed', { transport: transport.id, error: error.message }); }
      }
      state.ready = true;
      emitState();
    },

    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const transport of transports) {
        try { transport.stop?.(); } catch { /* ignore */ }
      }
      state.ready = false;
    },

    async discover() {
      state.scanning = true;
      emitState();
      for (const transport of transports) {
        try { await transport.scan(); } catch (error) { log?.('warn', 'novalink scan failed', { transport: transport.id, error: error.message }); }
      }
    },

    stopScan() {
      state.scanning = false;
      emitState();
    },

    /** Turn the OS Bluetooth radio on (real adapter, honest fallback). */
    async enableBluetooth() {
      const transport = transports.find((t) => t.kind === 'bluetooth');
      if (!transport?.enable) throw new Error('No Bluetooth transport is available on this device.');
      const result = await transport.enable();
      state.bluetooth = { ...(state.bluetooth || {}), power: result.power || null, lastEnable: { ...result, at: Date.now() } };
      if (result.ok) {
        // Reflect the new radio state immediately so the UI can scan next.
        const scan = await transport.scanDevices().catch(() => null);
        if (scan) state.bluetooth = { ...state.bluetooth, power: scan.power, devices: scan.devices, scannedAt: scan.scannedAt };
      }
      emitState();
      return result;
    },

    /**
     * Enumerate every Bluetooth device the OS can see (any device, not just
     * NovaCode). These are NOT NovaLink peers — messaging over Bluetooth
     * remains unsupported and is labelled that way in the UI.
     */
    async scanBluetoothDevices() {
      const transport = transports.find((t) => t.kind === 'bluetooth');
      if (!transport?.scanDevices) throw new Error('No Bluetooth transport is available on this device.');
      const scan = await transport.scanDevices();
      if (scan.power === 'off' || scan.power === 'absent') {
        state.bluetooth = { ...(state.bluetooth || {}), power: scan.power, devices: [], scannedAt: scan.scannedAt, detail: scan.detail };
        emitState();
        throw new Error(scan.power === 'off'
          ? 'Bluetooth is switched off — enable it first, then scan.'
          : 'No Bluetooth adapter was found on this device.');
      }
      state.bluetooth = {
        power: scan.power,
        devices: scan.devices,
        scannedAt: scan.scannedAt,
        detail: scan.detail || null,
        lastEnable: state.bluetooth?.lastEnable || null,
      };
      emitState();
      return scan;
    },

    /** User clicked "Connect" on a nearby device. */
    async connect(peerId) {
      const near = state.nearby.get(peerId);
      if (!near) throw new Error('That device is no longer in range.');
      // Only transports that support data can connect; Bluetooth will reject.
      const transport = transports.find((t) => t.kind === near.kind && (t.supported !== false));
      if (!transport) throw new Error('No supported transport can reach that device.');
      state.pendingConnect.add(peerId);
      await transport.connect(peerId);
      // sendPairRequest fires from the transport 'connection:open' event.
      return { ok: true };
    },

    acceptConnection(peerId) {
      const req = state.incoming.get(peerId);
      if (!req) throw new Error('That connection request is no longer pending.');
      const peer = { peerId, fp: req.fp, name: req.name };
      const transport = transports.find((t) => t.id === (state.transportFor.get(peerId)));
      if (!transport) throw new Error('Connection already closed.');
      markConnected(peer, transport, req.name);
      try { transport.send(peerId, makeMessage(identity.peerId, identity.fingerprint, MESSAGE_TYPES.PAIR_ACCEPT, { name: identity.name })); } catch { /* ignore */ }
      emitState();
      return { ok: true };
    },

    rejectConnection(peerId) {
      const transport = byTransport(peerId);
      state.incoming.delete(peerId);
      if (transport) {
        try { transport.send(peerId, makeMessage(identity.peerId, identity.fingerprint, MESSAGE_TYPES.PAIR_REJECT, {})); } catch { /* ignore */ }
        try { transport.close(peerId); } catch { /* ignore */ }
      }
      emitState();
      return { ok: true };
    },

    disconnect(peerId) {
      const transport = byTransport(peerId);
      if (transport) {
        try { transport.send(peerId, makeMessage(identity.peerId, identity.fingerprint, MESSAGE_TYPES.BYE, {})); } catch { /* ignore */ }
        try { transport.close(peerId); } catch { /* ignore */ }
      }
      dropPeer(peerId);
      return { ok: true };
    },

    async sendMessage(peerId, text) {
      requireConnected(peerId);
      const clean = clampText(text).trim();
      if (!clean) throw new Error('Write a message first.');
      const entry = { id: newId(), from: 'me', kind: 'text', text: clean, ts: Date.now(), delivery: 'sent' };
      addChat(peerId, entry);
      emitState();
      await send(peerId, { type: MESSAGE_TYPES.TEXT, text: clean, id: entry.id });
      return { ok: true, id: entry.id };
    },

    async shareCode({ peerId, text, language, path: filePath }) {
      requireConnected(peerId);
      const clean = clampText(text);
      if (!clean.trim()) throw new Error('There is no code to share yet.');
      const entry = { id: newId(), from: 'me', kind: 'code', text: clean, language: safeName(language, 40), path: safeName(filePath, 200), ts: Date.now(), delivery: 'sent' };
      addChat(peerId, entry);
      emitState();
      await send(peerId, { type: MESSAGE_TYPES.CODE, text: clean, language: entry.language, path: entry.path, id: entry.id });
      return { ok: true, id: entry.id };
    },

    /** Share a file from the sender's workspace (workspace-confined read). */
    async shareFile({ peerId, root, path: filePath }) {
      requireConnected(peerId);
      if (!root) throw new Error('Open a folder first.');
      const abs = resolveWithin(root, filePath);
      const stat = await fsp.stat(abs);
      if (!stat.isFile()) throw new Error('That item is not a file.');
      if (stat.size <= 0) throw new Error('That file is empty.');
      if (stat.size > LIMITS.MAX_FILE_BYTES) {
        throw new Error(`File is too large (${(stat.size / 1048576).toFixed(1)} MB; limit ${LIMITS.MAX_FILE_BYTES / 1048576} MB).`);
      }
      const buffer = await fsp.readFile(abs);
      const digest = sha256(buffer);
      const transport = byTransport(peerId);
      const transfer = {
        id: newId(),
        peerId,
        peerName: state.peers.get(peerId)?.name || 'peer',
        transportId: transport.id,
        direction: 'out',
        kind: 'file',
        name: path.basename(abs),
        size: buffer.length,
        sha256: digest,
        received: 0,
        sent: 0,
        status: 'offered',
        preview: null,
        savedPath: null,
        buffer,
        ts: Date.now(),
      };
      state.transfers.set(transfer.id, transfer);
      // Timeout if the receiver never approves.
      const timer = setTimeout(() => {
        if (transfer.status === 'offered') { transfer.status = 'cancelled'; transfer.error = 'The developer did not respond.'; emitState(); }
      }, LIMITS.PAIR_TIMEOUT_MS);
      timer.unref?.();
      timers.set(transfer.id, timer);
      emitState();
      await transport.send(peerId, makeMessage(identity.peerId, identity.fingerprint, MESSAGE_TYPES.FILE_META, {
        transferId: transfer.id, name: transfer.name, size: transfer.size, sha256: transfer.sha256,
      }));
      return { ok: true, transferId: transfer.id };
    },

    /** Receiver approves an incoming transfer offer → begin accepting bytes. */
    acceptTransfer(transferId) {
      const transfer = getTransfer(transferId);
      if (!transfer || transfer.direction !== 'in') throw new Error('That transfer is no longer available.');
      if (transfer.status !== 'pending') return { ok: true };
      transfer.status = 'receiving';
      armTransferTimeout(transfer);
      const transport = transports.find((t) => t.id === transfer.transportId);
      if (transport) {
        try { transport.send(transfer.peerId, makeMessage(identity.peerId, identity.fingerprint, MESSAGE_TYPES.ACK, { transferId, status: 'ready' })); } catch { /* ignore */ }
      }
      emitState();
      return { ok: true };
    },

    rejectTransfer(transferId) {
      const transfer = getTransfer(transferId);
      if (!transfer) return { ok: true };
      transfer.status = 'rejected';
      clearTransferTimer(transfer.id);
      const transport = transports.find((t) => t.id === transfer.transportId);
      if (transport) {
        try { transport.send(transfer.peerId, makeMessage(identity.peerId, identity.fingerprint, MESSAGE_TYPES.ACK, { transferId, status: 'rejected' })); } catch { /* ignore */ }
      }
      delete transfer.receivedBuffer;
      emitState();
      return { ok: true };
    },

    cancelTransfer(transferId) {
      const transfer = getTransfer(transferId);
      if (!transfer) return { ok: true };
      if (transfer.status !== 'complete' && transfer.status !== 'received') transfer.status = 'cancelled';
      clearTransferTimer(transfer.id);
      const transport = transports.find((t) => t.id === transfer.transportId);
      if (transport) {
        try { transport.send(transfer.peerId, makeMessage(identity.peerId, identity.fingerprint, MESSAGE_TYPES.CANCEL, { transferId })); } catch { /* ignore */ }
      }
      emitState();
      return { ok: true };
    },

    /** Receiver chooses a destination inside the workspace and saves the file. */
    async saveTransfer(transferId, { root, dir, name, overwrite = false } = {}) {
      const transfer = getTransfer(transferId);
      if (!transfer || transfer.direction !== 'in') throw new Error('That transfer is no longer available.');
      if (transfer.status !== 'received') throw new Error('Wait for the transfer to finish receiving first.');
      if (!root) throw new Error('Open a folder first.');
      if (!Buffer.isBuffer(transfer.receivedBuffer)) throw new Error('The received data is no longer buffered.');

      const cleanName = assertPlainName(name || transfer.name);
      const baseDir = resolveWithin(root, dir || root);
      const target = resolveWithin(root, path.join(baseDir, cleanName)); // re-prove inside root

      // Never overwrite without explicit approval.
      let exists = true;
      try { await fsp.access(target); } catch { exists = false; }
      if (exists && !overwrite) {
        throw new Error(`"${cleanName}" already exists. Choose a new name or approve overwriting.`);
      }

      await fsp.mkdir(path.dirname(target), { recursive: true });
      // exists && !overwrite already threw above, so here: create exclusive,
      // or (approved overwrite) truncate-and-write.
      await fsp.writeFile(target, transfer.receivedBuffer, { flag: exists ? 'w' : 'wx' });
      transfer.savedPath = target;
      transfer.status = 'complete';
      const digest = sha256(transfer.receivedBuffer);
      if (transfer.sha256 && digest !== transfer.sha256) {
        transfer.status = 'failed';
        transfer.error = 'Saved file failed its checksum; do not trust it.';
      }
      delete transfer.receivedBuffer;
      const transport = transports.find((t) => t.id === transfer.transportId);
      if (transport) {
        try { transport.send(transfer.peerId, makeMessage(identity.peerId, identity.fingerprint, MESSAGE_TYPES.ACK, { transferId, status: 'saved' })); } catch { /* ignore */ }
      }
      emitState();
      return { ok: true, path: target };
    },
  };
}

module.exports = { createNovaLinkService, isProbablyText, MAX_CHAT_PER_PEER };
