/**
 * NovaLink Live user directory modal.
 *
 * Search other registered NovaCode users by username, start a DM, or send a
 * connection request when you're not yet contacts. The modal is a controlled
 * child — Root owns its open state — so the parent can auto-refresh the
 * conversation list after a successful "Start chat".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { client, toUserMessage } from '../../services/novaClient';

export default function UserDirectory({ open, onClose, onConversationStarted, selfId, contacts = [], onNotify }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setError('');
      const timer = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [open]);

  const runSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await client.novalinkLiveSearchUsers({ q: trimmed });
      const users = Array.isArray(response?.users) ? response.users : [];
      setResults(users.filter((entry) => entry.id !== selfId));
    } catch (caught) {
      setError(toUserMessage(caught, 'User search failed.'));
    } finally {
      setBusy(false);
    }
  }, [query, selfId]);

  useEffect(() => {
    if (!open) return undefined;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      return undefined;
    }
    const timer = setTimeout(runSearch, 250);
    return () => clearTimeout(timer);
  }, [query, open, runSearch]);

  async function startChat(user) {
    setBusy(true);
    setError('');
    try {
      const alreadyConnected = contacts.some((entry) => entry.id === user.id);
      if (!alreadyConnected) {
        await client.novalinkLiveRequestConnection({ toUserId: user.id });
        onNotify?.({ tone: 'ok', message: `Connection request sent to ${user.username}.` });
        return;
      }
      const response = await client.novalinkLiveCreateConversation({ participants: [user.id], kind: 'dm' });
      const conversation = response?.conversation;
      if (conversation?.id) {
        onConversationStarted?.(conversation);
        onClose?.();
      }
    } catch (caught) {
      setError(toUserMessage(caught, 'Could not start conversation.'));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="novalink-modal-backdrop" role="dialog" aria-modal="true" aria-label="Find people">
      <div className="novalink-modal">
        <header className="novalink-modal-head">
          <h3>Find people</h3>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">Close</button>
        </header>
        <div className="novalink-modal-body">
          <input
            ref={inputRef}
            type="search"
            className="novalink-modal-search"
            placeholder="Search by username…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search users"
          />
          {error ? <p className="novalink-modal-error">{error}</p> : null}
          <ul className="novalink-modal-results">
            {busy && results.length === 0 ? <li className="hint">Searching…</li> : null}
            {!busy && query.trim().length < 2 ? <li className="hint">Type at least two characters.</li> : null}
            {!busy && query.trim().length >= 2 && results.length === 0 ? <li className="hint">No users matched.</li> : null}
            {results.map((user) => (
              <li key={user.id} className="novalink-modal-row">
                <div className="novalink-modal-row-body">
                  <span className="novalink-modal-name">{user.displayName || user.username}</span>
                  <span className="novalink-modal-handle">@{user.username}</span>
                </div>
                <button type="button" onClick={() => startChat(user)} disabled={busy}>
                  {contacts.some((entry) => entry.id === user.id) ? 'Start chat' : 'Request connection'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
