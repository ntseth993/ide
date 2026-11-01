/**
 * NovaLink Live message thread.
 *
 * Renders the ordered message list for the active conversation with day
 * dividers, sender alignment, delivery/read ticks, reactions, typing
 * indicator, and typed content routing (text bubble / code block / file chip).
 *
 * The thread is a dumb view: everything it draws comes from the store's
 * selectors, which Root keeps in sync with the live frame stream.
 */
import { useEffect, useMemo, useRef } from 'react';
import {
  selectMessages,
  selectTyping,
  selectReactions,
  selectSelf,
  getSnapshot,
} from '../../services/novalinkLiveStore';
import CodeSnippet from './CodeSnippet';
import FileAttachment from './FileAttachment';

function dayKey(ts) {
  const date = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function dayLabel(ts) {
  const date = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(date) === dayKey(today)) return 'Today';
  if (dayKey(date) === dayKey(yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function timeOnly(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function senderName(message, self) {
  if (message.fromUserId && self && message.fromUserId === self.id) return self.displayName || self.username || 'You';
  return message.fromName || message.fromUsername || 'Peer';
}

function Delivery({ message, isSelf }) {
  if (!isSelf) return null;
  if (message.pending) return <span className="novalink-tick pending" title="Sending…">◔</span>;
  if (message.failed) return <span className="novalink-tick failed" title="Failed to send">!</span>;
  if (message.readAt) return <span className="novalink-tick read" title="Read">✓✓</span>;
  if (message.deliveredAt) return <span className="novalink-tick delivered" title="Delivered">✓✓</span>;
  return <span className="novalink-tick sent" title="Sent">✓</span>;
}

function ReactionBar({ messageId }) {
  const reactions = selectReactions(messageId);
  const entries = Object.entries(reactions || {});
  if (entries.length === 0) return null;
  return (
    <div className="novalink-reactions">
      {entries.map(([emoji, userIds]) => (
        <span key={emoji} className="novalink-reaction" title={userIds.join(', ')}>
          {emoji}<span className="count">{userIds.length}</span>
        </span>
      ))}
    </div>
  );
}

function Bubble({ message, isSelf, self }) {
  const body = message.body || '';
  const kind = message.kind || (message.metadata?.language ? 'code' : 'text');
  const attachments = message.attachments || [];
  return (
    <div className={`novalink-bubble ${isSelf ? 'own' : 'peer'} kind-${kind}`}>
      <div className="novalink-bubble-head">
        <span className="novalink-bubble-sender">{senderName(message, self)}</span>
        <span className="novalink-bubble-time" title={new Date(message.createdAt || message.timestamp || Date.now()).toString()}>
          {timeOnly(message.createdAt || message.timestamp || Date.now())}
        </span>
      </div>
      {kind === 'code' ? (
        <CodeSnippet
          code={body}
          language={message.metadata?.language}
          path={message.metadata?.path}
          sender={senderName(message, self)}
        />
      ) : body ? (
        <div className="novalink-bubble-body">{body}</div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="novalink-bubble-attachments">
          {attachments.map((attachment, index) => (
            <FileAttachment key={attachment.id || `a${index}`} attachment={attachment} outgoing={isSelf} />
          ))}
        </div>
      ) : null}
      <ReactionBar messageId={message.id} />
      <div className="novalink-bubble-foot">
        {message.editedAt ? <span className="novalink-bubble-edited">edited</span> : null}
        {message.deleted ? <span className="novalink-bubble-deleted">deleted</span> : null}
        <Delivery message={message} isSelf={isSelf} />
      </div>
    </div>
  );
}

export default function MessageThread({ conversationId, onNotify }) {
  const scrollRef = useRef(null);
  const self = selectSelf();
  const messages = selectMessages(conversationId);
  const typing = selectTyping(conversationId);
  const snapshot = getSnapshot();
  const conversations = snapshot.conversations || [];
  const conversation = useMemo(
    () => conversations.find((entry) => entry.id === conversationId) || null,
    [conversations, conversationId],
  );

  // Auto-scroll to the newest bubble on any thread change; the user can scroll
  // up manually and the effect only re-fires when the length actually changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, conversationId]);

  if (!conversationId) {
    return (
      <div className="novalink-thread novalink-thread-empty">
        <p>Select a conversation on the left, or press <strong>+</strong> to start a new one.</p>
      </div>
    );
  }

  const items = [];
  let lastDay = null;
  for (const message of messages) {
    const stamp = message.createdAt || message.timestamp || Date.now();
    const key = dayKey(stamp);
    if (key !== lastDay) {
      items.push(<div className="novalink-day" key={`day-${key}`}>{dayLabel(stamp)}</div>);
      lastDay = key;
    }
    const isSelf = self && message.fromUserId === self.id;
    items.push(<Bubble key={message.id || `m-${items.length}`} message={message} isSelf={isSelf} self={self} />);
  }

  return (
    <div className="novalink-thread" role="log" aria-live="polite" ref={scrollRef}>
      {conversation?.title ? (
        <header className="novalink-thread-head">
          <h3>{conversation.title}</h3>
        </header>
      ) : null}
      {items.length === 0 ? (
        <p className="novalink-thread-empty-hint">No messages yet. Say hello.</p>
      ) : items}
      {typing.length > 0 ? (
        <div className="novalink-typing">
          {typing.slice(0, 3).join(', ')}
          {typing.length > 3 ? ` +${typing.length - 3}` : ''}
          {' '}typing
          <span className="novalink-typing-dots" aria-hidden="true"><i /><i /><i /></span>
        </div>
      ) : null}
    </div>
  );
}
