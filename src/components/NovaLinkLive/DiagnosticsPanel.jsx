/**
 * NovaLink Live developer diagnostics panel.
 *
 * Ordinary users never see this component. It surfaces the connection state
 * exactly as the main process reports it, the raw frame feed, the last
 * socket error, and — critically — the base-URL override that lets a
 * developer point a packaged build at a laptop link-server without rebuilding.
 *
 * Visibility is controlled by the parent: `settings.developer.novalinkDiagnostics`
 * OR `window.__novaEnv?.NOVALINK_DEV === '1'` at boot. Nothing here mutates
 * that gate; it just trusts it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { client, toUserMessage } from '../../services/novaClient';

const MAX_EVENT_PREVIEW = 60;

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function summariseFrame(frame) {
  if (!frame || typeof frame !== 'object') return 'invalid frame';
  switch (frame.type) {
    case 'ready':
      return `ready — user ${frame.user?.username || '?'}, ${frame.sessions?.length || 0} sessions`;
    case 'presence':
      return `presence — ${frame.userId?.slice(0, 8)}… → ${frame.status || '?'}`;
    case 'typing':
      return `typing — ${frame.name || 'Someone'} ${frame.typing ? 'is typing' : 'stopped'}`;
    case 'message':
      return `message — ${(frame.message?.body || '').slice(0, 60)}`;
    case 'message.delivered':
      return `delivered — ${frame.conversationId?.slice(0, 8)}… seq ${frame.seq}`;
    case 'message.read':
      return `read — ${frame.conversationId?.slice(0, 8)}… seq ${frame.seq}`;
    case 'unread':
      return `unread — ${frame.total} total`;
    case 'reaction':
      return `reaction — ${frame.emoji || '?'} on ${frame.messageId?.slice(0, 8)}…`;
    case 'connection.request':
      return `connection request — ${frame.from?.username || 'someone'}`;
    case 'connection.accepted':
      return `connection accepted — ${frame.user?.username || 'someone'}`;
    case 'call.incoming':
      return `call incoming — ${frame.call?.mode || 'audio'}`;
    case 'call.signal':
      return `call signal — ${frame.signal} from ${frame.fromName || '?'}`;
    case 'call.ended':
      return `call ended — reason ${frame.reason || 'unknown'}`;
    case 'pong':
      return `pong — server ${formatTime(frame.serverTime)}`;
    case 'error':
      return `error — ${frame.code || 'unknown'}: ${frame.message || ''}`;
    default:
      return frame.type || 'unknown';
  }
}

function StatusDot({ tone }) {
  const color = tone === 'on' ? 'var(--success, #4ade80)'
    : tone === 'warn' ? 'var(--warning, #facc15)'
      : tone === 'err' ? 'var(--error, #f87171)'
        : 'var(--muted, #94a3b8)';
  return <span className="novalink-diag-dot" style={{ background: color }} aria-hidden="true" />;
}

function StatusRow({ label, value, tone = 'off' }) {
  return (
    <div className="novalink-diag-row">
      <StatusDot tone={tone} />
      <span className="novalink-diag-label">{label}</span>
      <span className="novalink-diag-value">{value}</span>
    </div>
  );
}

export default function DiagnosticsPanel({ status, onNotify }) {
  const [baseUrlDraft, setBaseUrlDraft] = useState(status?.baseUrl || '');
  const [events, setEvents] = useState([]);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (status?.baseUrl && !baseUrlDraft) setBaseUrlDraft(status.baseUrl);
  }, [status?.baseUrl, baseUrlDraft]);

  useEffect(() => {
    const unsubscribeEvents = client.onNovaLinkLiveEvent((frame) => {
      setEvents((prev) => {
        const next = prev.length >= MAX_EVENT_PREVIEW ? prev.slice(prev.length - MAX_EVENT_PREVIEW + 1) : prev.slice();
        next.push({ ts: Date.now(), frame });
        return next;
      });
    });
    return () => { try { unsubscribeEvents?.(); } catch { /* already gone */ } };
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [events]);

  const run = useCallback(async (label, action) => {
    setBusy(true);
    try {
      const result = await action();
      onNotify?.({ tone: 'ok', message: `NovaLink diagnostics: ${label} succeeded.` });
      return result;
    } catch (error) {
      onNotify?.({ tone: 'error', message: toUserMessage(error, `NovaLink diagnostics: ${label} failed.`) });
      return null;
    } finally {
      setBusy(false);
    }
  }, [onNotify]);

  const saveBaseUrl = () => run('configure', () => client.novalinkLiveConfigure({ baseUrl: baseUrlDraft.trim() }));
  const reboot = () => run('boot', () => client.novalinkLiveBoot({ baseUrl: baseUrlDraft.trim() || undefined }));
  const reconnect = () => run('reconnect', () => client.novalinkLiveReconnect());

  const configured = Boolean(status?.configured);
  const signedIn = Boolean(status?.signedIn);
  const connected = Boolean(status?.connected);
  const ready = Boolean(status?.ready);

  const subtitle = useMemo(() => {
    if (!status) return 'Awaiting first status snapshot.';
    if (!configured) return 'Not configured. Enter a URL or rebuild with NOVALINK_LIVE_URL set.';
    if (signedIn && ready && connected) return 'Connected and authenticated.';
    if (signedIn && !connected) return 'Signed in but socket closed; auto-reconnect in progress.';
    if (!signedIn) return 'Configured but not signed in.';
    return 'Working.';
  }, [status, configured, signedIn, connected, ready]);

  return (
    <section className="novalink-diag" aria-label="NovaLink diagnostics">
      <header className="novalink-diag-head">
        <h3>Developer diagnostics</h3>
        <p className="hint">{subtitle}</p>
      </header>
      <div className="novalink-diag-status">
        <StatusRow label="Base URL" value={status?.baseUrl || 'Not configured'} tone={configured ? 'on' : 'off'} />
        <StatusRow label="Signed in" value={signedIn ? (status?.user?.username || 'yes') : 'no'} tone={signedIn ? 'on' : 'off'} />
        <StatusRow
          label="Socket"
          value={connected ? (ready ? 'connected (ready)' : 'connecting') : 'closed'}
          tone={connected && ready ? 'on' : connected ? 'warn' : 'off'}
        />
        {status?.lastError ? (
          <StatusRow label="Last error" value={`${status.lastError} (${formatTime(status.lastErrorAt)})`} tone="err" />
        ) : null}
        {status?.reconnectAttempt ? (
          <StatusRow label="Reconnect" value={`attempt ${status.reconnectAttempt}`} tone="warn" />
        ) : null}
      </div>
      <div className="novalink-diag-controls">
        <label className="field">
          <span>link-server address</span>
          <input
            type="url"
            value={baseUrlDraft}
            onChange={(event) => setBaseUrlDraft(event.target.value)}
            placeholder="https://link.example.com"
            disabled={busy || signedIn}
          />
        </label>
        <p className="hint">
          {signedIn
            ? 'Sign out before pointing the app at a different server; the credential is not portable across origins.'
            : 'Any change here is local to this install and is not persisted to the packaged default.'}
        </p>
        <div className="novalink-diag-buttons">
          <button type="button" onClick={saveBaseUrl} disabled={busy || signedIn}>Save &amp; configure</button>
          <button type="button" onClick={reboot} disabled={busy}>Re-boot</button>
          <button type="button" onClick={reconnect} disabled={busy || !signedIn}>Reconnect now</button>
        </div>
      </div>
      <div className="novalink-diag-stream">
        <h4>Live server frames <span className="count">({events.length})</span></h4>
        <div className="novalink-diag-events" ref={scrollRef}>
          {events.length === 0 ? (
            <p className="hint">Frames will appear here as the server pushes them.</p>
          ) : (
            events.map((entry, index) => (
              <div className="novalink-diag-event" key={`${entry.ts}-${index}`}>
                <span className="time">{formatTime(entry.ts)}</span>
                <code>{summariseFrame(entry.frame)}</code>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
