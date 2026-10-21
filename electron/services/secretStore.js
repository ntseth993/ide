/**
 * Secret storage for API credentials.
 *
 * Values are encrypted with Electron safeStorage (DPAPI on Windows,
 * Keychain on macOS, libsecret on Linux where available) and stored as
 * base64 blobs inside userData. Secrets are never exposed to the renderer:
 * the renderer can set, clear, or ask for the *presence* of a key, but the
 * plaintext value only ever exists inside the main process.
 */
const fsp = require('fs').promises;

const ENCRYPTED_PREFIX = 'enc:';
const PLAIN_PREFIX = 'plain:';

function createSecretStore({ filePath, safeStorage, logger }) {
  async function readAll() {
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  async function writeAll(secrets) {
    await fsp.writeFile(filePath, JSON.stringify(secrets, null, 2), 'utf8');
  }

  async function setSecret(name, value) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
      throw new Error('Invalid secret name.');
    }
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error('Secret value cannot be empty.');
    }
    const secrets = await readAll();
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      secrets[name] = ENCRYPTED_PREFIX + safeStorage.encryptString(value).toString('base64');
    } else {
      // OS-level encryption unavailable (some Linux setups): store with an
      // explicit marker so the UI can warn the user honestly.
      secrets[name] = PLAIN_PREFIX + value;
      logger.warn('safeStorage unavailable; secret stored without OS encryption');
    }
    await writeAll(secrets);
    return { storage: secrets[name].startsWith(ENCRYPTED_PREFIX) ? 'os-encrypted' : 'plain' };
  }

  async function getSecret(name) {
    const secrets = await readAll();
    const stored = secrets[name];
    if (typeof stored !== 'string' || !stored) return null;
    if (stored.startsWith(ENCRYPTED_PREFIX)) {
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;
      try {
        return safeStorage.decryptString(Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), 'base64'));
      } catch (error) {
        logger.error('secret decryption failed', { name, error: error.message });
        return null;
      }
    }
    if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length);
    return null;
  }

  async function clearSecret(name) {
    const secrets = await readAll();
    delete secrets[name];
    await writeAll(secrets);
    return { ok: true };
  }

  async function getSecretSource(name) {
    const secrets = await readAll();
    const stored = secrets[name];
    if (typeof stored !== 'string' || !stored) return null;
    return stored.startsWith(ENCRYPTED_PREFIX) ? 'os-encrypted' : 'plain';
  }

  return { setSecret, getSecret, clearSecret, getSecretSource };
}

module.exports = { createSecretStore };
