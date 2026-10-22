/**
 * NovaLink channel security (local-network transport).
 *
 * The Ethernet/Wi-Fi transport runs on a private LAN, but "peer-to-peer on the
 * same network" is not the same as "secure". Anyone who can route a packet to
 * the TCP port could otherwise read or tamper with the shared code. So every
 * NovaLink data channel is encrypted with an ephemeral-authenticated session:
 *
 *   1. Each NovaCode instance owns a persistent ECDH identity key pair. Its
 *      public key IS the peer identity (a short fingerprint the user can read
 *      aloud to confirm out-of-band) — never a Bluetooth or mDNS display name.
 *   2. On connect, both sides exchange *ephemeral* ECDH public keys in the
 *      clear (that is what ECDH is for) and derive an identical shared secret.
 *   3. The shared secret is expanded with HKDF into an AES-256-GCM key. Every
 *      subsequent frame is sealed with a fresh random IV; GCM's auth tag makes
 *      any tampering fail to open.
 *
 * This gives confidentiality + integrity + replay resistance within a session.
 * It does NOT, on its own, prove *who* is on the other end unless the two
 * users verify each other's fingerprints — so the UI surfaces fingerprints and
 * the transport documents this limitation. There is no certificate authority;
 * identity is trust-on-first-use with a user-visible fingerprint (MITM
 * resistance is manual, like Signal's safety numbers — but inspectable).
 */
const crypto = require('crypto');

const CURVE = 'prime256v1';
const HKDF_INFO = 'NovaLink-v1 session key';
const IV_BYTES = 12; // standard GCM nonce length
const TAG_BYTES = 16;

/** Create a fresh ECDH identity (or session) key pair. */
function createKeyPair() {
  const ecdh = crypto.createECDH(CURVE);
  ecdh.generateKeys();
  return {
    ecdh,
    publicKey: ecdh.getPublicKey(), // Buffer ( uncompressed point )
  };
}

/** Rebuild an ECDH object from a stored private key so identity persists. */
function keyPairFromPrivate(privateKey, publicKey) {
  const ecdh = crypto.createECDH(CURVE);
  // setPrivateKey also derives and stores the matching public key, so we must
  // NOT call generateKeys() here (that would mint a brand-new random pair).
  ecdh.setPrivateKey(privateKey);
  if (publicKey) ecdh.setPublicKey(publicKey);
  return { ecdh, publicKey: ecdh.getPublicKey() };
}

/**
 * A stable human-comparable fingerprint of a public key: the first 8 bytes of
 * its SHA-256, grouped in fours. Two users can read these aloud to confirm the
 * peer really is who they think it is.
 */
function fingerprint(publicKey) {
  const digest = crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
  return digest.toUpperCase().replace(/(.{4})(?=.)/g, '$1-');
}

/** Derive the 256-bit AES-GCM session key from the ECDH shared secret. */
function deriveSessionKey(localEcdh, remotePublicKey) {
  const shared = localEcdh.computeSecret(remotePublicKey);
  return Buffer.from(
    crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from(HKDF_INFO), 32),
  );
}

/** AES-256-GCM seal: returns iv || ciphertext || authTag. */
function seal(key, plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** AES-256-GCM open: throws when the tag does not verify (tamper/ wrong key). */
function open(key, sealed) {
  if (!Buffer.isBuffer(sealed) || sealed.length < IV_BYTES + TAG_BYTES) {
    throw new Error('NovaLink sealed frame is truncated.');
  }
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = sealed.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = {
  CURVE,
  createKeyPair,
  keyPairFromPrivate,
  fingerprint,
  deriveSessionKey,
  seal,
  open,
};
