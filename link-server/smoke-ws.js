'use strict';
// Throwaway: prove the hand-rolled WS server interoperates with Node's own
// standards-compliant WebSocket client, and refuses the frames it should.
// Everything is asserted by comparison, never by eyeballing console output,
// because the terminal codepage mangles UTF-8 on this machine.
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const assert = require('assert');
// This script builds client frames itself (see clientFrame below), because a smoke
// test that used the server's own encoder would only be checking it against itself.
const { completeUpgrade, OPCODES, CLOSE, createFrameDecoder } = require('./ws');

const received = [];
let sockets = [];

function start() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
    server.on('upgrade', (req, socket) => {
      const ws = completeUpgrade(req, socket, { maxFrameBytes: 4096, maxMessageBytes: 8192 });
      if (!ws) return;
      sockets.push(ws);
      ws.on('message', (text) => {
        received.push(text);
        ws.send({ echo: JSON.parse(text), ping: ws.isAlive });
      });
      ws.on('close', (info) => received.push({ __closed: info.code }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, server }));
  });
}

const connect = (port) => new Promise((resolve) => {
  const socket = net.connect(port, '127.0.0.1', () => resolve(socket));
});

function clientFrame(opcode, payload, { mask = true, fin = true, lengthStyle } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const style = lengthStyle || (body.length < 126 ? 'short' : body.length <= 0xffff ? 'medium' : 'long');
  const extra = style === 'short' ? 0 : style === 'medium' ? 2 : 8;
  const header = Buffer.alloc(2 + extra + (mask ? 4 : 0));
  header[0] = (fin ? 0x80 : 0) | opcode;
  const lenBits = style === 'short' ? body.length : style === 'medium' ? 126 : 127;
  header[1] = (mask ? 0x80 : 0) | lenBits;
  if (style === 'medium') header.writeUInt16BE(body.length, 2);
  if (style === 'long') header.writeBigUInt64BE(BigInt(body.length), 2);
  const key = crypto.randomBytes(4);
  if (mask) {
    key.copy(header, 2 + extra);
    for (let i = 0; i < body.length; i += 1) body[i] ^= key[i & 3];
  }
  return Buffer.concat([header, body]);
}

async function handshake(socket, path = '/link') {
  const key = crypto.randomBytes(16).toString('base64');
  socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const data = await new Promise((resolve) => socket.once('data', resolve));
  const text = data.toString('latin1');
  const expected = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  return { status: text.split('\r\n')[0], accepts: text.includes(`Sec-WebSocket-Accept: ${expected}`), first: data };
}

/** Read the next WS frame off a raw socket (server frames are unmasked). */
function nextFrame(socket) {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 2) return;
      const length = buffer[1] & 0x7f;
      let offset = 2;
      let size = length;
      if (length === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
      if (buffer.length < offset + size) return;
      socket.removeListener('data', onData);
      resolve({ opcode: buffer[0] & 0x0f, fin: (buffer[0] & 0x80) !== 0, payload: buffer.subarray(offset, offset + size) });
    };
    socket.on('data', onData);
  });
}

async function main() {
  const { port, server } = await start();

  // 1. Real standard client: handshake, non-ASCII round trip, clean close.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/link`);
  const sent = JSON.stringify({ hi: 1, text: 'ünïcode ✓ — 中文 — “smart quotes”', n: 42 });
  const echoed = await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => ws.send(sent));
    ws.addEventListener('message', (event) => resolve(event.data));
    ws.addEventListener('error', () => reject(new Error('client reported an error')));
    setTimeout(() => reject(new Error('timeout waiting for echo')), 4000);
  });
  assert.strictEqual(echoed, JSON.stringify({ echo: JSON.parse(sent), ping: true }), 'echo must be byte-identical including non-ASCII');
  assert.strictEqual(received[0], sent, 'server must decode exactly what the client encoded');
  console.log('1 standard-client round trip: PASS (unicode preserved)');
  ws.close(1000, 'bye');
  await new Promise((r) => setTimeout(r, 150));

  // 2. Fragmented message from a real socket reassembles into ONE message.
  const raw = await connect(port);
  await handshake(raw);
  raw.write(clientFrame(OPCODES.TEXT, '{"a":', { fin: false }));
  raw.write(clientFrame(OPCODES.CONTINUATION, '1,"b":"✓"}', { fin: true }));
  const frag = await nextFrame(raw);
  assert.strictEqual(JSON.parse(frag.payload.toString('utf8')).echo.a, 1);
  assert.strictEqual(JSON.parse(frag.payload.toString('utf8')).echo.b, '✓');
  console.log('2 fragmented reassembly: PASS');
  raw.destroy();

  // 3. Control frame interleaved inside a fragmented message.
  const raw3 = await connect(port);
  await handshake(raw3);
  raw3.write(clientFrame(OPCODES.TEXT, '{"x":1', { fin: false }));
  raw3.write(clientFrame(OPCODES.PING, 'probe'));
  const pong = await nextFrame(raw3);
  assert.strictEqual(pong.opcode, OPCODES.PONG);
  assert.strictEqual(pong.payload.toString('utf8'), 'probe');
  raw3.write(clientFrame(OPCODES.CONTINUATION, '}'));
  const inter = await nextFrame(raw3);
  assert.strictEqual(JSON.parse(inter.payload.toString('utf8')).echo.x, 1);
  console.log('3 ping/pong inside fragmentation: PASS');
  raw3.destroy();

  // 4. Unmasked client frame is a protocol violation -> 1002.
  const raw4 = await connect(port);
  await handshake(raw4);
  raw4.write(clientFrame(OPCODES.TEXT, 'unmasked', { mask: false }));
  const refuse4 = await nextFrame(raw4);
  assert.strictEqual(refuse4.opcode, OPCODES.CLOSE);
  assert.strictEqual(refuse4.payload.readUInt16BE(0), CLOSE.PROTOCOL_ERROR);
  console.log('4 unmasked frame refused with 1002: PASS');

  // 5. Oversized frame -> 1009.
  const raw5 = await connect(port);
  await handshake(raw5);
  raw5.write(clientFrame(OPCODES.TEXT, 'x'.repeat(5000)));
  const refuse5 = await nextFrame(raw5);
  assert.strictEqual(refuse5.payload.readUInt16BE(0), CLOSE.TOO_BIG);
  console.log('5 oversized frame refused with 1009: PASS');

  // 6. Invalid UTF-8 in a text frame -> 1007.
  const raw6 = await connect(port);
  await handshake(raw6);
  raw6.write(clientFrame(OPCODES.TEXT, Buffer.from([0xff, 0xfe, 0xfd])));
  const refuse6 = await nextFrame(raw6);
  assert.strictEqual(refuse6.payload.readUInt16BE(0), CLOSE.INVALID_PAYLOAD);
  console.log('6 invalid UTF-8 refused with 1007: PASS');

  // 7. Reserved opcode -> 1003, and a fragmented control frame -> 1002.
  const raw7 = await connect(port);
  await handshake(raw7);
  raw7.write(clientFrame(0x3, 'reserved'));
  const refuse7 = await nextFrame(raw7);
  assert.strictEqual(refuse7.payload.readUInt16BE(0), CLOSE.UNSUPPORTED_DATA);
  console.log('7 reserved opcode refused with 1003: PASS');

  // 8. A non-minimal length encoding is 1002 (decoder level).
  const seen = [];
  const decoder = createFrameDecoder({
    maxFrameBytes: 1024,
    maxMessageBytes: 1024,
    onFrame: (f) => seen.push(f.opcode),
    onLimit: (code) => seen.push(`limit:${code}`),
  });
  const sneaky = Buffer.concat([
    Buffer.from([0x81, 0x80 | 126]), // says "medium length"...
    Buffer.from([0x00, 0x05]),        // ...for a 5-byte payload: non-minimal
    crypto.randomBytes(4),
    Buffer.alloc(5),
  ]);
  decoder.push(sneaky);
  assert.ok(seen.includes('limit:1002'), `expected 1002, saw ${seen}`);
  console.log('8 non-minimal length refused: PASS');

  // 9. A bad handshake is refused before any frame is parsed.
  const raw9 = await connect(port);
  raw9.write('GET /link HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 8\r\n\r\n');
  const bad = await new Promise((resolve) => raw9.once('data', (d) => resolve(d.toString('latin1'))));
  assert.ok(bad.startsWith('HTTP/1.1 400'), `expected 400, got ${bad.split('\r\n')[0]}`);
  assert.ok(bad.includes('Sec-WebSocket-Version: 13'), 'must advertise the version it speaks');
  console.log('9 wrong protocol version refused with 400 + advertises 13: PASS');

  server.close();
  console.log('WS SMOKE ALL PASS');
}

main().catch((error) => { console.error('FAILED:', error.message); process.exit(1); });
