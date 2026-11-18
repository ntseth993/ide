'use strict';
/**
 * Unified P2P service for automatic local network sharing.
 *
 * Combines identity, discovery, and connection management into a single service
 * that automatically discovers peers on the same network and enables direct
 * file/message/image sharing without requiring a server.
 *
 * Usage:
 *   const p2p = createP2PService({ dataDir, onMessage, onPeers, onPeerStatus, logger });
 *   p2p.start(); // Auto-discovers peers and starts listening for connections
 *   p2p.connectToPeer(peerId);
 *   p2p.sendMessage(peerId, 'Hello');
 *   p2p.sendFile(peerId, '/path/to/file');
 *   p2p.stop();
 */
const { createP2PIdentity } = require('./p2pIdentity');
const { createP2PDiscovery } = require('./p2pDiscovery');
const { createP2PConnection } = require('./p2pConnection');

const DEFAULT_P2P_PORT = 53533;

/**
 * @param {object} deps
 * @param {string} deps.dataDir - writable directory for identity storage
 * @param {(message: object) => void} deps.onMessage - callback for incoming messages
 * @param {(peers: object[]) => void} [deps.onPeers] - callback for discovered peers
 * @param {(peerId: string, status: string) => void} [deps.onPeerStatus] - callback for peer connection status
 * @param {object} [deps.logger]
 * @param {number} [deps.port] - TCP port for P2P connections
 */
function createP2PService({
  dataDir,
  onMessage,
  onPeers,
  onPeerStatus,
  logger = console,
  port = DEFAULT_P2P_PORT,
} = {}) {
  if (!dataDir) throw new Error('createP2PService requires dataDir');
  if (typeof onMessage !== 'function') throw new Error('createP2PService requires onMessage callback');

  // Initialize sub-services
  const identity = createP2PIdentity({ dataDir, logger });
  const discovery = createP2PDiscovery({
    identity: identity.ensureIdentity(),
    port,
    onPeers: (peers) => {
      if (typeof onPeers === 'function') onPeers(peers);
    },
    logger,
  });

  const connection = createP2PConnection({
    identity: identity.ensureIdentity(),
    port,
    onMessage: (message) => {
      onMessage(message);
    },
    onPeerStatus: (peerId, status) => {
      if (typeof onPeerStatus === 'function') onPeerStatus(peerId, status);
    },
    logger,
  });

  let running = false;
  let autoConnectEnabled = true;

  // Auto-connect to newly discovered peers
  discovery.onPeers = (peers) => {
    if (typeof onPeers === 'function') onPeers(peers);

    if (autoConnectEnabled && running) {
      for (const peer of peers) {
        if (!connection.getConnectedPeers().find(p => p.id === peer.id)) {
          // Auto-connect to new peers (fire-and-forget)
          connection.connectToPeer(peer).catch((error) => {
            logger.warn?.('p2p auto-connect failed', { peerId: peer.id, error: String(error.message || error) });
          });
        }
      }
    }
  };

  function start() {
    if (running) return { success: true, identity: identity.getIdentity() };

    // Ensure identity exists
    const id = identity.ensureIdentity();
    logger.info?.('p2p service starting', { identityId: id.id, displayName: id.displayName, port });

    // Start connection server first
    if (!connection.start()) {
      throw new Error('Failed to start P2P connection server');
    }

    // Start discovery
    if (!discovery.start()) {
      logger.warn?.('p2p discovery failed to start, continuing without it');
    }

    running = true;
    logger.info?.('p2p service started', { port, autoConnect: autoConnectEnabled });
    return { success: true, identity: id };
  }

  function stop() {
    if (!running) return { success: true };

    discovery.stop();
    connection.stop();
    running = false;

    logger.info?.('p2p service stopped');
    return { success: true };
  }

  function getIdentity() {
    return identity.getIdentity();
  }

  function updateDisplayName(newName) {
    const success = identity.updateDisplayName(newName);
    if (success && running) {
      // Restart discovery to announce new name
      discovery.stop();
      discovery.identity = identity.getIdentity();
      discovery.start();
    }
    return { success };
  }

  function getDiscoveredPeers() {
    return discovery.listPeers();
  }

  function getConnectedPeers() {
    return connection.getConnectedPeers();
  }

  function connectToPeer(peerId) {
    const peer = discovery.getPeer(peerId);
    if (!peer) {
      throw new Error(`Peer ${peerId} not found or expired`);
    }
    return connection.connectToPeer(peer);
  }

  function disconnectPeer(peerId) {
    return connection.disconnectPeer(peerId);
  }

  function sendMessage(peerId, content) {
    return connection.sendTextMessage(peerId, content);
  }

  function sendFile(peerId, filePath) {
    return connection.sendFile(peerId, filePath);
  }

  function sendImage(peerId, imagePath) {
    return connection.sendImage(peerId, imagePath);
  }

  function setAutoConnect(enabled) {
    autoConnectEnabled = Boolean(enabled);
    logger.info?.('p2p auto-connect changed', { enabled: autoConnectEnabled });
  }

  function status() {
    return {
      running,
      identity: identity.getIdentity(),
      discovery: discovery.status(),
      connection: connection.status(),
      autoConnect: autoConnectEnabled,
    };
  }

  return {
    start,
    stop,
    getIdentity,
    updateDisplayName,
    getDiscoveredPeers,
    getConnectedPeers,
    connectToPeer,
    disconnectPeer,
    sendMessage,
    sendFile,
    sendImage,
    setAutoConnect,
    status,
  };
}

module.exports = { createP2PService, DEFAULT_P2P_PORT };
