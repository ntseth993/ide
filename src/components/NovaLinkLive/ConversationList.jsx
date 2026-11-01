/**
 * NovaLink Live conversation sidebar.
 *
 * Renders the ordered list of conversations the user has. Each row shows the
 * peer's avatar (or a fallback initial), display name, last message snippet,
 * relative timestamp, unread pill, and a presence dot. Search is scoped to
 * the loaded set — deep search lives in `UserDirectory` for finding new peers.
 */
import { useMemo, useState } from 'react';
import {
  selectConversations,
  selectUnreadFor,
  selectPresence,
  getSnapshot,
} from '../../services/novalinkLiveStore';

function relativeTime(input) {
  if (!input) return '';
  const then = typeof input === 'number' ? input : Date.parse(input);
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return new Date(then).toLocaleDateString();
}

const PRESENCE_TONE = {
  online: 'on',
  away: 'warn',
  busy: 'err',
  offline: 'off',
};

function titleFor(conversation, contacts) {
  if (conversation.title) return conversation.title;
  const otherId = (conversation.participants || []).find((id) => id !== conversation.selfId);
  const match = otherId && contacts.find((entry) => entry.id === otherId);
  if (match) return match.displayName || match.username || 'Unknown';
  return otherId ? `User ${otherId.slice(0, 6)}` : 'New conversation';
}

function initialsFor(name) {
  const trimmed = (name || '?').trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}

export default function ConversationList({ activeId, onSelect, onNewConversation, selfId }) {
  const [query, setQuery] = useState('');
  const conversations = selectConversations();
  const snapshot = getSnapshot();
  const contacts = snapshot.contacts || [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return conversations;
    return conversations.filter((entry) => titleFor(entry, contacts).toLowerCase().includes(needle));
  }, [conversations, query, contacts]);

  return (
    <aside className="novalink-side">
      <div className="novalink-side-head">
        <input
          type="search"
          placeholder="Search conversations"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="novalink-side-search"
          aria-label="Search conversations"
        />
        <button type="button" className="novalink-side-new" onClick={onNewConversation} aria-label="New conversation">
          +
        </button>
      </div>
      <ul className="novalink-side-list" role="listbox">
        {filtered.length === 0 ? (
          <li className="novalink-side-empty">
            {conversations.length === 0
              ? 'No conversations yet. Click + to find someone.'
              : 'No conversation matches that search.'}
          </li>
        ) : filtered.map((conversation) => {
          const title = titleFor(conversation, contacts);
          const unread = selectUnreadFor(conversation.id);
          const otherId = (conversation.participants || []).find((id) => id !== selfId);
          const presence = otherId ? selectPresence(otherId) : 'offline';
          const isActive = conversation.id === activeId;
          return (
            <li key={conversation.id}>
              <button
                type="button"
                role="option"
                aria-selected={isActive}
                className={`novalink-side-row ${isActive ? 'active' : ''}`}
                onClick={() => onSelect(conversation.id)}
              >
                <span className="novalink-avatar" data-presence={presence}>
                  <span className="novalink-avatar-initials">{initialsFor(title)}</span>
                  <span className={`novalink-presence-dot tone-${PRESENCE_TONE[presence] || 'off'}`} aria-hidden="true" />
                </span>
                <span className="novalink-side-body">
                  <span className="novalink-side-title">
                    {title}
                    {unread > 0 ? <span className="novalink-unread-pill" aria-label={`${unread} unread`}>{unread > 99 ? '99+' : unread}</span> : null}
                  </span>
                  <span className="novalink-side-snippet">{conversation.lastBody || 'No messages yet'}</span>
                </span>
                <span className="novalink-side-time">{relativeTime(conversation.lastAt)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
