'use strict';
/**
 * P2P connection manager for direct peer-to-peer messaging and file transfer.
 *
 * Establishes WebSocket connections to discovered peers and handles:
 * - Text messages
 * - File transfers (chunked for large files)
 * - Image sharing
 * - Connection lifecycle
 */
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_MESSAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const CHUNK_SIZE = 64 * 1024; // 64KB chunks
const CONNECTION_TIMEOUT_MS = 10000;

/**
 * @param {object} deps
 * @param {object} deps.identity - { id, displayName, hostname }
 * @param {number} deps.port - TCP port for incoming P2P connections
 * @param {(message: object) => void} deps.onMessage - callback for incoming messages
 * @param {(peerId: string, status: string) => void} [deps.onPeerStatus]
 * @param {object} [deps.logger]
 */
function createP2PConnection({
  identity,
  port,
  onMessage,
  onPeerStatus,
  logger = console,
} = {}) {
  if (!identity || !identity.id) throw new Error('createP2PConnection requires identity with id');
  if (!port) throw new Error('createP2PConnection requires port');
  if (typeof onMessage !== 'function') throw new Error('createP2PConnection requires onMessage callback');

  const connections = new Map(); // peerId -> { ws, peerInfo, lastSeen }
  let server = null;
  let running = false;

  function notifyPeerStatus(peerId, status) {
    if (typeof onPeerStatus === 'function') {
      try { onPeerStatus(peerId, status); } catch (error) {
        logger.warn?.('p2p peer status callback threw', { error: String(error.message || error) });
      }
    }
  }

  function createServer() {
    return new WebSocket.Server({ port, maxPayload: MAX_MESSAGE_SIZE });
  }

  function handleConnection(ws, req, peerInfo = null) {
    const peerId = peerInfo?.id || req?.socket?.remoteAddress;
    if (!peerId) {
      ws.close();
      return;
    }

    // Don't connect to ourselves
    if (peerId === identity.id) {
      ws.close();
      return;
    }

    // If already connected to this peer, close old connection
    const existing = connections.get(peerId);
    if (existing) {
      try { existing.ws.close(); } catch { /* already closed */ }
      connections.delete(peerId);
    }

    const conn = {
      ws,
      peerInfo: peerInfo || { id: peerId, displayName: `Peer-${peerId.slice(0, 8)}` },
      lastSeen: Date.now(),
      incoming: !peerInfo, // true if this is an incoming connection
    };

    connections.set(peerId, conn);
    notifyPeerStatus(peerId, 'connected');

    ws.on('message', (data) => {
      conn.lastSeen = Date.now();
      try {
        const message = JSON.parse(data.toString('utf8'));
        handleIncomingMessage(peerId, message);
      } catch (error) {
        logger.warn?.('p2p message parse failed', { peerId, error: String(error.message || error) });
      }
    });

    ws.on('close', () => {
      connections.delete(peerId);
      notifyPeerStatus(peerId, 'disconnected');
    });

    ws.on('error', (error) => {
      logger.warn?.('p2p connection error', { peerId, error: String(error.message || error) });
      connections.delete(peerId);
      notifyPeerStatus(peerId, 'error');
    });

    // Send handshake if we initiated the connection
    if (peerInfo) {
      sendHandshake(peerId);
    }

    logger.info?.('p2p connection established', { peerId, incoming: conn.incoming });
  }

  function handleIncomingMessage(peerId, message) {
    if (!message || typeof message !== 'object') return;

    switch (message.type) {
      case 'handshake':
        // Update peer info from handshake
        if (message.from && message.from.id) {
          const conn = connections.get(peerId);
          if (conn) {
            conn.peerInfo = message.from;
            // Send handshake response
            sendHandshake(peerId);
          }
        }
        break;

      case 'text':
        onMessage({
          from: peerId,
          type: 'text',
          content: message.content,
          timestamp: message.timestamp || Date.now(),
        });
        break;

      case 'file-start':
        onMessage({
          from: peerId,
          type: 'file-start',
          fileId: message.fileId,
          fileName: message.fileName,
          fileSize: message.fileSize,
          mimeType: message.mimeType,
          timestamp: message.timestamp || Date.now(),
        });
        break;

      case 'file-chunk':
        onMessage({
          from: peerId,
          type: 'file-chunk',
          fileId: message.fileId,
          chunkIndex: message.chunkIndex,
          totalChunks: message.totalChunks,
          data: message.data, // base64 encoded
          timestamp: message.timestamp || Date.now(),
        });
        break;

      case 'file-end':
        onMessage({
          from: peerId,
          type: 'file-end',
          fileId: message.fileId,
          timestamp: message.timestamp || Date.now(),
        });
        break;

      case 'image':
        onMessage({
          from: peerId,
          type: 'image',
          data: message.data, // base64 encoded
          timestamp: message.timestamp || Date.now(),
        });
        break;

      default:
        logger.warn?.('p2p unknown message type', { peerId, type: message.type });
    }
  }

  function sendHandshake(peerId) {
    const conn = connections.get(peerId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return;

    try {
      conn.ws.send(JSON.stringify({
        type: 'handshake',
        from: {
          id: identity.id,
          displayName: identity.displayName,
          hostname: identity.hostname,
        },
        timestamp: Date.now(),
      }));
    } catch (error) {
      logger.warn?.('p2p handshake send failed', { peerId, error: String(error.message || error) });
    }
  }

  async function connectToPeer(peerInfo) {
    if (!peerInfo || !peerInfo.ips || !peerInfo.port) {
      throw new Error('Invalid peer info: missing ips or port');
    }

    const peerId = peerInfo.id;
    if (peerId === identity.id) {
      throw new Error('Cannot connect to self');
    }

    // Already connected?
    if (connections.has(peerId)) {
      return { success: true, peerId };
    }

    // Try each IP until one works
    for (const ip of peerInfo.ips) {
      try {
        const url = `ws://${ip}:${peerInfo.port}`;
        logger.info?.('p2p connecting to peer', { peerId, url });

        const ws = new WebSocket(url, {
          handshakeTimeout: CONNECTION_TIMEOUT_MS,
          maxPayload: MAX_MESSAGE_SIZE,
        });

        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error('Connection timeout'));
          }, CONNECTION_TIMEOUT_MS);

          ws.on('open', () => {
            clearTimeout(timeout);
            handleConnection(ws, null, peerInfo);
            resolve();
          });

          ws.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });

        return { success: true, peerId };
      } catch (error) {
        logger.warn?.('p2p connect attempt failed', { peerId, ip, error: String(error.message || error) });
        continue; // Try next IP
      }
    }

    throw new Error(`Failed to connect to peer ${peerId} on any IP`);
  }

  function sendTextMessage(peerId, content) {
    const conn = connections.get(peerId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Not connected to peer ${peerId}`);
    }

    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('Message content must be a non-empty string');
    }

    try {
      conn.ws.send(JSON.stringify({
        type: 'text',
        content: content.slice(0, MAX_MESSAGE_SIZE),
        timestamp: Date.now(),
      }));
      return { success: true };
    } catch (error) {
      throw new Error(`Failed to send message: ${error.message}`);
    }
  }

  function sendFile(peerId, filePath) {
    const conn = connections.get(peerId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Not connected to peer ${peerId}`);
    }

    if (!fs.existsSync(filePath)) {
      throw new Error('File does not exist');
    }

    const stats = fs.statSync(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(`File too large (max ${MAX_FILE_SIZE} bytes)`);
    }

    const fileId = crypto.randomUUID();
    const fileName = path.basename(filePath);
    const totalChunks = Math.ceil(stats.size / CHUNK_SIZE);

    // Send file-start
    try {
      conn.ws.send(JSON.stringify({
        type: 'file-start',
        fileId,
        fileName,
        fileSize: stats.size,
        mimeType: 'application/octet-stream',
        timestamp: Date.now(),
      }));
    } catch (error) {
      throw new Error(`Failed to send file-start: ${error.message}`);
    }

    // Send chunks
    const fileBuffer = fs.readFileSync(filePath);
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, stats.size);
      const chunk = fileBuffer.subarray(start, end);
      const base64 = chunk.toString('base64');

      try {
        conn.ws.send(JSON.stringify({
          type: 'file-chunk',
          fileId,
          chunkIndex: i,
          totalChunks,
          data: base64,
          timestamp: Date.now(),
        }));
      } catch (error) {
        throw new Error(`Failed to send chunk ${i}: ${error.message}`);
      }
    }

    // Send file-end
    try {
      conn.ws.send(JSON.stringify({
        type: 'file-end',
        fileId,
        timestamp: Date.now(),
      }));
    } catch (error) {
      throw new Error(`Failed to send file-end: ${error.message}`);
    }

    return { success: true, fileId };
  }

  function sendImage(peerId, imagePath) {
    const conn = connections.get(peerId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Not connected to peer ${peerId}`);
    }

    if (!fs.existsSync(imagePath)) {
      throw new Error('Image does not exist');
    }

    const stats = fs.statSync(imagePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(`Image too large (max ${MAX_FILE_SIZE} bytes)`);
    }

    const imageBuffer = fs.readFileSync(imagePath);
    const base64 = imageBuffer.toString('base64');

    try {
      conn.ws.send(JSON.stringify({
        type: 'image',
        data: base64,
        timestamp: Date.now(),
      }));
      return { success: true };
    } catch (error) {
      throw new Error(`Failed to send image: ${error.message}`);
    }
  }

  function disconnectPeer(peerId) {
    const conn = connections.get(peerId);
    if (!conn) return { success: true };

    try {
      conn.ws.close();
      connections.delete(peerId);
      notifyPeerStatus(peerId, 'disconnected');
      return { success: true };
    } catch (error) {
      logger.warn?.('p2p disconnect failed', { peerId, error: String(error.message || error) });
      return { success: false, error: error.message };
    }
  }

  function start() {
    if (running) return false;

    try {
      server = createServer();
      server.on('connection', (ws, req) => {
        handleConnection(ws, req);
      });

      server.on('error', (error) => {
        logger.error?.('p2p server error', { error: String(error.message || error) });
      });

      running = true;
      logger.info?.('p2p server started', { port });
      return true;
    } catch (error) {
      logger.error?.('p2p server start failed', { error: String(error.message || error) });
      return false;
    }
  }

  function stop() {
    if (!running) return false;

    // Close all connections
    for (const [peerId, conn] of connections) {
      try {
        conn.ws.close();
        notifyPeerStatus(peerId, 'disconnected');
      } catch { /* already closed */ }
    }
    connections.clear();

    // Close server
    if (server) {
      try {
        server.close();
      } catch { /* already closed */ }
      server = null;
    }

    running = false;
    logger.info?.('p2p server stopped');
    return true;
  }

  function getConnectedPeers() {
    const peers = [];
    for (const [peerId, conn] of connections) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        peers.push({
          id: peerId,
          displayName: conn.peerInfo.displayName,
          hostname: conn.peerInfo.hostname,
          lastSeen: conn.lastSeen,
          incoming: conn.incoming,
        });
      }
    }
    return peers;
  }

  function status() {
    return {
      running,
      port,
      connectedPeers: getConnectedPeers(),
      totalConnections: connections.size,
    };
  }

  return {
    start,
    stop,
    connectToPeer,
    disconnectPeer,
    sendTextMessage,
    sendFile,
    sendImage,
    getConnectedPeers,
    status,
  };
}

module.exports = { createP2PConnection };
