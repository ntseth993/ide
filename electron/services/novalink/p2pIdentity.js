'use strict';
/**
 * P2P identity management for automatic local network sharing.
 *
 * Each user gets a persistent identity (UUID + display name) stored in userData.
 * This identity is advertised over the LAN so peers can discover and connect.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IDENTITY_FILE = 'novalink-p2p-identity.json';
const MAX_DISPLAY_NAME = 32;

/**
 * Generate or load a persistent P2P identity.
 * @param {object} deps
 * @param {string} deps.dataDir - writable directory for identity storage
 * @param {object} [deps.logger]
 */
function createP2PIdentity({ dataDir, logger = console } = {}) {
  if (!dataDir) throw new Error('createP2PIdentity requires a writable dataDir.');

  const identityPath = path.join(dataDir, IDENTITY_FILE);
  let identity = null;

  function loadIdentity() {
    try {
      if (fs.existsSync(identityPath)) {
        const raw = fs.readFileSync(identityPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.id && parsed.displayName) {
          identity = {
            id: String(parsed.id).trim(),
            displayName: String(parsed.displayName || '').trim().slice(0, MAX_DISPLAY_NAME),
            hostname: os.hostname(),
            createdAt: parsed.createdAt || Date.now(),
          };
          logger.info?.('p2p identity loaded', { id: identity.id, displayName: identity.displayName });
          return identity;
        }
      }
    } catch (error) {
      logger.warn?.('p2p identity load failed, will create new', { error: String(error.message || error) });
    }
    return null;
  }

  function saveIdentity() {
    if (!identity) return false;
    try {
      fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2), 'utf8');
      return true;
    } catch (error) {
      logger.error?.('p2p identity save failed', { error: String(error.message || error) });
      return false;
    }
  }

  function ensureIdentity() {
    if (identity) return identity;
    const loaded = loadIdentity();
    if (loaded) {
      identity = loaded;
      return identity;
    }
    // Create new identity
    identity = {
      id: crypto.randomUUID(),
      displayName: `User-${crypto.randomBytes(2).toString('hex').toUpperCase()}`,
      hostname: os.hostname(),
      createdAt: Date.now(),
    };
    if (saveIdentity()) {
      logger.info?.('p2p identity created', { id: identity.id, displayName: identity.displayName });
    }
    return identity;
  }

  function updateDisplayName(newName) {
    const trimmed = String(newName || '').trim().slice(0, MAX_DISPLAY_NAME);
    if (!trimmed) return false;
    ensureIdentity();
    identity.displayName = trimmed;
    return saveIdentity();
  }

  function getIdentity() {
    return identity ? { ...identity } : null;
  }

  function reset() {
    identity = null;
    try {
      if (fs.existsSync(identityPath)) {
        fs.unlinkSync(identityPath);
      }
    } catch (error) {
      logger.warn?.('p2p identity reset failed', { error: String(error.message || error) });
    }
  }

  return {
    ensureIdentity,
    getIdentity,
    updateDisplayName,
    reset,
  };
}

module.exports = { createP2PIdentity, IDENTITY_FILE };
