'use strict';
/**
 * A dependency-free WebSocket (RFC 6455) server transport.
 *
 * Why hand-rolled: `link-server` has no npm dependencies and cannot install any
 * on the machine this was developed on, and the desktop client is Node's built-in
 * standards-compliant `WebSocket`. That combination is what makes this file
 * trustworthy rather than brave: it is tested against a real, independent
 * implementation of the protocol, not against itself.
 *
 * The rules below are the ones that actually matter for a server facing the open
 * internet, taken from RFC 6455 §5 and §7.
 *
 *   - client frames MUST be masked; an unmasked frame is a protocol violation
 *     (1002) — this is not cosmetic, masking is what stops cache-poisoning
 *   - extended payload lengths must use the shortest encoding (126 / 127);
 *     a non-minimal length is 1002
 *   - RSV bits must be zero because no extension is negotiated (1010); the
 *     handshake therefore never echoes Sec-WebSocket-Extensions
 *   - control frames must be unfragmented and at most 125 bytes (1002)
 *   - a text payload must be valid UTF-8 (1007)
 *   - frames we do not speak get 1003, and everything is capped: frame size,
 *     reassembled message size, and buffered bytes, so a peer cannot make this
 *     process allocate without bound
 *
 * Only what is needed is implemented: no extensions, no compression, no
 * subprotocol negotiation, server-to-client frames unmasked (as the RFC
 * requires), text in and text out.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODES = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

const CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  INVALID_PAYLOAD: 1007,
  POLICY_VIOLATION: 1008,
  TOO_BIG: 1009,
  MANDATORY_EXTENSION: 1010,
  INTERNAL_ERROR: 1011,
};

const ALLOWED_CLOSE_CODES = new Set([1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013]);

const textDecoder = new TextDecoder('utf-8', { fatal: true });
const lenientDecoder = new TextDecoder('utf-8', { fatal: false });

/** True when the handshake is a WebSocket upgrade we are willing to serve. */
function isUpgradeRequest(req) {
  const upgrade = String(req.headers['upgrade'] || '').trim().toLowerCase();
  const connection = String(req.headers['connection'] || '').toLowerCase();
  return req.method === 'GET'
    && upgrade === 'websocket'
    && /(^|,)\s*upgrade\s*(,|$)/.test(connection)
    && typeof req.headers['sec-websocket-key'] === 'string'
    && String(req.headers['sec-websocket-version'] || '') === '13';
}

function acceptKey(key) {
  return crypto.createHash('sha1').update(`${String(key).trim()}${GUID}`).digest('base64');
}

/**
 * Encode one WebSocket frame. Server-to-client frames are never masked.
 * @param {number} opcode
 * @param {Buffer|string} payload
 * @param {boolean} [fin]
 */
function encodeFrame(opcode, payload, fin = true) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const length = body.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = (fin ? 0x80 : 0x00) | opcode;
  return Buffer.concat([header, body]);
}

function encodeClose(code, reason) {
  const text = Buffer.from(String(reason || '').slice(0, 120), 'utf8');
  const body = Buffer.alloc(2 + text.length);
  body.writeUInt16BE(code, 0);
  text.copy(body, 2);
  return encodeFrame(OPCODES.CLOSE, body);
}

/**
 * Streaming frame decoder. Feed it socket chunks; it emits complete frames and
 * enforces the protocol rules above. `onFrame({opcode, payload, fin})` is called
 * once per frame, control frames included.
 */
function createFrameDecoder({
  maxFrameBytes = 1024 * 1024,
  maxMessageBytes = 4 * 1024 * 1024,
  onFrame = () => {},
  onError = () => {},
  onLimit = () => {},
} = {}) {
  let buffer = Buffer.alloc(0);
  // A close or a protocol failure stops parsing immediately: continuing to parse
  // untrusted bytes after we have decided the peer is broken is wasted work.
  let failed = false;

  function fail(code, reason, error) {
    if (failed) return;
    failed = true;
    onLimit(code, reason);
    if (error) onError(error);
  }

  function consume(bytes) {
    buffer = bytes >= buffer.length ? Buffer.alloc(0) : buffer.subarray(bytes);
  }

  function parse() {
    while (!failed) {
      if (buffer.length < 2) return;
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (rsv !== 0) return fail(CLOSE.MANDATORY_EXTENSION, 'no extension is negotiated');
      if ((opcode & 0x08) !== 0) {
        // Control frame: unfragmented, tiny, and a known opcode.
        if (!fin) return fail(CLOSE.PROTOCOL_ERROR, 'control frame must not be fragmented');
        if (length > 125) return fail(CLOSE.PROTOCOL_ERROR, 'control frame payload exceeds 125 bytes');
        if (![OPCODES.CLOSE, OPCODES.PING, OPCODES.PONG].includes(opcode)) {
          return fail(CLOSE.PROTOCOL_ERROR, 'reserved control opcode');
        }
      } else if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
        if (length < 126) return fail(CLOSE.PROTOCOL_ERROR, 'non-minimal payload length');
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        const big = buffer.readBigUInt64BE(offset);
        offset += 8;
        if (big < 65536n) return fail(CLOSE.PROTOCOL_ERROR, 'non-minimal payload length');
        if (big > BigInt(maxFrameBytes)) return fail(CLOSE.TOO_BIG, 'frame exceeds the configured limit');
        length = Number(big);
      }
      if (length > maxFrameBytes) return fail(CLOSE.TOO_BIG, 'frame exceeds the configured limit');
      // Every frame a client sends must be masked (RFC 6455 §5.1).
      if (!masked) return fail(CLOSE.PROTOCOL_ERROR, 'client frames must be masked');
      if (buffer.length < offset + 4 + length) return;

      const maskKey = buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i += 1) payload[i] = buffer[offset + i] ^ maskKey[i & 3];
      consume(offset + length);
      onFrame({ opcode, payload, fin });
    }
  }

  return {
    maxMessageBytes: maxMessageBytes || 4 * 1024 * 1024,
    push(chunk) {
      if (failed) return;
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      parse();
    },
    get failed() { return failed; },
    bufferedBytes: () => buffer.length,
  };
}

/**
 * A live WebSocket connection over an already-upgraded socket.
 *
 * Events: `message` (a UTF-8 string), `close` ({code, reason}), `error`.
 * Methods mirror the shape the rest of the server expects of a socket:
 * `send`, `ping`, `close`, `terminate`, `isAlive`.
 */
class LinkSocket extends EventEmitter {
  constructor(socket, { maxFrameBytes, maxMessageBytes } = {}) {
    super();
    this.socket = socket;
    this.readyState = 'open';
    this.isAlive = true;
    /**
     * When the last byte arrived. The heartbeat compares this against a deadline
     * instead of a single missed pong, so the configured silence window means what
     * it says and one slow pong on a busy machine cannot evict a working session.
     */
    this.lastSeenAt = Date.now();
    this.closedCode = null;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = null;

    this.decoder = createFrameDecoder({
      maxFrameBytes: maxFrameBytes || 1024 * 1024,
      maxMessageBytes: maxMessageBytes || 4 * 1024 * 1024,
      onFrame: (frame) => this.#handleFrame(frame),
      onLimit: (code, reason) => this.close(code, reason),
    });

    socket.on('data', (chunk) => {
      this.isAlive = true;
      this.lastSeenAt = Date.now();
      this.decoder.push(chunk);
    });
    socket.on('error', (error) => this.#finish(CLOSE.INTERNAL_ERROR, error.message));
    socket.on('close', () => this.#finish(this.closedCode || CLOSE.GOING_AWAY, 'socket closed'));
    socket.on('end', () => this.#finish(this.closedCode || CLOSE.GOING_AWAY, 'socket ended'));
  }

  #finish(code, reason) {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.closedCode = code;
    try { this.socket.destroy(); } catch { /* already gone */ }
    this.emit('close', { code, reason: String(reason || '').slice(0, 120) });
  }

  /**
   * Flush a close frame and then drop the socket. Destroying immediately would
   * throw away the frame we just wrote, and a peer that is mid-handshake on our
   * auth would see a bare TCP reset instead of a reason.
   */
  #finishAfterFlush(code, reason) {
    if (this.readyState === 'closed') return;
    this.readyState = 'closing';
    const timer = setTimeout(() => this.#finish(code, reason), 250);
    timer.unref?.();
    try {
      this.socket.end(() => {
        clearTimeout(timer);
        this.#finish(code, reason);
      });
    } catch {
      clearTimeout(timer);
      this.#finish(code, reason);
    }
  }

  #handleFrame({ opcode, payload, fin }) {
    switch (opcode) {
      case OPCODES.PING:
        this.#write(encodeFrame(OPCODES.PONG, payload));
        return;
      case OPCODES.PONG:
        this.isAlive = true;
        this.lastSeenAt = Date.now();
        return;
      case OPCODES.CLOSE: {
        let code = CLOSE.NORMAL;
        let reason = '';
        if (payload.length === 1) return this.close(CLOSE.PROTOCOL_ERROR, 'close payload must be 0 or >=2 bytes');
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0);
          if (!ALLOWED_CLOSE_CODES.has(code)) return this.close(CLOSE.PROTOCOL_ERROR, 'invalid close code');
          try { reason = textDecoder.decode(payload.subarray(2)); } catch { return this.close(CLOSE.INVALID_PAYLOAD, 'close reason is not UTF-8'); }
        }
        // Echo the close, then both sides drop the socket.
        this.#write(encodeClose(code, reason));
        return this.#finishAfterFlush(code, reason);
      }
      case OPCODES.TEXT:
      case OPCODES.CONTINUATION:
        return this.#handleData({ opcode, payload, fin });
      default:
        // Binary and every reserved opcode: this transport only speaks JSON text.
        return this.close(CLOSE.UNSUPPORTED_DATA, 'only text frames are supported');
    }
  }

  #handleData({ opcode, payload, fin }) {
    const starting = opcode !== OPCODES.CONTINUATION;
    if (starting) {
      // RFC 6455 §5.4: a new data frame while a fragmented message is incomplete
      // is a protocol error, not a licence to discard the partial message.
      if (this.fragmentOpcode !== null) return this.close(CLOSE.PROTOCOL_ERROR, 'new frame during a fragmented message');
      this.fragments = [];
      this.fragmentBytes = 0;
      this.fragmentOpcode = opcode;
    } else if (this.fragmentOpcode === null) {
      return this.close(CLOSE.PROTOCOL_ERROR, 'continuation without a start frame');
    }

    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > this.decoder.maxMessageBytes) {
      return this.close(CLOSE.TOO_BIG, 'message exceeds the configured limit');
    }
    this.fragments.push(payload);
    if (!fin) return;

    const body = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = null;
    let text;
    try { text = textDecoder.decode(body); } catch { return this.close(CLOSE.INVALID_PAYLOAD, 'text frame is not valid UTF-8'); }
    this.emit('message', text);
  }

  #write(frame) {
    if (this.socket.destroyed || this.socket.writableEnded) return false;
    try {
      return this.socket.write(frame);
    } catch (error) {
      this.emit('error', error);
      return false;
    }
  }

  /** Send a JSON-serialisable value as one text frame. */
  send(value) {
    if (this.readyState !== 'open') return false;
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    if (Buffer.byteLength(body) > this.decoder.maxMessageBytes) return false;
    return this.#write(encodeFrame(OPCODES.TEXT, body));
  }

  ping() {
    if (this.readyState !== 'open') return false;
    return this.#write(encodeFrame(OPCODES.PING, Buffer.alloc(0)));
  }

  /** Polite shutdown: send close, let it flush, then destroy. */
  close(code = CLOSE.NORMAL, reason = '') {
    if (this.readyState !== 'open') return;
    this.#write(encodeClose(code, String(reason).slice(0, 120)));
    this.#finishAfterFlush(code, reason);
  }

  /** No handshake, no waiting — used when the peer is misbehaving. */
  terminate() {
    this.#finish(CLOSE.INTERNAL_ERROR, 'terminated');
  }
}

// `createFrameDecoder` carries the message limit on the object it returns, so a
// socket can consult the same number it enforces.

/**
 * Perform the opening handshake on a raw socket and return a LinkSocket, or
 * write a refusal and return null.
 */
function completeUpgrade(req, socket, { maxFrameBytes, maxMessageBytes, head } = {}) {
  const key = req.headers['sec-websocket-key'];
  if (!isUpgradeRequest(req)) {
    if (socket.writable) {
      // A peer using another version is told which version we speak (RFC 6455 §6).
      const versions = String(req.headers['sec-websocket-version'] || '') ? 'Sec-WebSocket-Version: 13\r\n' : '';
      socket.end(`HTTP/1.1 400 Bad Request\r\n${versions}Connection: close\r\nContent-Length: 0\r\n\r\n`);
    } else socket.destroy();
    return null;
  }
  const response = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    // Deliberately no Sec-WebSocket-Extensions and no Sec-WebSocket-Protocol:
    // offering nothing is what makes RSV bits a protocol error we can enforce.
    'Cache-Control: no-store',
    '\r\n',
  ].join('\r\n');
  socket.write(response);
  socket.setNoDelay(true);
  const link = new LinkSocket(socket, { maxFrameBytes, maxMessageBytes });
  // A client that pipelined a frame with its handshake put those bytes in `head`.
  // Node does NOT replay them as a `data` event (verified on Node 24), so the
  // decoder has to be fed here or the first frame — the auth frame, always —
  // would silently never arrive.
  if (head && head.length) link.decoder.push(head);
  return link;
}

module.exports = {
  GUID,
  OPCODES,
  CLOSE,
  ALLOWED_CLOSE_CODES,
  isUpgradeRequest,
  acceptKey,
  encodeFrame,
  encodeClose,
  createFrameDecoder,
  LinkSocket,
  completeUpgrade,
  lenientDecode: (buffer) => lenientDecoder.decode(buffer),
};
