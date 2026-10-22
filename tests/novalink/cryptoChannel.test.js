/**
 * NovaLink channel-security unit tests: ECDH agreement, HKDF key derivation,
 * AES-256-GCM seal/open, tamper detection, and fingerprint stability.
 */
import { describe, it, expect } from 'vitest';
import {
  createKeyPair,
  keyPairFromPrivate,
  fingerprint,
  deriveSessionKey,
  seal,
  open,
} from '../../electron/services/novalink/cryptoChannel';

describe('novalink cryptoChannel', () => {
  it('both sides derive the same session key (ECDH symmetry)', () => {
    const a = createKeyPair();
    const b = createKeyPair();
    const keyA = deriveSessionKey(a.ecdh, b.publicKey);
    const keyB = deriveSessionKey(b.ecdh, a.publicKey);
    expect(keyA.equals(keyB)).toBe(true);
    expect(keyA.length).toBe(32); // AES-256
  });

  it('seals and opens a message', () => {
    const a = createKeyPair();
    const b = createKeyPair();
    const key = deriveSessionKey(a.ecdh, b.publicKey);
    const sealed = seal(key, Buffer.from('shared code snippet', 'utf8'));
    expect(open(key, sealed).toString('utf8')).toBe('shared code snippet');
  });

  it('fails to open a tampered frame (GCM auth tag)', () => {
    const key = deriveSessionKey(createKeyPair().ecdh, createKeyPair().publicKey);
    const sealed = seal(key, Buffer.from('important', 'utf8'));
    sealed[sealed.length - 1] ^= 0xff; // flip a bit of the ciphertext
    expect(() => open(key, sealed)).toThrow();
  });

  it('fails to open with the wrong key', () => {
    const key = deriveSessionKey(createKeyPair().ecdh, createKeyPair().publicKey);
    const other = deriveSessionKey(createKeyPair().ecdh, createKeyPair().publicKey);
    const sealed = seal(key, Buffer.from('x', 'utf8'));
    expect(() => open(other, sealed)).toThrow();
  });

  it('produces a stable fingerprint for a given public key', () => {
    const pair = createKeyPair();
    expect(fingerprint(pair.publicKey)).toBe(fingerprint(pair.publicKey));
    expect(fingerprint(pair.publicKey)).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{3,4})+$/);
  });

  it('restores an identical key pair from a persisted private key', () => {
    const original = createKeyPair();
    const restored = keyPairFromPrivate(original.ecdh.getPrivateKey());
    expect(restored.publicKey.equals(original.publicKey)).toBe(true);
    // And the peer can still agree on a shared secret with the restored pair.
    const peer = createKeyPair();
    expect(
      deriveSessionKey(restored.ecdh, peer.publicKey).equals(deriveSessionKey(peer.ecdh, original.publicKey)),
    ).toBe(true);
  });
});
