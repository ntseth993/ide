/**
 * NovaLink local-network transport integration test (loopback).
 *
 * Two real transports run in one process, dial each other over 127.0.0.1 TCP,
 * complete the ECDH handshake, and exchange a sealed message. This proves the
 * transport abstraction, framing, and channel encryption actually work together
 * — no mocks. (Discovery/UDP is exercised separately; here we inject peers so
 * the test is deterministic even in a sandbox where multicast is blocked.)
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { createLocalTransport } from '../../electron/services/novalink/localTransport';
import { createKeyPair, fingerprint } from '../../electron/services/novalink/cryptoChannel';
import { MESSAGE_TYPES, makeMessage } from '../../electron/services/novalink/protocol';

function makeIdentity(label) {
  const pair = createKeyPair();
  return {
    peerId: `peer-${label}`,
    publicKey: pair.publicKey,
    privateKey: pair.ecdh.getPrivateKey(),
    fingerprint: fingerprint(pair.publicKey),
    name: `NovaCode ${label}`,
  };
}

function waitFor(emitter, event, predicate = () => true, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`Timed out waiting for "${event}".`));
    }, timeout);
    function handler(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      emitter.off(event, handler);
      resolve(payload);
    }
    emitter.on(event, handler);
  });
}

describe('novalink localTransport — loopback handshake + sealed messaging', () => {
  it('two transports derive a shared key and exchange an encrypted message', async () => {
    const idA = makeIdentity('A');
    const idB = makeIdentity('B');
    const a = createLocalTransport({ identity: idA, logger: new EventEmitter(), discoveryPort: 41881, tcpPort: 0 });
    const b = createLocalTransport({ identity: idB, logger: new EventEmitter(), discoveryPort: 41882, tcpPort: 0 });

    await a.start();
    await b.start();
    try {
      // Inject each other so connect() has a target without relying on UDP.
      a.addPeer({ peerId: idB.peerId, fp: idB.fingerprint, name: idB.name, host: '127.0.0.1', tcpPort: b.tcpPort(), kind: 'lan' });
      b.addPeer({ peerId: idA.peerId, fp: idA.fingerprint, name: idA.name, host: '127.0.0.1', tcpPort: a.tcpPort(), kind: 'lan' });

      const aOpen = waitFor(a, 'connection', (p) => p.state === 'open');
      const bOpen = waitFor(b, 'connection', (p) => p.state === 'open');
      await b.connect(idA.peerId);
      await Promise.all([aOpen, bOpen]);

      const arrived = waitFor(a, 'message');
      await b.send(idA.peerId, makeMessage(idB.peerId, idB.fingerprint, MESSAGE_TYPES.TEXT, { text: 'hello over the wire' }));
      const { peer, message } = await arrived;

      expect(message.text).toBe('hello over the wire');
      expect(message.type).toBe(MESSAGE_TYPES.TEXT);
      // Identity is the handshake fingerprint, not a claimed name.
      expect(peer.fp).toBe(idB.fingerprint);
    } finally {
      await a.stop();
      await b.stop();
    }
  });
});
