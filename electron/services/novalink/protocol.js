/**
 * NovaLink wire protocol (transport-agnostic).
 *
 * NovaLink messages are small structured envelopes exchanged between two
 * NovaCode instances. This module is deliberately free of sockets, Electron,
 * and the filesystem so it can be unit tested in isolation and reused by any
 * transport (the local-network transport today, a Bluetooth transport later).
 *
 * On the wire an envelope is a single JSON object prefixed by its big-endian
 * byte length (a 4-byte header). Framing matters because the local-network
 * transport multiplexes many messages over one TCP stream and a chunked file
 * transfer must never bleed into the next message.
 */
const crypto = require('crypto');

const PROTOCOL_VERSION = 1;

// Every envelope carries these fields:
//   { v, id, from, fp, type, ts, ...typeSpecific }
// `id` is globally unique and used for duplicate suppression + acks.
// `fp`  is the sender's cryptographic fingerprint (its identity), bound to
//        the authenticated transport channel — never a Bluetooth/mDNS name.
const MESSAGE_TYPES = Object.freeze({
  HELLO: 'hello', // first frame on a fresh channel; announces peer identity
  PAIR_REQUEST: 'pair-request', // "I'd like to connect with you"
  PAIR_ACCEPT: 'pair-accept',
  PAIR_REJECT: 'pair-reject',
  TEXT: 'text', // developer-to-developer chat
  CODE: 'code', // code snippet with a language id
  FILE_META: 'file-meta', // file-transfer offer: name, size, sha256
  FILE_CHUNK: 'file-chunk', // base64 chunk of the offered file
  FILE_DONE: 'file-done', // end-of-stream with the final digest
  ACK: 'ack', // acknowledgement of a received message / transfer
  ERROR: 'error', // something the peer must know failed
  CANCEL: 'cancel', // sender or receiver aborted a transfer
  BYE: 'bye', // graceful disconnect
});

const LIMITS = Object.freeze({
  // A single envelope cap keeps memory bounded even under a hostile peer.
  MAX_FRAME_BYTES: 4 * 1024 * 1024, // 4 MB per message (chunk payloads stay well under)
  // Total received file size we are willing to buffer for an incoming transfer.
  MAX_FILE_BYTES: 25 * 1024 * 1024, // 25 MB
  // Text/code chat payloads.
  MAX_TEXT_BYTES: 200 * 1024, // 200 KB
  // File chunks on the wire.
  CHUNK_BYTES: 64 * 1024, // 64 KB of raw bytes per chunk
  // Duplicate suppression window.
  DEDUPE_CAPACITY: 4096,
  // Pending pairing requests expire if the local user never answers.
  PAIR_TIMEOUT_MS: 60_000,
  // An in-flight transfer with no chunk activity for this long is failed.
  TRANSFER_IDLE_TIMEOUT_MS: 60_000,
});

function newId() {
  return crypto.randomUUID();
}

/**
 * SHA-256 hex digest of a buffer, used for transfer integrity.
 * @param {Buffer|string} data
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Build a well-formed envelope with sensible defaults filled in. */
function makeMessage(from, fp, type, fields = {}) {
  return {
    v: PROTOCOL_VERSION,
    id: fields.id || newId(),
    from,
    fp,
    type,
    ts: Date.now(),
    ...fields,
  };
}

/**
 * Encode one envelope into a length-prefixed frame.
 * Throws when a message is absurdly large so callers fail fast rather than
 * buffering an unbounded payload.
 * @param {object} message
 * @returns {Buffer}
 */
function encodeFrame(message) {
  if (!message || typeof message !== 'object') {
    throw new Error('NovaLink frame requires a message object.');
  }
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  if (json.length > LIMITS.MAX_FRAME_BYTES) {
    throw new Error(`NovaLink message exceeds ${LIMITS.MAX_FRAME_BYTES} bytes.`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

/**
 * A streaming frame reader. Feed it raw chunks; it emits complete decoded
 * envelopes as they arrive and tolerates partial/coalesced frames.
 *
 * @param {(message: object) => void} onMessage  called once per decoded envelope
 * @param {{ onError?: (err: Error) => void }} [hooks]
 * @returns {{ push: (chunk: Buffer) => void, reset: () => void, pending: () => number }}
 */
function createFrameReader(onMessage, hooks = {}) {
  let buffer = Buffer.alloc(0);
  const fail = hooks.onError || (() => {});

  function push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

    // Drain every whole frame currently available in the buffer.
    for (;;) {
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length > LIMITS.MAX_FRAME_BYTES) {
        buffer = Buffer.alloc(0);
        fail(new Error(`NovaLink frame too large: ${length} bytes.`));
        return;
      }
      if (buffer.length < 4 + length) return; // wait for more bytes
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      try {
        onMessage(JSON.parse(body.toString('utf8')));
      } catch (error) {
        fail(new Error(`NovaLink malformed frame: ${error.message}`));
      }
    }
  }

  return {
    push,
    reset: () => { buffer = Buffer.alloc(0); },
    pending: () => buffer.length,
  };
}

/**
 * Bounded least-recently-seen set for duplicate-envelope suppression.
 * A message id already seen is never processed twice.
 */
class MessageDeduper {
  constructor(capacity = LIMITS.DEDUPE_CAPACITY) {
    this.capacity = capacity;
    this.seen = new Set();
  }

  /** @returns {boolean} true when this id is new (and is now recorded). */
  accept(id) {
    if (typeof id !== 'string' || !id) return false;
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > this.capacity) {
      // Evict the oldest insertion (Set preserves insertion order).
      const oldest = this.seen.values().next().value;
      this.seen.delete(oldest);
    }
    return true;
  }

  clear() {
    this.seen.clear();
  }
}

/** Validate that a value looks like a parsed envelope; returns the type or null. */
function readMessageType(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.v !== PROTOCOL_VERSION) return null;
  if (typeof message.type !== 'string') return null;
  if (typeof message.id !== 'string') return null;
  return message.type;
}

module.exports = {
  PROTOCOL_VERSION,
  MESSAGE_TYPES,
  LIMITS,
  newId,
  sha256,
  makeMessage,
  encodeFrame,
  createFrameReader,
  MessageDeduper,
  readMessageType,
};
