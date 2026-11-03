/**
 * NovaLink Live root orchestrator.
 *
 * Owns the three cross-cutting concerns the chat surface depends on:
 *   1. The single subscription to the main-process frame stream and status
 *      stream; every frame is funneled into `novalinkLiveStore` so any
 *      component can read from it via `useSyncExternalStore`.
 *   2. Bootstrap hydration: whenever `ready` flips true (either on first
 *      connection or after a hard reconnect) we call
 *      `client.novalinkLiveBootstrap()` and feed the response to the store.
 *      Ordinary users never see a "Refresh bootstrap" button; the store just
 *      fills itself in when the socket says hello.
 *   3. Choice of top-level surface: AuthScreen when signed out, ChatWorkspace
 *      when signed in. DiagnosticsPanel is mounted only when the developer
 *      gate is on.
 *
 * Presence: when we connect we fire `sendPresence('online')` once; when the
 * document regains focus we fire it again. We do NOT send 'offline' from the
 * renderer — the server derives that from socket close, which is more
 * honest than trusting a renderer that might be mid-crash.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { client, toUserMessage } from '../../services/novaClient';
import * as store from '../../services/novalinkLiveStore';
import AuthScreen from './AuthScreen';
import ChatWorkspace from './ChatWorkspace';
import DiagnosticsPanel from './DiagnosticsPanel';
import LanConnectionPanel from './LanConnectionPanel';

export default function NovaLinkLiveRoot({
  getEditorSelection,
  onNotify,
  showDiagnostics = false,
  asTab,
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const status = snapshot.status;
  const ready = Boolean(snapshot.ready);
  const signedIn = Boolean(snapshot.signedIn);
  const [error, setError] = useState('');
  const bootstrappedRef = useRef(false);

  // Wire the frame stream + status stream into the store exactly once per
  // mount. The store itself is a module singleton so two mounts (which
  // shouldn't happen, but tests do it) will still be consistent as long as
  // only one is at the ready.
  useEffect(() => {
    const unsubscribeEvent = client.onNovaLinkLiveEvent((frame) => store.handleFrame(frame));
    const unsubscribeStatus = client.onNovaLinkLiveStatus((snap) => store.handleStatus(snap));
    // Prime with a synchronous status pull; the pushed updates take over from
    // there.
    client.novalinkLiveStatus()
      .then((snap) => store.handleStatus(snap))
      .catch((caught) => setError(toUserMessage(caught, 'NovaLink Live status failed.')));
    return () => {
      try { unsubscribeEvent?.(); } catch { /* already gone */ }
      try { unsubscribeStatus?.(); } catch { /* already gone */ }
    };
  }, []);

  // Open conversation from a notification click.
  useEffect(() => {
    const unsubscribe = client.onNovaLinkLiveOpenConversation?.((payload) => {
      if (payload?.conversationId) store.setActiveConversation(payload.conversationId);
    });
    return () => { try { unsubscribe?.(); } catch { /* noop */ } };
  }, []);

  // Auto-bootstrap whenever `ready` flips true. We do NOT re-fetch on every
  // frame; a single shot per session keeps the app quiet on the network.
  useEffect(() => {
    if (!ready) {
      bootstrappedRef.current = false;
      return;
    }
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    (async () => {
      try {
        const data = await client.novalinkLiveBootstrap();
        store.ingestBootstrap(data);
        // Try to open the most recent conversation as the default landing.
        if (!store.selectActiveId()) {
          const list = store.selectConversations();
          const mostRecent = list[0];
          if (mostRecent?.id) store.setActiveConversation(mostRecent.id);
        }
      } catch (caught) {
        bootstrappedRef.current = false;
        onNotify?.({ tone: 'error', message: toUserMessage(caught, 'NovaLink bootstrap failed.') });
      }
    })();
  }, [ready, onNotify]);

  // Presence: fire an `online` on first ready and again on window focus. The
  // server tracks offline via close, so we don't need to send it.
  useEffect(() => {
    if (!ready) return undefined;
    client.novalinkLiveSendPresence('online').catch(() => { /* best-effort */ });
    const onFocus = () => client.novalinkLiveSendPresence('online').catch(() => {});
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [ready]);

  const handleSignedIn = useCallback((result) => {
    if (result?.user) store.ingestBootstrap({ user: result.user });
  }, []);

  const body = signedIn
    ? <ChatWorkspace status={status} getEditorSelection={getEditorSelection} onNotify={onNotify} />
    : <AuthScreen status={status} onSignedIn={handleSignedIn} onNotify={onNotify} />;

  return (
    <section className={`panel novalink-live ${asTab ? 'as-tab' : ''}`}>
      {error ? <p className="novalink-live-error" role="alert">{error}</p> : null}
      <LanConnectionPanel status={status} onNotify={onNotify} />
      {body}
      {showDiagnostics ? <DiagnosticsPanel status={status} onNotify={onNotify} /> : null}
    </section>
  );
}
