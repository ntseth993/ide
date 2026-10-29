/**
 * NovaLink sidebar panel.
 *
 * A presentational view over ONE streamed snapshot from the main-process
 * collaboration service (client.onNovaLinkEvent). Every button maps to a narrow
 * preload call; this component never touches Node, the filesystem, or sockets.
 *
 * Honesty contract (spec §3): the Bluetooth transport is shown as clearly
 * "Not supported" with its reason and a best-effort adapter reading — we never
 * present a fake Bluetooth connection. The local-network transport is the one
 * that actually works today.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  NovaLinkIcon,
  BluetoothIcon,
  NetworkIcon,
  RefreshIcon,
  ShareIcon,
  SendIcon,
} from './Icons';
import { client, isDesktop, toUserMessage } from '../services/novaClient';

function shortFp(fp) {
  if (!fp) return '';
  return `${fp.slice(0, 4)}…${fp.slice(-4)}`;
}

const BT_POWER_LABEL = { on: 'On', off: 'Off', absent: 'No adapter found', unknown: 'Unknown' };

function formatBytes(n) {
  if (!Number.isFinite(n)) return '0 B';
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

const TRANSFER_TONE = {
  pending: 'tone-warn',
  offered: 'tone-warn',
  receiving: 'tone-info',
  transferring: 'tone-info',
  sent: 'tone-info',
  received: 'tone-ok',
  complete: 'tone-ok',
  failed: 'tone-error',
  cancelled: 'tone-muted',
  rejected: 'tone-muted',
};

function StatusChip({ transport }) {
  const supported = transport.supported;
  const bt = transport.kind === 'bluetooth';
  const adapter = transport.adapters?.[0];
  const adapterLine = bt
    ? `Adapter ${BT_POWER_LABEL[transport.power] || transport.power || 'unknown'}`
    : (adapter ? `Adapter ${adapter.state}` : '');
  const detail = [transport.detail, adapterLine].filter(Boolean).join(' · ');
  return (
    <span className={`nl-pill ${supported ? 'ok' : 'off'}`} title={detail}>
      <span className="nl-pill-icon" aria-hidden="true">{bt ? <BluetoothIcon size={13} /> : <NetworkIcon size={13} />}</span>
      <span className="nl-pill-name">{transport.label}</span>
      <span className="nl-pill-state">{supported ? 'Available' : 'Not supported'}</span>
    </span>
  );
}

function PeerRow({ peer, active, disabled, onSelect, onDisconnect }) {
  return (
    <div className={`nl-peer${active ? ' active' : ''}`}>
      <button type="button" className="nl-peer-main" onClick={() => onSelect(peer.peerId)} disabled={disabled}>
        <span className="nl-peer-avatar" aria-hidden="true">{(peer.name || '?').slice(0, 1).toUpperCase()}</span>
        <span className="nl-peer-meta">
          <span className="nl-name-row">
            <span className="nl-dot connected" title="Connected" />
            <span className="nl-peer-name">{peer.name}</span>
          </span>
          <span className="nl-peer-fp muted tiny" title="Cryptographic identity — verify out-of-band">
            {shortFp(peer.fp)}
          </span>
        </span>
      </button>
      <button type="button" className="small danger" onClick={() => onDisconnect(peer.peerId)}>Disconnect</button>
    </div>
  );
}

function ChatBubble({ entry }) {
  if (entry.kind === 'code') {
    return (
      <div className={`nl-msg ${entry.from}`}>
        <div className="nl-msg-code">
          <div className="nl-msg-code-head muted tiny">
            <span>{entry.language || 'code'}</span>
            {entry.path ? <span className="nl-msg-code-path">{entry.path}</span> : null}
          </div>
          <pre>{entry.text}</pre>
        </div>
      </div>
    );
  }
  return (
    <div className={`nl-msg ${entry.from}`}>
      <div className="nl-msg-bubble">{entry.text}</div>
    </div>
  );
}

function IncomingFileCard({ transfer, workspaceRoot, onSave, onReject, saveDrafts, setSaveDraft }) {
  const draft = saveDrafts[transfer.id] || { dir: 'NovaLink', name: transfer.name, overwrite: false };
  const canSave = transfer.status === 'received';
  return (
    <div className="nl-transfer in">
      <div className="nl-transfer-head">
        <span className="nl-transfer-title">{transfer.name}</span>
        <span className={`nl-transfer-status ${TRANSFER_TONE[transfer.status] || 'tone-muted'}`}>{transfer.status}</span>
      </div>
      <div className="muted tiny">
        from {transfer.peerName} · {formatBytes(transfer.size)}
        {transfer.sha256 ? ` · sha256 ${shortFp(transfer.sha256)}` : ''}
      </div>
      {transfer.status === 'receiving' && (
        <div className="nl-progress"><div className="nl-progress-bar" style={{ width: `${Math.min(100, (transfer.received / (transfer.size || 1)) * 100)}%` }} /></div>
      )}
      {transfer.status === 'pending' && (
        <div className="nl-transfer-actions">
          <p className="muted tiny">Accept to start receiving into staging. Nothing is saved or run until you choose a destination.</p>
          <button type="button" className="small" onClick={() => onSave('accept', transfer.id)}>Accept</button>
          <button type="button" className="small danger" onClick={() => onReject(transfer.id)}>Reject</button>
        </div>
      )}
      {transfer.preview != null && transfer.preview !== '' && (
        <pre className="nl-preview">{transfer.preview.slice(0, 4000)}</pre>
      )}
      {canSave && (
        <div className="nl-save">
          <label className="nl-save-field">
            <span className="muted tiny">Folder (in workspace)</span>
            <input value={draft.dir} onChange={(e) => setSaveDraft(transfer.id, { ...draft, dir: e.target.value })} />
          </label>
          <label className="nl-save-field">
            <span className="muted tiny">File name</span>
            <input value={draft.name} onChange={(e) => setSaveDraft(transfer.id, { ...draft, name: e.target.value })} />
          </label>
          <label className="nl-save-check">
            <input type="checkbox" checked={draft.overwrite} onChange={(e) => setSaveDraft(transfer.id, { ...draft, overwrite: e.target.checked })} />
            <span className="muted tiny">Allow overwrite if it exists</span>
          </label>
          <div className="nl-transfer-actions">
            <button type="button" className="small primary" disabled={!workspaceRoot} onClick={() => onSave('save', transfer.id, draft)}>
              Save into workspace
            </button>
          </div>
        </div>
      )}
      {transfer.status === 'complete' && transfer.savedPath && (
        <div className="nl-transfer-saved tiny">Saved to {transfer.savedPath}</div>
      )}
      {transfer.error && <div className="nl-transfer-error tiny">{transfer.error}</div>}
    </div>
  );
}

function OutgoingFileCard({ transfer, onCancel }) {
  return (
    <div className="nl-transfer out">
      <div className="nl-transfer-head">
        <span className="nl-transfer-title">{transfer.name}</span>
        <span className={`nl-transfer-status ${TRANSFER_TONE[transfer.status] || 'tone-muted'}`}>{transfer.status}</span>
      </div>
      <div className="muted tiny">to {transfer.peerName} · {formatBytes(transfer.size)}</div>
      {transfer.status === 'transferring' && (
        <div className="nl-progress"><div className="nl-progress-bar" style={{ width: `${Math.min(100, ((transfer.sent || 0) / (transfer.size || 1)) * 100)}%` }} /></div>
      )}
      {['offered', 'transferring'].includes(transfer.status) && (
        <div className="nl-transfer-actions">
          <button type="button" className="small" onClick={() => onCancel(transfer.id)}>Cancel</button>
        </div>
      )}
      {transfer.error && <div className="nl-transfer-error tiny">{transfer.error}</div>}
    </div>
  );
}

export default function NovaLinkView({ workspaceRoot, activeFilePath, getEditorSelection, onNotify, asTab = false }) {
  const [snap, setSnap] = useState(null);
  const [error, setError] = useState('');
  const [activePeer, setActivePeer] = useState('');
  const [draft, setDraft] = useState('');
  const [saveDrafts, setSaveDrafts] = useState({});
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Initial load + live subscription to the streamed snapshot.
  useEffect(() => {
    let active = true;
    client.novalinkStatus()
      .then((value) => { if (active) setSnap(value); })
      .catch((loadError) => { if (active) setError(toUserMessage(loadError)); });
    const unsubscribe = client.onNovaLinkEvent((next) => {
      if (!mounted.current) return;
      // Streamed snapshots omit async transport status; keep the last known.
      setSnap((prev) => ({
        ...next,
        transports: (next.transports && next.transports.length ? next.transports : prev?.transports) || [],
      }));
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  const setSaveDraft = useCallback((id, patch) => {
    setSaveDrafts((current) => ({ ...current, [id]: patch }));
  }, []);

  const run = useCallback(async (action, okMessage) => {
    setBusy(true);
    try {
      await action();
      if (okMessage) onNotify?.(okMessage, 'ok');
      setError('');
    } catch (runError) {
      const message = toUserMessage(runError);
      setError(message);
      onNotify?.(message, 'error');
    } finally {
      setBusy(false);
    }
  }, [onNotify]);

  const nearby = snap?.nearby || [];
  const incoming = snap?.requests?.incoming || [];
  const outgoing = snap?.requests?.outgoing || [];
  const peers = snap?.peers || [];
  const transports = snap?.transports || [];
  const bluetooth = snap?.bluetooth;
  const btTransport = transports.find((t) => t.kind === 'bluetooth');
  const btPower = bluetooth?.power || btTransport?.power || 'unknown';
  const btDevices = bluetooth?.devices || [];
  const btEnable = bluetooth?.lastEnable;
  const btCapability = bluetooth?.capability || btTransport?.capability || null;
  const activePeerObj = peers.find((p) => p.peerId === activePeer) || null;
  const chat = useMemo(() => (activePeer && snap?.chats?.[activePeer]) || [], [activePeer, snap]);

  const connectedTransfers = useMemo(
    () => (snap?.transfers || []).filter((t) => t.status !== 'ignored'),
    [snap],
  );

  if (!isDesktop) {
    return (
      <div className={`novalink-panel${asTab ? ' nl-tab' : ''}`} aria-label="NovaLink">
        <PanelHeader />
        <p className="nl-note muted tiny">NovaLink collaboration runs in the desktop app. Launch it with “npm run dev” or the installed build.</p>
      </div>
    );
  }

  return (
    <div className={`novalink-panel${asTab ? ' nl-tab' : ''}`} aria-label="NovaLink">
      <PanelHeader
        onRefresh={() => run(() => client.novalinkStatus().then(setSnap))}
        busy={busy}
      />

      {snap?.unavailable && <p className="nl-note muted tiny">{toUserMessage('NovaLink is unavailable in this build.')}</p>}
      {error && <div className="nl-error">{error}</div>}

      {/* Identity + transport availability — one compact hero */}
      <section className="nl-section nl-hero">
        <div className="nl-identity">
          <span className="nl-identity-avatar" aria-hidden="true">{(snap?.identity?.name || 'N').slice(0, 1).toUpperCase()}</span>
          <div className="nl-identity-text">
            <span className="nl-identity-name">{snap?.identity?.name || 'NovaCode'}</span>
            <span className="nl-identity-fp muted tiny" title="Your NovaLink fingerprint. Verify a peer's out-of-band before trusting it.">
              ID {shortFp(snap?.identity?.fingerprint)}
            </span>
          </div>
        </div>
        <div className="nl-pills">
          {transports.map((t) => <StatusChip key={t.id} transport={t} />)}
        </div>
      </section>

      {/* Bluetooth — real adapter, but app-to-app chat isn't supported over it yet,
          so it lives in a compact disclosure instead of a full always-open card. */}
      <details className="nl-details">
        <summary className="nl-summary">
          <BluetoothIcon size={14} />
          <span className="nl-summary-label">Bluetooth</span>
          <span className={`nl-bt-power ${btPower === 'on' ? 'ok' : 'off'}`}>
            {BT_POWER_LABEL[btPower] || btPower}
          </span>
        </summary>
        <div className="nl-details-body">
          <div className="nl-bt-detect">
            <div className="nl-bt-flags">
              <span className={`nl-bt-flag ${btCapability ? (btCapability.adapterPresent ? 'ok' : 'off') : ''}`}>
                {btCapability ? (btCapability.adapterPresent ? 'Adapter found' : 'No adapter') : 'Checking…'}
              </span>
              <span className={`nl-bt-flag ${btPower === 'on' ? 'ok' : 'off'}`}>{btPower === 'on' ? 'Bluetooth on' : 'Bluetooth off'}</span>
              <span className={`nl-bt-flag ${btCapability?.serviceRunning ? 'ok' : 'off'}`}>{btCapability?.serviceRunning ? 'Service running' : 'Service stopped'}</span>
              <span className={`nl-bt-flag ${btCapability?.canScan ? 'ok' : 'off'}`}>{btCapability?.canScan ? 'Can scan' : 'Cannot scan'}</span>
            </div>
            <p className="nl-note tiny">
              {btCapability?.dataSupported
                ? 'Bluetooth data transfer is available — connect a peer below to chat and share.'
                : 'NovaLink detects and scans Bluetooth, but streaming messages/files over the raw radio needs a native module. To collaborate now: pair the two PCs over a Bluetooth network (PAN), or use the Wi‑Fi / Ethernet Local network transport and Discover below.'}
            </p>
          </div>
          <div className="nl-actions">
            {btPower !== 'on' && (
              <button
                type="button"
                className="small primary"
                disabled={busy || btPower === 'absent'}
                onClick={() => run(async () => {
                  const result = await client.novalinkEnableBluetooth();
                  if (result?.ok) {
                    onNotify?.(result.alreadyOn ? 'Bluetooth is already on.' : 'Bluetooth enabled.', 'ok');
                    await client.novalinkScanBluetooth().catch(() => {});
                  } else if (result?.needsUserAction) {
                    onNotify?.(result.detail, 'warn');
                  } else {
                    onNotify?.(result?.detail || 'Could not enable Bluetooth.', 'error');
                  }
                  const fresh = await client.novalinkStatus();
                  setSnap(fresh);
                })}
              >
                Enable
              </button>
            )}
            <button
              type="button"
              className="small"
              disabled={busy || btPower === 'absent'}
              onClick={() => run(() => client.novalinkScanBluetooth())}
            >
              <RefreshIcon size={14} /> Scan
            </button>
          </div>
          {btPower === 'off' && <p className="nl-note tiny">Bluetooth is switched off on this machine.</p>}
          {btPower === 'absent' && <p className="nl-note tiny">No Bluetooth adapter was found on this device.</p>}
          {btEnable && !btEnable.ok && btEnable.needsUserAction && <p className="nl-note tiny">{btEnable.detail}</p>}
          {bluetooth?.scannedAt && (
            <div className="nl-bt-devices">
              <span className="muted tiny">Visible to Windows · {new Date(bluetooth.scannedAt).toLocaleTimeString()}</span>
              {btDevices.length === 0 && <p className="nl-note tiny">No Bluetooth devices are visible right now.</p>}
              {btDevices.map((device, index) => (
                <div key={`${device.name}-${index}`} className="nl-nearby">
                  <div className="nl-nearby-meta">
                    <span className="nl-nearby-name">{device.name}</span>
                    <span className="muted tiny">{device.isAdapter ? 'This PC\'s adapter' : (device.connected ? 'connected' : `status: ${device.status}`)}</span>
                  </div>
                  {!device.isAdapter && <span className="nl-bt-badge">not NovaLink</span>}
                </div>
              ))}
              <p className="nl-note tiny">NovaLink chats over the <strong>local network</strong>, not Bluetooth yet — use Discover to connect.</p>
            </div>
          )}
        </div>
      </details>

      {/* Discovery */}
      <section className="nl-section">
        <div className="nl-h-row">
          <h4 className="nl-h">Nearby developers</h4>
          {snap?.scanning && <span className="nl-scanning muted tiny">Scanning…</span>}
        </div>
        <div className="nl-actions">
          <button type="button" className="small primary" disabled={busy} onClick={() => run(() => client.novalinkDiscover())}>
            <RefreshIcon size={14} /> Discover
          </button>
          {snap?.scanning && (
            <button type="button" className="small" disabled={busy} onClick={() => run(() => client.novalinkStopDiscovery())}>Stop</button>
          )}
        </div>
        {nearby.length === 0 && <p className="nl-note muted tiny">No one in range yet. Hit Discover to look for nearby developers.</p>}
        {nearby.map((peer) => (
          <div key={peer.peerId} className="nl-nearby">
            <div className="nl-nearby-meta">
              <span className="nl-name-row">
                <span className="nl-dot available" title="Available" />
                <span className="nl-nearby-name">{peer.name}</span>
              </span>
              <span className="muted tiny">{peer.kind === 'lan' ? 'Local network' : peer.kind} · {shortFp(peer.fp)}</span>
            </div>
            <button type="button" className="small" disabled={busy} onClick={() => run(() => client.novalinkConnect(peer.peerId), `Connecting to ${peer.name}…`)}>
              Connect
            </button>
          </div>
        ))}
      </section>

      {/* Connection requests */}
      {(incoming.length > 0 || outgoing.length > 0) && (
        <section className="nl-section">
          <h4 className="nl-h">Connection requests</h4>
          {incoming.map((req) => (
            <div key={req.peerId} className="nl-request">
              <div className="nl-request-meta">
                <span className="nl-request-name">{req.name}</span>
                <span className="muted tiny">wants to connect · ID {shortFp(req.fp)}</span>
              </div>
              <div className="nl-request-actions">
                <button type="button" className="small primary" disabled={busy} onClick={() => run(() => client.novalinkAcceptConnection(req.peerId).then(() => setActivePeer(req.peerId)), 'Connected')}>Accept</button>
                <button type="button" className="small danger" disabled={busy} onClick={() => run(() => client.novalinkRejectConnection(req.peerId))}>Reject</button>
              </div>
            </div>
          ))}
          {outgoing.map((req) => (
            <div key={req.peerId} className="nl-request outgoing">
              <div className="nl-request-meta">
                <span className="nl-name-row">
                  <span className="nl-dot connecting" title="Connecting" />
                  <span className="nl-request-name">{req.name}</span>
                </span>
                <span className="muted tiny">waiting for them to accept…</span>
              </div>
              <button type="button" className="small" disabled={busy} onClick={() => run(() => client.novalinkDisconnect(req.peerId))}>Cancel</button>
            </div>
          ))}
        </section>
      )}

      {/* Connected peers */}
      <section className="nl-section">
        <h4 className="nl-h">Connected peers</h4>
        {peers.length === 0 && <p className="nl-note muted tiny">No connected peers yet. Accept a request or connect to a nearby device.</p>}
        {peers.map((peer) => (
          <PeerRow
            key={peer.peerId}
            peer={peer}
            active={peer.peerId === activePeer}
            disabled={busy}
            onSelect={setActivePeer}
            onDisconnect={(id) => run(() => client.novalinkDisconnect(id), 'Disconnected')}
          />
        ))}
      </section>

      {/* Chat + sharing (needs a selected connected peer) */}
      {activePeerObj && (
        <section className="nl-section nl-chat">
          <h4 className="nl-h">Chat with {activePeerObj.name}</h4>
          <div className="nl-messages">
            {chat.length === 0 && <p className="nl-note muted tiny">Say hello — messages stay on your local network and are encrypted in transit.</p>}
            {chat.map((entry) => <ChatBubble key={entry.id} entry={entry} />)}
          </div>
          <form
            className="nl-compose"
            onSubmit={(event) => {
              event.preventDefault();
              const text = draft.trim();
              if (!text) return;
              run(() => client.novalinkSendMessage(activePeer, text)).then(() => setDraft(''));
            }}
          >
            <input
              value={draft}
              placeholder="Message…"
              aria-label="Message"
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" className="icon-button" title="Send" aria-label="Send" disabled={busy}>
              <SendIcon size={15} />
            </button>
          </form>

          <div className="nl-actions nl-share">
            <button
              type="button"
              className="small"
              disabled={busy || !workspaceRoot}
              onClick={() => {
                const sel = getEditorSelection?.();
                if (!sel || !sel.text) { onNotify?.('Select some code in the editor first.', 'error'); return; }
                run(() => client.novalinkShareCode({ peerId: activePeer, text: sel.text, language: sel.language, path: sel.path }), 'Shared selected code');
              }}
            >
              <ShareIcon size={14} /> Share Selected Code
            </button>
            <button
              type="button"
              className="small"
              disabled={busy || !workspaceRoot || !activeFilePath}
              onClick={() => {
                if (!activeFilePath) { onNotify?.('Open a file to share it.', 'error'); return; }
                run(() => client.novalinkShareFile({ peerId: activePeer, root: workspaceRoot, path: activeFilePath }), 'Offering file — waiting for them to accept');
              }}
            >
              <ShareIcon size={14} /> Share File
            </button>
          </div>
          {!workspaceRoot && <p className="nl-note muted tiny">Open a folder to share files.</p>}
        </section>
      )}

      {/* Transfers */}
      {connectedTransfers.length > 0 && (
        <section className="nl-section">
          <h4 className="nl-h">Transfers</h4>
          {connectedTransfers.map((transfer) => (
            transfer.direction === 'in'
              ? (
                <IncomingFileCard
                  key={transfer.id}
                  transfer={transfer}
                  workspaceRoot={workspaceRoot}
                  saveDrafts={saveDrafts}
                  setSaveDraft={setSaveDraft}
                  onSave={(mode, id, draftState) => run(async () => {
                    if (mode === 'accept') return client.novalinkAcceptTransfer(id);
                    return client.novalinkSaveTransfer({
                      transferId: id,
                      root: workspaceRoot,
                      dir: draftState.dir,
                      name: draftState.name,
                      overwrite: draftState.overwrite,
                    });
                  }, mode === 'accept' ? 'Receiving transfer…' : 'File saved into your workspace')}
                  onReject={(id) => run(() => client.novalinkRejectTransfer(id))}
                />
              )
              : (
                <OutgoingFileCard
                  key={transfer.id}
                  transfer={transfer}
                  onCancel={(id) => run(() => client.novalinkCancelTransfer(id))}
                />
              )
          ))}
        </section>
      )}
    </div>
  );
}

function PanelHeader({ onRefresh, busy }) {
  return (
    <div className="panel-header">
      <h3 className="nl-title"><NovaLinkIcon size={16} /> NovaLink</h3>
      {onRefresh && (
        <button type="button" className="icon-button" title="Refresh status" onClick={onRefresh} disabled={busy}>
          <RefreshIcon size={15} />
        </button>
      )}
    </div>
  );
}
