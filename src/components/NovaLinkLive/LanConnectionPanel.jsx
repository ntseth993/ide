/**
 * NovaLink LAN connection panel.
 *
 * Lets a user find a NovaLink Live host on the same Wi-Fi without typing an IP,
 * pick it, and — separately — offer to host on this machine. It is a thin view:
 * every UDP socket and the host child process live in the main process and are
 * reached only through the narrow `novalinkLan*` IPC bridge (see client).
 *
 * States it surfaces, per the connection spec:
 *   Searching · Host Found · Connecting · Connected · Disconnected
 * plus a manual-IP fallback for networks that block multicast, and a compact
 * host on/off control that reports this machine's LAN address once it is up.
 *
 * It never signs in or bypasses authentication. Selecting a host only points
 * the existing Live client at that base URL; the normal AuthScreen then drives
 * real sign-in against the discovered server.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { client, toUserMessage } from '../../services/novaClient';

const MAX_IP_SHOWN = 2;

function derivePhase({ status, hosts, scanning, connecting }) {
  if (status?.ready && status?.connected) return 'connected';
  if (connecting || (status?.signedIn && status?.connected) || (status?.configured && !status?.connected && status?.reconnectAttempt > 0)) return 'connecting';
  if (hosts.length > 0) return 'found';
  if (scanning) return 'searching';
  return 'disconnected';
}

const PHASE_LABEL = {
  searching: 'Searching the local network…',
  found: 'NovaLink host found',
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Disconnected',
};

function HostBadge({ phase }) {
  const tone = phase === 'connected' ? 'on'
    : phase === 'found' || phase === 'connecting' ? 'warn'
      : 'off';
  return <span className={`novalink-lan-badge novalink-lan-badge--${tone}`} data-phase={phase}>{PHASE_LABEL[phase] || 'Disconnected'}</span>;
}

export default function LanConnectionPanel({ status, onNotify }) {
  const [hosts, setHosts] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [hostStatus, setHostStatus] = useState(null);
  const [manual, setManual] = useState({ address: '', port: '10000', tls: false });
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Subscribe to the main-process scanner list + this machine's host status.
  useEffect(() => {
    const unsubHosts = client.onNovaLinkLanHosts?.((payload) => {
      if (!mountedRef.current) return;
      const list = Array.isArray(payload) ? payload : (payload?.hosts || []);
      setHosts(list);
      if (list.length > 0) setScanning(false);
    });
    const unsubStatus = client.onNovaLinkLanHostStatus?.((snap) => {
      if (mountedRef.current && snap && typeof snap === 'object') setHostStatus(snap);
    });
    // Prime with a synchronous pull so a panel opened after a scan isn't blank.
    client.novalinkLanStatus?.().then((snap) => {
      if (!mountedRef.current || !snap) return;
      setHosts(snap.hosts || []);
      setScanning(Boolean(snap.scanning));
    }).catch(() => { /* not wired outside desktop */ });
    client.novalinkLanHostStatus?.().then((snap) => {
      if (mountedRef.current && snap) setHostStatus(snap);
    }).catch(() => {});
    return () => {
      try { unsubHosts?.(); } catch { /* already gone */ }
      try { unsubStatus?.(); } catch { /* already gone */ }
    };
  }, []);

  const phase = useMemo(
    () => derivePhase({ status, hosts, scanning, connecting }),
    [status, hosts, scanning, connecting],
  );

  const run = useCallback(async (label, action, { silent = false } = {}) => {
    setBusy(true);
    setError('');
    try {
      const result = await action();
      if (!silent) onNotify?.({ tone: 'ok', message: `NovaLink: ${label}.` });
      return result;
    } catch (caught) {
      const msg = toUserMessage(caught, `NovaLink: ${label} failed.`);
      setError(msg);
      onNotify?.({ tone: 'error', message: msg });
      return null;
    } finally {
      setBusy(false);
    }
  }, [onNotify]);

  const scan = () => run('Searching the local network', async () => {
    setScanning(true);
    const result = await client.novalinkLanScan();
    if (result) {
      setScanning(Boolean(result.scanning));
      setHosts(result.hosts || []);
      if ((result.hosts || []).length === 0) {
        // Keep scanning flag on so the label reads "Searching…" until the first
        // host arrives or the user stops; the main process re-queries itself.
        setScanning(true);
      }
    }
    return result;
  }, { silent: true });

  const stopScan = () => run('Stopped searching', async () => {
    const result = await client.novalinkLanStopScan();
    if (result) setScanning(false);
    return result;
  }, { silent: true });

  const connectTo = (host) => run(`Connecting to ${host.name || host.host}`, async () => {
    setConnecting(true);
    setSelectedId(host.id);
    try {
      const result = await client.novalinkLanSelectHost({ hostId: host.id });
      if (result?.ok) {
        onNotify?.({ tone: 'ok', message: `Now sign in to ${host.name || result.baseUrl}.` });
      }
      return result;
    } finally {
      // The socket handshake is owned by the Live client; drop the transient
      // "connecting" hint and let the real status snapshot drive the badge.
      setConnecting(false);
    }
  }, { silent: true });

  const connectManual = () => run('Connecting to the address you entered', async () => {
    setConnecting(true);
    try {
      const port = parseInt(manual.port, 10);
      const result = await client.novalinkLanManualConnect({
        address: manual.address.trim(),
        port: Number.isFinite(port) ? port : undefined,
        tls: Boolean(manual.tls),
      });
      if (result?.ok) onNotify?.({ tone: 'ok', message: `Now sign in at ${result.baseUrl}.` });
      return result;
    } finally {
      setConnecting(false);
    }
  }, { silent: true });

  const toggleHost = () => run(hostStatus?.running ? 'Stopped hosting' : 'Started hosting', async () => {
    if (hostStatus?.running) {
      const stopped = await client.novalinkLanStopHost();
      setHostStatus(stopped);
      return stopped;
    }
    const started = await client.novalinkLanStartHost({});
    setHostStatus(started);
    return started;
  });

  const connectedName = status?.baseUrl || '';
  const showConnectButton = phase !== 'connected';

  return (
    <section className="novalink-lan" aria-label="NovaLink local network">
      <header className="novalink-lan-head">
        <HostBadge phase={phase} />
        {connectedName && phase === 'connected'
          ? <span className="novalink-lan-target" title={connectedName}>{connectedName.replace(/^https?:\/\//, '')}</span>
          : null}
        <button
          type="button"
          className="novalink-lan-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? 'Hide' : 'LAN options'}
        </button>
      </header>

      {error ? <p className="novalink-lan-error" role="alert">{error}</p> : null}

      {expanded ? (
        <div className="novalink-lan-body">
          <div className="novalink-lan-scan">
            {showConnectButton ? (
              scanning && hosts.length === 0
                ? <button type="button" onClick={stopScan} disabled={busy}>Stop searching</button>
                : <button type="button" onClick={scan} disabled={busy}>{hosts.length ? 'Search again' : 'Search the network'}</button>
            ) : null}
          </div>

          <ul className="novalink-lan-hosts" aria-label="Discovered hosts">
            {hosts.length === 0
              ? <li className="novalink-lan-empty hint">
                {scanning ? 'Looking for a NovaLink host on this Wi-Fi…' : 'No hosts found yet. Start NovaLink hosting on the other PC, then search.'}
              </li>
              : hosts.map((host) => (
                <li key={host.id} className={`novalink-lan-host ${selectedId === host.id ? 'selected' : ''}`}>
                  <div className="novalink-lan-host-meta">
                    <span className="novalink-lan-host-name">{host.name || host.host || 'NovaLink host'}</span>
                    <span className="novalink-lan-host-addr">
                      {(host.ips || []).slice(0, MAX_IP_SHOWN).join(', ') || host.baseUrl}
                      {host.port ? `:${host.port}` : ''}{host.tls ? ' (tls)' : ''}
                    </span>
                  </div>
                  <button type="button" onClick={() => connectTo(host)} disabled={busy || phase === 'connecting'}>
                    {selectedId === host.id && phase !== 'disconnected' ? 'Connect again' : 'Connect'}
                  </button>
                </li>
              ))}
          </ul>

          <div className="novalink-lan-manual">
            <p className="hint">Wi-Fi blocks discovery? Type the host PC&rsquo;s IP address.</p>
            <div className="novalink-lan-manual-row">
              <input
                type="text"
                inputMode="numeric"
                placeholder="192.168.1.42"
                value={manual.address}
                onChange={(e) => setManual((m) => ({ ...m, address: e.target.value }))}
                aria-label="Host IP address"
                disabled={busy}
              />
              <input
                type="text"
                inputMode="numeric"
                placeholder="port"
                value={manual.port}
                onChange={(e) => setManual((m) => ({ ...m, port: e.target.value }))}
                aria-label="Port"
                disabled={busy}
              />
              <button type="button" onClick={connectManual} disabled={busy || !manual.address.trim()}>
                Connect by IP
              </button>
            </div>
          </div>

          <div className="novalink-lan-host-control">
            <div className="novalink-lan-host-control-text">
              <strong>Host on this computer</strong>
              {hostStatus?.running ? (
                <span className="hint">
                  Running on port {hostStatus.port}. Peers can reach it at
                  {' '}{(hostStatus.ips || []).slice(0, MAX_IP_SHOWN).map((ip) => `http://${ip}:${hostStatus.port}`).join('  ·  ') || '(no LAN address yet)'}
                </span>
              ) : (
                <span className="hint">Turn this PC into a NovaLink host so others on the Wi-Fi can find it.</span>
              )}
            </div>
            <button type="button" onClick={toggleHost} disabled={busy} className={hostStatus?.running ? 'danger' : ''}>
              {hostStatus?.running ? 'Stop hosting' : 'Start hosting'}
            </button>
            {hostStatus?.lastError && !hostStatus?.running ? (
              <p className="novalink-lan-host-error hint">{hostStatus.lastError}</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
