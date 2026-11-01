/**
 * NovaLink Live message composer.
 *
 * Enter sends, Shift+Enter inserts a newline. Attachments are picked locally
 * (never exceed 25 MB / 8 files per message, matching the server limit) and
 * uploaded through the main process before the message body references them.
 * The composer also exposes a "Share code" button that reads the current
 * editor selection through the `getEditorSelection()` prop from App.jsx and
 * dispatches it as a `kind:'code'` message.
 *
 * Typing indicator: while the input is non-empty we fire `sendTyping(true)`
 * at most every 1.5 s and `sendTyping(false)` when the user stops for 2 s or
 * hits send. That is the whole protocol.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { client, toUserMessage } from '../../services/novaClient';
import { optimisticSend, reconcilePending } from '../../services/novalinkLiveStore';
import FileAttachment from './FileAttachment';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 8;
const MAX_BODY_CHARS = 8000;
const TYPING_PULSE_MS = 1500;
const TYPING_IDLE_MS = 2000;
const FILENAME_STRIP = /[/\\\r\n\t]+/g;

function sanitizeName(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return 'attachment';
  const withoutSeparators = trimmed.replace(FILENAME_STRIP, '_');
  return withoutSeparators.slice(-160) || 'attachment';
}

function newPendingId() {
  return `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function Composer({ conversationId, selfId, getEditorSelection, onNotify, active }) {
  const [body, setBody] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const typingPulseRef = useRef(null);
  const typingIdleRef = useRef(null);
  const lastTypingSignalRef = useRef(0);

  const trimmedBody = body.trim();
  const canSend = !sending && !uploading && conversationId
    && (trimmedBody.length > 0 || attachments.length > 0)
    && (trimmedBody.length <= MAX_BODY_CHARS);

  useEffect(() => {
    if (active) textareaRef.current?.focus();
  }, [active, conversationId]);

  useEffect(() => () => {
    if (typingPulseRef.current) clearInterval(typingPulseRef.current);
    if (typingIdleRef.current) clearTimeout(typingIdleRef.current);
  }, []);

  const signalTyping = useCallback((typing) => {
    if (!conversationId || !selfId) return;
    client.novalinkLiveSendTyping({ conversationId, typing }).catch(() => { /* best-effort */ });
  }, [conversationId, selfId]);

  function onChange(event) {
    const next = event.target.value;
    setBody(next.slice(0, MAX_BODY_CHARS + 1));
    if (!conversationId) return;
    const now = Date.now();
    if (next.trim().length === 0) {
      if (typingPulseRef.current) { clearInterval(typingPulseRef.current); typingPulseRef.current = null; }
      if (typingIdleRef.current) { clearTimeout(typingIdleRef.current); typingIdleRef.current = null; }
      if (lastTypingSignalRef.current) {
        lastTypingSignalRef.current = 0;
        signalTyping(false);
      }
      return;
    }
    if (!typingPulseRef.current) {
      lastTypingSignalRef.current = now;
      signalTyping(true);
      typingPulseRef.current = setInterval(() => {
        // Re-affirm typing every 1.5 s while the user is still typing.
        signalTyping(true);
      }, TYPING_PULSE_MS);
    }
    if (typingIdleRef.current) clearTimeout(typingIdleRef.current);
    typingIdleRef.current = setTimeout(() => {
      if (typingPulseRef.current) { clearInterval(typingPulseRef.current); typingPulseRef.current = null; }
      lastTypingSignalRef.current = 0;
      signalTyping(false);
    }, TYPING_IDLE_MS);
  }

  function stopTypingSignals() {
    if (typingPulseRef.current) { clearInterval(typingPulseRef.current); typingPulseRef.current = null; }
    if (typingIdleRef.current) { clearTimeout(typingIdleRef.current); typingIdleRef.current = null; }
    if (lastTypingSignalRef.current) {
      lastTypingSignalRef.current = 0;
      signalTyping(false);
    }
  }

  async function onPickFiles(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      onNotify?.({ tone: 'error', message: `Max ${MAX_ATTACHMENTS} attachments per message.` });
      event.target.value = '';
      return;
    }
    const picked = files.slice(0, room);
    setUploading(true);
    const uploaded = [];
    try {
      for (const file of picked) {
        if (file.size > MAX_FILE_BYTES) {
          onNotify?.({ tone: 'error', message: `${sanitizeName(file.name)} exceeds the 25 MB cap.` });
          continue;
        }
        if (file.size === 0) {
          onNotify?.({ tone: 'error', message: `${sanitizeName(file.name)} is empty.` });
          continue;
        }
        const buffer = new Uint8Array(await file.arrayBuffer());
        const response = await client.novalinkLiveUploadFile({
          bytes: buffer,
          fileName: sanitizeName(file.name),
          mimeType: file.type || 'application/octet-stream',
        });
        if (response?.file?.id) {
          uploaded.push({ ...response.file, fileName: sanitizeName(file.name), size: file.size });
        }
      }
      if (uploaded.length) {
        setAttachments((current) => [...current, ...uploaded]);
      }
    } catch (caught) {
      onNotify?.({ tone: 'error', message: toUserMessage(caught, 'Upload failed.') });
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  }

  function removeAttachment(id) {
    setAttachments((current) => current.filter((entry) => entry.id !== id));
  }

  async function send({ kind = 'text', code = null, meta = null } = {}) {
    if (!conversationId) return;
    const content = kind === 'code' ? (code || '') : trimmedBody;
    if (!content && attachments.length === 0) return;
    setSending(true);
    const pendingId = newPendingId();
    const optimistic = {
      id: pendingId,
      conversationId,
      fromUserId: selfId,
      fromName: selfId ? undefined : 'You',
      body: content,
      kind,
      metadata: meta || undefined,
      attachmentIds: attachments.map((entry) => entry.id),
      attachments: attachments.slice(),
      createdAt: Date.now(),
      pending: true,
    };
    optimisticSend(conversationId, optimistic);
    stopTypingSignals();
    try {
      const response = await client.novalinkLiveSendMessage({
        conversationId,
        body: content,
        kind: kind === 'code' ? 'code' : undefined,
        metadata: meta || undefined,
        attachmentIds: optimistic.attachmentIds,
      });
      reconcilePending(conversationId, pendingId, response?.message || null);
      setBody('');
      setAttachments([]);
    } catch (caught) {
      const message = toUserMessage(caught, 'Send failed.');
      optimisticSend(conversationId, { ...optimistic, failed: true, pending: false, error: message });
      onNotify?.({ tone: 'error', message });
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  function onKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSend) send();
    }
  }

  function shareCode() {
    const selection = typeof getEditorSelection === 'function' ? getEditorSelection() : null;
    if (!selection || !selection.text) {
      onNotify?.({ tone: 'error', message: 'Select some code in the editor first.' });
      return;
    }
    send({
      kind: 'code',
      code: selection.text,
      meta: { language: selection.language || null, path: selection.path || null },
    });
  }

  const attachmentCount = useMemo(() => attachments.length, [attachments]);

  return (
    <div className={`novalink-composer ${!conversationId ? 'disabled' : ''}`}>
      {attachmentCount > 0 ? (
        <div className="novalink-composer-attachments">
          {attachments.map((entry) => (
            <FileAttachment
              key={entry.id}
              attachment={entry}
              outgoing
              progress={uploading ? 99 : 100}
            />
          ))}
          <button type="button" className="ghost tiny" onClick={() => setAttachments([])}>Clear all</button>
        </div>
      ) : null}
      <div className="novalink-composer-row">
        <textarea
          ref={textareaRef}
          className="novalink-composer-input"
          placeholder={conversationId ? 'Message (Enter to send, Shift+Enter for newline)' : 'Select a conversation to start chatting'}
          value={body}
          onChange={onChange}
          onKeyDown={onKeyDown}
          disabled={!conversationId || sending || uploading}
          rows={1}
          aria-label="Message"
        />
        <div className="novalink-composer-actions">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={onPickFiles}
            aria-hidden="true"
            tabIndex={-1}
          />
          <button
            type="button"
            className="ghost"
            onClick={() => fileInputRef.current?.click()}
            disabled={!conversationId || uploading || attachmentCount >= MAX_ATTACHMENTS}
            aria-label="Attach file"
            title="Attach file"
          >
            📎
          </button>
          <button
            type="button"
            className="ghost"
            onClick={shareCode}
            disabled={!conversationId || sending || uploading}
            title="Share selected code from the editor"
            aria-label="Share code"
          >
            {'</>'}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => send()}
            disabled={!canSend}
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
      {body.length > MAX_BODY_CHARS ? (
        <p className="novalink-composer-warn">Message trimmed to {MAX_BODY_CHARS} characters.</p>
      ) : null}
    </div>
  );
}
