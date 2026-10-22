/**
 * NovaLink factory — assembles identity + transports + service.
 *
 * The service is handed a list of transports implementing a common interface,
 * so wiring a real Bluetooth (or any other) transport in the future is a matter
 * of appending it here — nothing in the service or the UI changes.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { createNovaLinkService } = require('./novaLinkService');
const { createLocalTransport } = require('./localTransport');
const { createBluetoothTransport } = require('./bluetoothTransport');
const { createKeyPair, keyPairFromPrivate, fingerprint } = require('./cryptoChannel');

/**
 * Load (or first-run create + persist) this instance's NovaLink identity.
 * The identity is an ECDH key pair; its fingerprint is stable across restarts
 * so peers can recognise each other and verify out-of-band.
 */
function loadIdentity(userDataDir) {
  const file = path.join(userDataDir, 'novacode-novalink-identity.json');
  const displayName = `NovaCode @ ${os.hostname()}`.slice(0, 60);
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && saved.privateKey && saved.publicKey && saved.peerId) {
      const pair = keyPairFromPrivate(Buffer.from(saved.privateKey, 'base64'), Buffer.from(saved.publicKey, 'base64'));
      return {
        peerId: saved.peerId,
        publicKey: pair.publicKey,
        fingerprint: fingerprint(pair.publicKey),
        name: saved.name || displayName,
      };
    }
  } catch { /* first run or unreadable: create a fresh identity below */ }

  const pair = createKeyPair();
  const identity = {
    peerId: crypto.randomUUID(),
    publicKey: pair.ecdh.getPublicKey(),
    privateKey: pair.ecdh.getPrivateKey(),
  };
  const record = {
    peerId: identity.peerId,
    privateKey: identity.privateKey.toString('base64'),
    publicKey: identity.publicKey.toString('base64'),
    name: displayName,
  };
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
  } catch { /* identity persistence is best-effort; a fresh id is still usable */ }
  return {
    peerId: record.peerId,
    publicKey: identity.publicKey,
    fingerprint: fingerprint(identity.publicKey),
    name: displayName,
  };
}

function createNovaLink({ userDataDir, logger = console, onEvent = () => {}, enableBluetooth = true } = {}) {
  const identity = loadIdentity(userDataDir);
  const transports = [
    createLocalTransport({ identity, logger }),
  ];
  if (enableBluetooth) transports.push(createBluetoothTransport({ logger }));
  const service = createNovaLinkService({ identity, transports, logger, onEvent });
  return { service, identity, transports };
}

module.exports = { createNovaLink, loadIdentity };
