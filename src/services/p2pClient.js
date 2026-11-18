/**
 * Renderer-side client for NovaLink P2P automatic sharing.
 *
 * Provides a friendly API for the renderer to interact with the P2P service
 * via IPC. Handles message/peer events and provides methods for peer discovery,
 * connection, messaging, and file sharing.
 */
import { nova, isDesktop, toUserMessage } from './novaClient';

export const p2p = {
  // Service lifecycle
  async start() {
    if (!isDesktop) throw new Error('P2P requires NovaCode desktop app');
    if (!nova?.novalinkP2pStart) throw new Error('P2P service not available. Restart NovaCode.');
    return await nova.novalinkP2pStart();
  },

  async stop() {
    if (!isDesktop) throw new Error('P2P requires NovaCode desktop app');
    if (!nova?.novalinkP2pStop) throw new Error('P2P service not available. Restart NovaCode.');
    return await nova.novalinkP2pStop();
  },

  async status() {
    if (!isDesktop) return { running: false };
    if (!nova?.novalinkP2pStatus) return { running: false };
    return await nova.novalinkP2pStatus();
  },

  // Identity management
  async getIdentity() {
    if (!isDesktop) return null;
    if (!nova?.novalinkP2pGetIdentity) return null;
    return await nova.novalinkP2pGetIdentity();
  },

  async updateDisplayName(displayName) {
    if (!isDesktop) throw new Error('P2P requires NovaCode desktop app');
    if (!nova?.novalinkP2pUpdateDisplayName) throw new Error('P2P service not available. Restart NovaCode.');
    return await nova.novalinkP2pUpdateDisplayName({ displayName });
  },

  // Peer discovery and connections
  async getDiscoveredPeers() {
    if (!isDesktop) return { peers: [] };
    if (!nova?.novalinkP2pGetDiscoveredPeers) return { peers: [] };
    return await nova.novalinkP2pGetDiscoveredPeers();
  },

  async getConnectedPeers() {
    if (!isDesktop) return { peers: [] };
    if (!nova?.novalinkP2pGetConnectedPeers) return { peers: [] };
    return await nova.novalinkP2pGetConnectedPeers();
  },

  async connectToPeer(peerId) {
    if (!isDesktop) throw new Error('P2P requires NovaCode desktop app');
    if (!nova?.novalinkP2pConnectToPeer) throw new Error('P2P service not available. Restart NovaCode.');
    return await nova.novalinkP2pConnectToPeer({ peerId });
  },

  async disconnectPeer(peerId) {
    if (!isDesktop) throw new Error('P2P requires NovaCode desktop app');
    if (!nova?.novalinkP2pDisconnectPeer) throw new Error('P2P service not available. Restart NovaCode.');
    return await nova.novalinkP2pDisconnectPeer({ peerId });
  },

  // Messaging and file sharing
  async sendMessage(peerId, content) {
    if (!isDesktop) throw new Error('P2P requires NovaCode desktop app');
    if (!nova?.novalinkP2pSendMessage) throw new Error('P2P service not available. Restart NovaCode.');
    return await nova.novalinkP2pSendMessage({ peerId, content });
  },

  async sendFile(peerId, filePath) {
    if (!isDesktop) throw new Error('P2P requires NovaCode desktop app');
    if (!nova?.novalinkP2pSendFile) throw new Error('P2P service not available. Restart NovaCode.');
    return await nova.novalinkP2pSendFile({ peerId, filePath });
  },

  async sendImage(peerId, imagePath) {
    if (!isDesktop) throw new Error('P2P requires NovaCode desktop app');
    if (!nova?.novalinkP2pSendImage) throw new Error('P2P service not available. Restart NovaCode.');
    return await nova.novalinkP2pSendImage({ peerId, imagePath });
  },

  // Auto-connect toggle
  async setAutoConnect(enabled) {
    if (!isDesktop) throw new Error('P2P requires NovaCode desktop app');
    if (!nova?.novalinkP2pSetAutoConnect) throw new Error('P2P service not available. Restart NovaCode.');
    return await nova.novalinkP2pSetAutoConnect({ enabled });
  },
};

/**
 * Event listener setup for P2P events.
 * Call this in your component's useEffect to listen for P2P events.
 */
export function setupP2PEventListeners({
  onMessage,
  onPeers,
  onPeerStatus,
}) {
  if (!isDesktop || !nova) return () => {};

  const messageHandler = (_event, data) => {
    if (typeof onMessage === 'function') onMessage(data);
  };

  const peersHandler = (_event, data) => {
    if (typeof onPeers === 'function') onPeers(data.peers || []);
  };

  const peerStatusHandler = (_event, data) => {
    if (typeof onPeerStatus === 'function') onPeerStatus(data.peerId, data.status);
  };

  // Register listeners using the preload API
  const cleanupMessage = nova.onNovaLinkP2pMessage?.(messageHandler) || (() => {});
  const cleanupPeers = nova.onNovaLinkP2pPeers?.(peersHandler) || (() => {});
  const cleanupPeerStatus = nova.onNovaLinkP2pPeerStatus?.(peerStatusHandler) || (() => {});

  // Return cleanup function
  return () => {
    cleanupMessage();
    cleanupPeers();
    cleanupPeerStatus();
  };
}

export default p2p;
