/**
 * NovaLink service logic tests.
 *
 * A single fake transport drives the service state machine so we can assert the
 * safety rules from the spec without any sockets: pairing is approval-gated,
 * incoming files are verified + previewed + saved only inside a user folder,
 * path traversal and oversize offers are rejected, integrity mismatches fail,
 * duplicate envelopes are ignored, and a disconnect interrupts a transfer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import os from 'os';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';

import { createNovaLinkService } from '../../electron/services/novalink/novaLinkService';
import { MESSAGE_TYPES, LIMITS, makeMessage, sha256 } from '../../electron/services/novalink/protocol';

const SELF = { peerId: 'self', fp: 'SELF-FP', name: 'Me' };
const PEER = { peerId: 'peer-1', fp: 'PEER-FP', name: 'Alice' };

function makeFakeTransport() {
  const events = new EventEmitter();
  const sent = [];
  return {
    id: 'fake',
    label: 'Fake',
    kind: 'lan',
    supported: true,
    sent,
    on: (e, cb) => events.on(e, cb),
    off: (e, cb) => events.off(e, cb),
    emit: (e, payload) => events.emit(e, payload),
    async getStatus() { return { available: true, supported: true, detail: 'fake' }; },
    async start() {},
    async stop() {},
    async scan() {},
    addPeer() {},
    async connect(peerId) {
      const peer = { peerId, fp: PEER.fp, name: PEER.name };
      events.emit('connection', { peer, state: 'open' });
      return peer;
    },
    async close() { return { ok: true }; },
    send(peerId, envelope) { sent.push({ peerId, envelope }); return Promise.resolve(); },
    listPeers: () => [],
    connectedIds: () => [],
  };
}

function buildService() {
  const transport = makeFakeTransport();
  const events = [];
  const service = createNovaLinkService({
    identity: SELF,
    transports: [transport],
    logger: new EventEmitter(),
    onEvent: (snap) => events.push(snap),
  });
  return { service, transport, events };
}

/** Pair an already-started service with the fake peer (no extra start()). */
async function pairNow(service, transport) {
  transport.emit('peers', [{ peerId: PEER.peerId, fp: PEER.fp, name: PEER.name, kind: 'lan', host: 'x' }]);
  await service.connect(PEER.peerId); // -> transport emits 'connection open'
  // Peer accepts our pairing request.
  transport.emit('message', { peer: { peerId: PEER.peerId, fp: PEER.fp }, message: makeMessage(PEER.peerId, PEER.fp, MESSAGE_TYPES.PAIR_ACCEPT, { name: PEER.name }) });
}

/** Establish a paired+connected peer by simulating the accept handshake. */
async function connectPaired(service, transport) {
  await service.start();
  await pairNow(service, transport);
}

describe('novalink service — pairing + chat', () => {
  it('requires the local user to accept an incoming pairing request', async () => {
    const { service, transport } = buildService();
    await service.start();
    // A transport channel opens first (that is how the peer reaches us), then
    // the peer initiates pairing which we must explicitly approve.
    transport.emit('connection', { peer: { peerId: PEER.peerId, fp: PEER.fp, name: PEER.name }, state: 'open' });
    transport.emit('message', { peer: { peerId: PEER.peerId, fp: PEER.fp, name: PEER.name }, message: makeMessage(PEER.peerId, PEER.fp, MESSAGE_TYPES.PAIR_REQUEST, { name: PEER.name }) });
    let snap = service.snapshot();
    expect(snap.requests.incoming.map((r) => r.peerId)).toContain(PEER.peerId);
    expect(snap.peers).toHaveLength(0); // not connected until we accept

    service.acceptConnection(PEER.peerId);
    snap = service.snapshot();
    expect(snap.peers.map((p) => p.peerId)).toContain(PEER.peerId);
    // We sent a PAIR_ACCEPT back.
    expect(transport.sent.some((s) => s.envelope.type === MESSAGE_TYPES.PAIR_ACCEPT)).toBe(true);
  });

  it('ignores chat from an unpaired device and honors it once paired', async () => {
    const { service, transport } = buildService();
    await service.start();
    const textMsg = makeMessage(PEER.peerId, PEER.fp, MESSAGE_TYPES.TEXT, { text: 'unsolicited' });
    transport.emit('message', { peer: { peerId: PEER.peerId, fp: PEER.fp }, message: textMsg });
    expect(service.snapshot().chats[PEER.peerId]).toBeUndefined();

    await pairNow(service, transport);
    const hi = makeMessage(PEER.peerId, PEER.fp, MESSAGE_TYPES.TEXT, { text: 'now paired' });
    transport.emit('message', { peer: { peerId: PEER.peerId, fp: PEER.fp }, message: hi });
    expect(service.snapshot().chats[PEER.peerId].some((m) => m.text === 'now paired')).toBe(true);
  });

  it('suppresses a duplicate envelope (same id delivered twice)', async () => {
    const { service, transport } = buildService();
    await connectPaired(service, transport);
    const dup = makeMessage(PEER.peerId, PEER.fp, MESSAGE_TYPES.TEXT, { text: 'once', id: 'fixed-id' });
    transport.emit('message', { peer: { peerId: PEER.peerId, fp: PEER.fp }, message: dup });
    transport.emit('message', { peer: { peerId: PEER.peerId, fp: PEER.fp }, message: dup });
    const chat = service.snapshot().chats[PEER.peerId].filter((m) => m.id === 'fixed-id');
    expect(chat).toHaveLength(1);
  });
});

describe('novalink service — safe file sharing', () => {
  let root;
  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'novalink-test-'));
  });

  /** Offer → approve → chunk → done, returning the finished transfer id. */
  async function receiveFile(service, transport, content, { tamper = false, name = 'hello.txt' } = {}) {
    const buffer = Buffer.from(content, 'utf8');
    const transferId = 'tx-1';
    const offered = tamper ? sha256(Buffer.from('different', 'utf8')) : sha256(buffer);
    transport.emit('message', { peer: { peerId: PEER.peerId, fp: PEER.fp }, message: makeMessage(PEER.peerId, PEER.fp, MESSAGE_TYPES.FILE_META, { transferId, name, size: buffer.length, sha256: offered }) });
    service.acceptTransfer(transferId);
    transport.emit('message', { peer: { peerId: PEER.peerId, fp: PEER.fp }, message: makeMessage(PEER.peerId, PEER.fp, MESSAGE_TYPES.FILE_CHUNK, { transferId, index: 0, data: buffer.toString('base64') }) });
    transport.emit('message', { peer: { peerId: PEER.peerId, fp: PEER.fp }, message: makeMessage(PEER.peerId, PEER.fp, MESSAGE_TYPES.FILE_DONE, { transferId, sha256: offered }) });
    return transferId;
  }

  it('does not write anything until the user explicitly saves', async () => {
    const { service, transport } = buildService();
    await connectPaired(service, transport);
    const id = await receiveFile(service, transport, 'console.log(1)');
    expect(service.snapshot().transfers.find((t) => t.id === id).status).toBe('received');
    expect(fs.existsSync(path.join(root, 'hello.txt'))).toBe(false);

    const saved = await service.saveTransfer(id, { root });
    expect(saved.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'hello.txt'), 'utf8')).toBe('console.log(1)');
    expect(service.snapshot().transfers.find((t) => t.id === id).status).toBe('complete');
  });

  it('rejects a path-traversal destination', async () => {
    const { service, transport } = buildService();
    await connectPaired(service, transport);
    const id = await receiveFile(service, transport, 'x');
    await expect(service.saveTransfer(id, { root, dir: '../escape' })).rejects.toThrow();
    await expect(service.saveTransfer(id, { root, name: '../../evil.txt' })).rejects.toThrow();
  });

  it('never overwrites an existing file without explicit approval', async () => {
    const { service, transport } = buildService();
    await connectPaired(service, transport);
    await fsp.writeFile(path.join(root, 'hello.txt'), 'ORIGINAL');
    const id = await receiveFile(service, transport, 'REPLACEMENT');
    await expect(service.saveTransfer(id, { root })).rejects.toThrow(/already exists/i);
    expect(fs.readFileSync(path.join(root, 'hello.txt'), 'utf8')).toBe('ORIGINAL');
    await service.saveTransfer(id, { root, overwrite: true });
    expect(fs.readFileSync(path.join(root, 'hello.txt'), 'utf8')).toBe('REPLACEMENT');
  });

  it('fails an incoming transfer whose checksum does not match', async () => {
    const { service, transport } = buildService();
    await connectPaired(service, transport);
    const id = await receiveFile(service, transport, 'real bytes', { tamper: true });
    const t = service.snapshot().transfers.find((x) => x.id === id);
    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/checksum mismatch/i);
  });

  it('rejects an oversized offer up-front', async () => {
    const { service, transport } = buildService();
    await connectPaired(service, transport);
    transport.emit('message', { peer: { peerId: PEER.peerId, fp: PEER.fp }, message: makeMessage(PEER.peerId, PEER.fp, MESSAGE_TYPES.FILE_META, { transferId: 'big', name: 'huge.bin', size: LIMITS.MAX_FILE_BYTES + 1, sha256: sha256('x') }) });
    const t = service.snapshot().transfers.find((x) => x.id === 'big');
    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/too large/i);
  });

  it('interrupts an in-flight transfer when the peer disconnects', async () => {
    const { service, transport } = buildService();
    await connectPaired(service, transport);
    const buffer = Buffer.from('stream me', 'utf8');
    transport.emit('message', { peer: { peerId: PEER.peerId, fp: PEER.fp }, message: makeMessage(PEER.peerId, PEER.fp, MESSAGE_TYPES.FILE_META, { transferId: 'cut', name: 'a.txt', size: buffer.length, sha256: sha256(buffer) }) });
    service.acceptTransfer('cut');
    transport.emit('connection', { peer: { peerId: PEER.peerId, fp: PEER.fp }, state: 'closed' });
    const t = service.snapshot().transfers.find((x) => x.id === 'cut');
    expect(t.status).toBe('failed');
    expect(service.snapshot().peers).toHaveLength(0);
  });

  it('declines an incoming offer when the user rejects it', async () => {
    const { service, transport } = buildService();
    await connectPaired(service, transport);
    const buffer = Buffer.from('nope', 'utf8');
    transport.emit('message', { peer: { peerId: PEER.peerId, fp: PEER.fp }, message: makeMessage(PEER.peerId, PEER.fp, MESSAGE_TYPES.FILE_META, { transferId: 'rj', name: 'no.txt', size: buffer.length, sha256: sha256(buffer) }) });
    service.rejectTransfer('rj');
    const t = service.snapshot().transfers.find((x) => x.id === 'rj');
    expect(t.status).toBe('rejected');
  });
});

describe('novalink service — sender side', () => {
  it('refuses to share code with a peer that is not connected', async () => {
    const { service } = buildService();
    await service.start();
    await expect(service.shareCode({ peerId: PEER.peerId, text: 'x', language: 'js' })).rejects.toThrow(/Connect/i);
  });

  it('sends a share-file offer with metadata and waits for approval', async () => {
    const { service, transport } = buildService();
    await connectPaired(service, transport);
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'novalink-out-'));
    const file = path.join(root, 'src.js');
    await fsp.writeFile(file, 'const a = 1;');
    const res = await service.shareFile({ peerId: PEER.peerId, root, path: file });
    expect(res.ok).toBe(true);
    const meta = transport.sent.find((s) => s.envelope.type === MESSAGE_TYPES.FILE_META);
    expect(meta.envelope.name).toBe('src.js');
    expect(meta.envelope.sha256).toBe(sha256('const a = 1;'));
    // Nothing streams until the peer ACKs "ready".
    transport.emit('message', { peer: { peerId: PEER.peerId, fp: PEER.fp }, message: makeMessage(PEER.peerId, PEER.fp, MESSAGE_TYPES.ACK, { transferId: res.transferId, status: 'ready' }) });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(transport.sent.some((s) => s.envelope.type === MESSAGE_TYPES.FILE_CHUNK)).toBe(true);
    expect(transport.sent.some((s) => s.envelope.type === MESSAGE_TYPES.FILE_DONE)).toBe(true);
  });
});

describe('novalink service — Bluetooth enable + surrounding-device scan', () => {
  function withBluetooth(btOverrides) {
    const bt = {
      id: 'bt', label: 'Bluetooth', kind: 'bluetooth', supported: false,
      on() {}, off() {}, async getStatus() { return { available: true, supported: false, power: 'on' }; },
      async start() {}, async stop() {}, async scan() {}, addPeer() {}, async close() {},
      listPeers: () => [], connectedIds: () => [],
      ...btOverrides,
    };
    const service = createNovaLinkService({
      identity: SELF, transports: [makeFakeTransport(), bt], logger: new EventEmitter(), onEvent: () => {},
    });
    return { service, bt };
  }

  it('routes enableBluetooth to the Bluetooth transport and stores the scan result', async () => {
    const calls = [];
    const { service } = withBluetooth({
      enable: async () => { calls.push('enable'); return { ok: true, power: 'on', detail: 'Bluetooth adapter enabled.' }; },
      scanDevices: async () => { calls.push('scan'); return { ok: true, power: 'on', devices: [{ name: 'JBL Flip 6', isAdapter: false, status: 'OK' }], scannedAt: 123 }; },
    });
    await service.start();
    const result = await service.enableBluetooth();
    expect(result.ok).toBe(true);
    expect(calls).toContain('enable');
    expect(service.snapshot().bluetooth.devices[0].name).toBe('JBL Flip 6');
  });

  it('refuses to scan while the radio is off (no fake device list)', async () => {
    const { service } = withBluetooth({
      scanDevices: async () => ({ ok: false, power: 'off', devices: [], scannedAt: 1 }),
    });
    await service.start();
    await expect(service.scanBluetoothDevices()).rejects.toThrow(/enable it first/i);
    expect(service.snapshot().bluetooth.devices).toEqual([]);
  });

  it('errors clearly when no Bluetooth transport exists', async () => {
    const { service } = buildService(); // lan-only
    await service.start();
    await expect(service.enableBluetooth()).rejects.toThrow(/No Bluetooth transport/i);
  });
});
