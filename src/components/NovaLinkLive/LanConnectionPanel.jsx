/**
 * NovaLink P2P connection panel.
 *
 * Automatic peer-to-peer sharing without requiring a server.
 * Users on the same network automatically discover each other and can
 * send messages, files, and images directly.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toUserMessage } from '../../services/novaClient';
import p2p, { setupP2PEventListeners } from '../../services/p2pClient';

export default function LanConnectionPanel({ onNotify }) {
  const [running, setRunning] = useState(false);
  const [identity, setIdentity] = useState(null);
  const [peers, setPeers] = useState([]);
  const [connected, setConnected] = useState([]);
  const [messages, setMessages] = useState([]);
  const [selectedPeer, setSelectedPeer] = useState(null);
  const [messageInput, setMessageInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // P2P event listeners
  useEffect(() => {
    const cleanup = setupP2PEventListeners({
      onMessage: (msg) => {
        if (mountedRef.current) {
          setMessages((prev) => [...prev, msg]);
        }
      },
      onPeers: (peerList) => {
        if (mountedRef.current) {
          setPeers(peerList);
        }
      },
      onPeerStatus: (peerId, status) => {
        if (mountedRef.current) {
          p2p.getConnectedPeers().then((result) => {
            setConnected(result.peers || []);
          });
        }
      },
    });
    return cleanup;
  }, []);

  // Load initial P2P status
  useEffect(() => {
    p2p.status().then((status) => {
      if (mountedRef.current) {
        setRunning(status.running);
        if (status.identity) setIdentity(status.identity);
        // If running, also fetch discovered peers
        if (status.running) {
          p2p.getDiscoveredPeers().then((result) => {
            if (mountedRef.current) setPeers(result.peers || []);
          }).catch(() => {});
          p2p.getConnectedPeers().then((result) => {
            if (mountedRef.current) setConnected(result.peers || []);
          }).catch(() => {});
        }
      }
    }).catch(() => {});
  }, []);

  const handleStart = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await p2p.start();
      if (result?.success) {
        setRunning(true);
        if (result.identity) setIdentity(result.identity);
        onNotify?.({ tone: 'ok', message: 'P2P sharing started' });
      }
    } catch (caught) {
      const msg = toUserMessage(caught, 'Failed to start P2P');
      setError(msg);
      onNotify?.({ tone: 'error', message: msg });
    } finally {
      setBusy(false);
    }
  };

  const handleConnect = async (peerId) => {
    setBusy(true);
    setError('');
    try {
      await p2p.connectToPeer(peerId);
      const result = await p2p.getConnectedPeers();
      setConnected(result.peers || []);
    } catch (caught) {
      const msg = toUserMessage(caught, 'Failed to connect');
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleSendMessage = async () => {
    if (!selectedPeer || !messageInput.trim()) return;
    setBusy(true);
    try {
      await p2p.sendMessage(selectedPeer, messageInput);
      setMessages((prev) => [
        ...prev,
        {
          from: identity?.id,
          to: selectedPeer,
          type: 'text',
          content: messageInput,
          timestamp: Date.now(),
        },
      ]);
      setMessageInput('');
    } catch (caught) {
      const msg = toUserMessage(caught, 'Failed to send message');
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateName = async (newName) => {
    try {
      await p2p.updateDisplayName(newName);
      const updated = await p2p.getIdentity();
      setIdentity(updated);
    } catch (caught) {
      const msg = toUserMessage(caught, 'Failed to update name');
      setError(msg);
    }
  };

  return (
    <section className="novalink-p2p" aria-label="P2P Sharing">
      {error && (
        <div className="p2p-error">
          {error}
          <button onClick={() => setError('')}>&times;</button>
        </div>
      )}

      {!running ? (
        <div className="p2p-start">
          <h2>P2P Sharing</h2>
          <p className="hint">Connect with people on your network to share messages and files directly - no server needed.</p>
          <button type="button" onClick={handleStart} disabled={busy} className="p2p-button primary">
            Create Account
          </button>
        </div>
      ) : (
        <div className="p2p-main">
          {/* Identity */}
          <div className="p2p-identity">
            <input
              type="text"
              value={identity?.displayName || ''}
              onChange={(e) => setIdentity({ ...identity, displayName: e.target.value })}
              onBlur={(e) => handleUpdateName(e.target.value)}
              maxLength={32}
              disabled={busy}
              placeholder="Your name"
            />
          </div>

          {/* Peers */}
          <div className="p2p-section">
            <h3>People on your network ({peers.length})</h3>
            {peers.length === 0 ? (
              <p className="hint">Looking for people on your network...</p>
            ) : (
              <ul className="p2p-peer-list">
                {peers.map((peer) => {
                  const isConnected = connected.some((p) => p.id === peer.id);
                  return (
                    <li key={peer.id} className={`p2p-peer ${selectedPeer === peer.id ? 'selected' : ''}`}>
                      <div className="peer-info" onClick={() => setSelectedPeer(peer.id)}>
                        <span className="peer-name">{peer.displayName}</span>
                        <span className="peer-status">{isConnected ? '● Connected' : '○ Available'}</span>
                      </div>
                      {!isConnected ? (
                        <button
                          type="button"
                          onClick={() => handleConnect(peer.id)}
                          disabled={busy}
                          className="p2p-button small"
                        >
                          Connect
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Chat */}
          {selectedPeer && (
            <div className="p2p-chat">
              <h3>Chat with {connected.find((p) => p.id === selectedPeer)?.displayName || 'Peer'}</h3>
              <div className="p2p-messages">
                {messages
                  .filter(
                    (m) =>
                      (m.from === selectedPeer && m.to === identity?.id) ||
                      (m.from === identity?.id && m.to === selectedPeer)
                  )
                  .map((msg, idx) => (
                    <div
                      key={idx}
                      className={`p2p-message ${msg.from === identity?.id ? 'sent' : 'received'}`}
                    >
                      <span className="message-content">{msg.content}</span>
                      <span className="message-time">
                        {new Date(msg.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
              </div>
              <div className="p2p-input">
                <input
                  type="text"
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
                  placeholder="Type a message..."
                  disabled={busy}
                />
                <button type="button" onClick={handleSendMessage} disabled={busy || !messageInput.trim()}>
                  Send
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
