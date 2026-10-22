/**
 * AI assistant panel: streaming chat over the secure main-process bridge.
 *
 * - Two modes: Ask answers questions about code; Agent plans a change and
 *   returns the whole updated file, which is offered as a diff for review.
 * - Conversations are lightweight: Add starts a new chat, Recent reopens past
 *   ones, Delete discards one — all stored locally in the renderer.
 * - Sign-in is required: the assistant is a member feature, and the main
 *   process enforces the same gate plus the local token budget.
 * - Code blocks in answers can be reviewed against the active file as a
 *   diff before anything is written (see App.jsx review flow).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { client, toUserMessage } from '../services/novaClient';
import { formatTokens, formatExact } from '../utils/tokens';
import { buildChatSystemPrompt } from '../services/aiPrompts';
import { StopIcon, CheckIcon, SparkleIcon, PlusIcon, HistoryIcon, MicIcon, ChevronDownIcon, NovaMarkIcon, ArrowUpIcon, InfinityIcon, TrashIcon } from './Icons';

const LEARN_LEVELS = ['beginner', 'intermediate', 'advanced'];
const MODES = [
  { id: 'agent', label: 'Agent', title: 'Plans the change and rewrites the whole file, then shows a diff to review' },
  { id: 'ask', label: 'Ask', title: 'Explains code and answers questions without rewriting the file' },
];
// A run that ended in these states produced nothing worth applying.
const ABORTED_REASONS = ['cancelled', 'error', 'no-quota', 'no-key'];
const INLINE_STATES = {
  off: { label: 'Inline AI off', title: 'Turn on AI ghost-text suggestions in Settings (and sign in)' },
  idle: { label: 'Inline AI', title: 'AI suggests code while you type — press Tab to accept' },
  working: { label: 'Inline AI…', title: 'Fetching an inline suggestion' },
  ready: { label: 'Press Tab', title: 'An AI suggestion is showing — press Tab to insert it' },
  error: { label: 'Inline AI idle', title: 'The last inline request failed; typing is unaffected' },
};

// Local chat history: recent conversations live in the renderer only, keyed by
// a small id, so Add / Recent / Delete work without any server round-trip.
const SESSIONS_KEY = 'novacode-ai-sessions';
const MAX_SESSIONS = 24;

function loadSessions() {
  try {
    const list = JSON.parse(localStorage.getItem(SESSIONS_KEY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function persistSessions(list) {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(list.slice(0, MAX_SESSIONS)));
  } catch {
    /* storage unavailable */
  }
}

function makeSessionId() {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function sessionTitle(messages) {
  const first = messages.find((message) => message.role === 'user');
  const text = String(first?.content || '').trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, 48) : 'New chat';
}

function timeAgo(ts) {
  if (!ts) return '';
  const min = Math.floor(Math.max(0, Date.now() - ts) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** Extract the first fenced code block from an assistant message. */
export function extractFirstCodeBlock(text) {
  const match = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/.exec(text || '');
  if (!match) return null;
  return { language: match[1] || '', code: match[2] };
}

/** How many assistant answers a thread holds — used to offer each diff once. */
function countAnswers(messages) {
  return messages.reduce((count, message) => (message.role === 'assistant' ? count + 1 : count), 0);
}

/** Split markdown-ish text into prose and fenced code segments for rendering. */
function segmentContent(text) {
  const segments = [];
  const re = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let match = re.exec(text);
  while (match) {
    if (match.index > last) segments.push({ type: 'text', value: text.slice(last, match.index) });
    segments.push({ type: 'code', lang: match[1] || '', value: match[2].replace(/\n$/, '') });
    last = re.lastIndex;
    match = re.exec(text);
  }
  if (last < text.length) segments.push({ type: 'text', value: text.slice(last) });
  return segments;
}

function MessageBody({ content }) {
  const segments = segmentContent(content);
  return (
    <div className="ai-message-body">
      {segments.map((segment, index) =>
        segment.type === 'code' ? (
          <div className="ai-code-block" key={index}>
            <div className="ai-code-head">
              <span className="ai-code-lang">{segment.lang || 'code'}</span>
              <button
                type="button"
                className="ai-code-copy"
                onClick={() => navigator.clipboard?.writeText(segment.value)}
              >
                Copy
              </button>
            </div>
            <pre className="ai-code">{segment.value}</pre>
          </div>
        ) : (
          segment.value.trim() && <p className="ai-text" key={index}>{segment.value}</p>
        )
      )}
    </div>
  );
}

export default function AIPanel({
  aiSettings,
  activeFile,
  workspaceName,
  account,
  mode = 'agent',
  onModeChange,
  inlineAIState = 'off',
  onToggleInlineAI,
  onAccountChange,
  onRequireSignIn,
  onProviderChange,
  onStreamingChange,
  onProposeEdit,
  onOpenSettings,
}) {
  const provider = aiSettings.provider || 'openai';
  const [providers, setProviders] = useState([]);
  const [keyStatus, setKeyStatus] = useState({ hasKey: false, source: null, loaded: false });
  const [keyBusy, setKeyBusy] = useState(false);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [attachContext, setAttachContext] = useState(true);
  const [level, setLevel] = useState('beginner');
  const [error, setError] = useState('');
  const [streaming, setStreaming] = useState(false);
  const runIdRef = useRef(null);
  const threadRef = useRef(null);
  const inputRef = useRef(null);
  // Agent mode offers a diff automatically, once per assistant answer.
  const finishReasonRef = useRef(null);
  const proposedAnswersRef = useRef(0);
  // Local conversation history (Add / Recent / Delete).
  const [sessions, setSessions] = useState(loadSessions);
  const [currentId, setCurrentId] = useState(makeSessionId);
  const [recentOpen, setRecentOpen] = useState(false);
  const recentRef = useRef(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const setMode = (next) => {
    if (next === mode) return;
    onModeChange?.(next);
    setError('');
  };

  const activeProvider = providers.find((entry) => entry.id === provider)
    || { id: provider, label: provider, requiresKey: true };

  useEffect(() => {
    client.listAiProviders().then((list) => setProviders(list || [])).catch(() => {});
  }, []);

  useEffect(() => {
    client
      .apiKeyStatus(provider)
      .then((status) => setKeyStatus({ ...status, loaded: true }))
      .catch(() => setKeyStatus({ hasKey: false, source: null, loaded: true }));
  }, [provider]);

  useEffect(() => {
    const unsubscribe = client.onAiEvent((event) => {
      if (event.type === 'account') {
        try {
          onAccountChange?.(JSON.parse(event.data));
        } catch {
          /* ignore malformed payload */
        }
        return;
      }
      if (event.runId !== runIdRef.current) return;
      if (event.type === 'delta') {
        setMessages((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last?.role === 'assistant') {
            next[next.length - 1] = { ...last, content: last.content + event.data };
          }
          return next;
        });
      } else if (event.type === 'error') {
        setError(event.data);
        setStreaming(false);
      } else if (event.type === 'done') {
        try {
          finishReasonRef.current = JSON.parse(event.data || '{}').reason || null;
        } catch {
          finishReasonRef.current = null;
        }
        runIdRef.current = null;
        setStreaming(false);
        onStreamingChange(null);
      }
    });
    return unsubscribe;
  }, [onStreamingChange, onAccountChange]);

  // Persist the live thread into the recent list as it grows; empty threads
  // are skipped so an abandoned chat never clutters the history.
  useEffect(() => {
    if (!messages.length) return;
    const entry = { id: currentId, title: sessionTitle(messages), messages, updatedAt: Date.now() };
    const next = [entry, ...sessionsRef.current.filter((s) => s.id !== currentId)]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS);
    sessionsRef.current = next;
    setSessions(next);
    persistSessions(next);
  }, [messages, currentId]);

  // Close the recent-chats dropdown on an outside click or Escape.
  useEffect(() => {
    if (!recentOpen) return undefined;
    function onPointerDown(event) {
      if (recentRef.current && !recentRef.current.contains(event.target)) setRecentOpen(false);
    }
    function onKey(event) {
      if (event.key === 'Escape') setRecentOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [recentOpen]);

  const recentChats = useMemo(() => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt), [sessions]);

  function openSession(id) {
    const found = sessions.find((s) => s.id === id);
    if (!found) return;
    if (runIdRef.current) cancel();
    setCurrentId(id);
    setMessages(Array.isArray(found.messages) ? found.messages : []);
    setDraft('');
    setError('');
    proposedAnswersRef.current = countAnswers(found.messages || []);
    finishReasonRef.current = null;
    setRecentOpen(false);
  }

  function deleteSession(id) {
    const next = sessionsRef.current.filter((s) => s.id !== id);
    sessionsRef.current = next;
    setSessions(next);
    persistSessions(next);
    if (id === currentId) {
      setCurrentId(makeSessionId());
      setMessages([]);
      setError('');
      proposedAnswersRef.current = 0;
    }
  }

  function clearAllSessions() {
    sessionsRef.current = [];
    setSessions([]);
    persistSessions([]);
    setRecentOpen(false);
  }

  async function clearKey() {
    setKeyBusy(true);
    try {
      await client.clearApiKey(provider);
      setKeyStatus({ hasKey: false, source: null, loaded: true });
    } catch (clearError) {
      setError(toUserMessage(clearError));
    } finally {
      setKeyBusy(false);
    }
  }

  async function send(event) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || runIdRef.current) return;
    if (!account) {
      setError('Sign in to use the assistant.');
      onRequireSignIn?.();
      return;
    }
    setError('');
    setDraft('');

    // An agent edit is useless without the file, so context is mandatory there.
    const useContext = mode === 'agent' || attachContext;
    const userMessage = useContext && activeFile
      ? `${text}\n\n--- Attached file: ${activeFile.name} ---\n${activeFile.text.slice(0, 12000)}`
      : text;
    const nextMessages = [...messages, { role: 'user', content: text, raw: userMessage }];
    setMessages([...nextMessages, { role: 'assistant', content: '' }]);
    threadRef.current?.scrollTo?.({ top: threadRef.current.scrollHeight });
    finishReasonRef.current = null;

    try {
      const payloadMessages = [
        {
          role: 'system',
          content: buildChatSystemPrompt({
            mode,
            level,
            activeFile: useContext ? activeFile : null,
            workspaceName,
          }),
        },
        ...nextMessages.map((message) => ({ role: message.role, content: message.raw || message.content })),
      ];
      const { runId } = await client.startChat({
        provider,
        messages: payloadMessages,
        temperature: aiSettings.temperature,
      });
      runIdRef.current = runId;
      setStreaming(true);
      onStreamingChange(runId);
    } catch (chatError) {
      runIdRef.current = null;
      setStreaming(false);
      onStreamingChange(null);
      setError(toUserMessage(chatError));
    }
  }

  function cancel() {
    if (runIdRef.current) client.cancelChat(runIdRef.current);
  }

  function newChat() {
    if (runIdRef.current) cancel();
    setCurrentId(makeSessionId());
    setMessages([]);
    setDraft('');
    setError('');
    setRecentOpen(false);
    proposedAnswersRef.current = 0;
    finishReasonRef.current = null;
  }

  function proposeEdit(block, answerCount) {
    if (!block || !activeFile) return;
    proposedAnswersRef.current = answerCount;
    onProposeEdit?.({
      path: activeFile.path,
      original: activeFile.text,
      modified: block.code,
    });
  }

  function proposeFromLastAnswer() {
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistant) return;
    proposeEdit(extractFirstCodeBlock(lastAssistant.content), countAnswers(messages));
  }

  // Agent mode rewrites the file, so the moment an answer streams the diff is
  // offered without the user hunting for a button — Ask mode never auto-edits.
  useEffect(() => {
    if (streaming || mode !== 'agent' || !activeFile || error) return;
    if (ABORTED_REASONS.includes(finishReasonRef.current)) return;
    const answers = countAnswers(messages);
    if (!answers || proposedAnswersRef.current === answers) return;
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    const block = lastAssistant ? extractFirstCodeBlock(lastAssistant.content) : null;
    if (!block) return;
    proposedAnswersRef.current = answers;
    onProposeEdit?.({ path: activeFile.path, original: activeFile.text, modified: block.code });
  }, [streaming, mode, error, messages, activeFile, onProposeEdit]);

  const inlineState = INLINE_STATES[inlineAIState] || INLINE_STATES.idle;

  const lastAssistantWithCode = activeFile
    ? [...messages].reverse().find((m) => m.role === 'assistant' && extractFirstCodeBlock(m.content))
    : null;
  const canPropose = Boolean(lastAssistantWithCode) && !runIdRef.current;
  const canChat = Boolean(account);
  const providerOptions = providers.length ? providers : [{ id: provider, label: activeProvider.label }];
  const keyLabel = !activeProvider.requiresKey
    ? 'local'
    : keyStatus.hasKey
      ? (keyStatus.source === 'env' ? 'env key' : 'key saved')
      : 'no key';
  const quickPrompts = mode === 'agent'
    ? ['Refactor this into small, clear functions', 'Add error handling to this file', 'Add input validation to this function']
    : ['Explain what this file does', 'Why is this test failing?', 'What does this function assume?'];

  return (
    <aside className="ai-panel" aria-label="AI assistant">
      {/* top tab strip */}
      <div className="ai-tabs">
        <div className="ai-tab-group" role="tablist">
          <button
            type="button"
            className="ai-tab active"
            role="tab"
            aria-selected="true"
            onClick={() => inputRef.current?.focus?.()}
          >
            Continue
          </button>
          <button type="button" className="ai-tab" role="tab" aria-selected="false" onClick={newChat}>
            New Chat
          </button>
        </div>
        <div className="ai-tab-actions">
          <button type="button" className="icon-button" title="New chat" aria-label="New chat" onClick={newChat}>
            <PlusIcon size={16} />
          </button>
          <div className="ai-recent-wrap" ref={recentRef}>
            <button
              type="button"
              className={recentOpen ? 'icon-button is-active' : 'icon-button'}
              title="Recent chats"
              aria-label="Recent chats"
              aria-haspopup="menu"
              aria-expanded={recentOpen}
              onClick={() => setRecentOpen((value) => !value)}
            >
              <HistoryIcon size={16} />
            </button>
            {recentOpen && (
              <div className="ai-recent-menu" role="menu" aria-label="Recent chats">
                <div className="ai-recent-head">
                  <span>Recent chats</span>
                  {recentChats.length > 0 && (
                    <button type="button" className="ai-recent-clear" onClick={clearAllSessions}>Clear all</button>
                  )}
                </div>
                {recentChats.length === 0 ? (
                  <p className="ai-recent-empty">No saved chats yet.</p>
                ) : recentChats.map((entry) => (
                  <div className="ai-recent-item" key={entry.id}>
                    <button
                      type="button"
                      className={entry.id === currentId ? 'ai-recent-open active' : 'ai-recent-open'}
                      title={entry.title}
                      onClick={() => openSession(entry.id)}
                    >
                      <span className="ai-recent-title">{entry.title}</span>
                      <span className="ai-recent-time muted tiny">{timeAgo(entry.updatedAt)}</span>
                    </button>
                    <button
                      type="button"
                      className="icon-button ai-recent-delete"
                      title="Delete chat"
                      aria-label="Delete chat"
                      onClick={() => deleteSession(entry.id)}
                    >
                      <TrashIcon size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="icon-button"
            title={messages.length ? 'Delete this chat' : 'Nothing to delete'}
            aria-label="Delete chat"
            disabled={!messages.length}
            onClick={() => deleteSession(currentId)}
          >
            <TrashIcon size={16} />
          </button>
        </div>
      </div>

      {/* the assistant is a signed-in feature — say so once, up front */}
      {!account && (
        <div className="ai-gate" role="status">
          <SparkleIcon size={15} />
          <div className="ai-gate-text">
            <strong>Sign in to unlock the assistant</strong>
            <span>Agent edits, Ask answers and inline predictions need an account. 1,000M tokens included.</span>
          </div>
          <button type="button" className="primary small" onClick={() => onRequireSignIn?.()}>Sign in</button>
        </div>
      )}

      {error && (
        <div className="ai-error" role="alert">
          <span>{error}</span>
          <button type="button" className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>
            ×
          </button>
        </div>
      )}

      {/* thread / hero */}
      <div className="ai-thread" ref={threadRef}>
        {messages.length === 0 ? (
          <div className="ai-hero">
            <span className="ai-hero-mark"><NovaMarkIcon size={38} /></span>
            <h2 className="ai-hero-title">
              <span className="ai-hero-l1">Think Deeper</span>
              <span className="ai-hero-l2">Build Better</span>
            </h2>
            <p className="ai-hero-sub">Code smarter, together.<br />Collaborate from idea to build.</p>
            {!account && (
              <button type="button" className="ai-hero-cta" onClick={() => onRequireSignIn?.()}>
                <SparkleIcon size={14} /> Sign in for 1,000M free tokens
              </button>
            )}
            <div className="ai-hero-prompts">
              <span className="ai-hero-mode">{mode === 'agent' ? 'Agent mode · writes the file, you review the diff' : 'Ask mode · explains without touching the file'}</span>
              {quickPrompts.map((prompt) => (
                <button
                  type="button"
                  key={prompt}
                  className="ai-prompt-chip"
                  onClick={() => { setDraft(prompt); inputRef.current?.focus?.(); }}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message, index) => {
            const isLast = index === messages.length - 1;
            const streamingThis = streaming && isLast && message.role === 'assistant';
            return (
              <div key={index} className={`ai-message ${message.role}${streamingThis ? ' streaming' : ''}`}>
                <div className="ai-message-role">{message.role === 'user' ? 'You' : 'NovaCode'}</div>
                {message.content
                  ? <MessageBody content={message.content} />
                  : <div className="ai-message-body"><span className="ai-typing" aria-hidden="true"><i /><i /><i /></span></div>}
              </div>
            );
          })
        )}
      </div>

      {canPropose && (
        <button type="button" className="ai-apply-button" onClick={proposeFromLastAnswer}>
          <CheckIcon size={14} /> Review latest answer as an edit for {activeFile ? activeFile.name : 'file'}
        </button>
      )}

      {/* composer */}
      <form className="ai-composer" onSubmit={send}>
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          placeholder={canChat ? 'Plan and build, @ for context, / for commands' : 'Sign in to start chatting'}
          rows={2}
          aria-label="Message the assistant"
        />
        <div className="ai-composer-bar">
          <div className="ai-composer-primary">
            <div className="ai-mode-toggle" role="group" aria-label="Assistant mode">
              <InfinityIcon size={14} className="ai-mode-icon" />
              {MODES.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  className={`ai-mode-button${mode === entry.id ? ' active' : ''}`}
                  title={entry.title}
                  aria-pressed={mode === entry.id}
                  onClick={() => setMode(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            <label className="ai-dropdown ai-model-dropdown" title="Model provider">
              <select value={provider} onChange={(event) => onProviderChange?.(event.target.value)} aria-label="Model provider">
                {providerOptions.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.label}</option>
                ))}
              </select>
              <ChevronDownIcon size={13} />
            </label>
          </div>
          <div className="ai-composer-actions">
            <button type="button" className="icon-button" title="Enhance prompt" aria-label="Enhance prompt" onClick={() => inputRef.current?.focus?.()}>
              <SparkleIcon size={15} />
            </button>
            <button type="button" className="icon-button" title="Voice input is not available offline" aria-label="Voice input" disabled>
              <MicIcon size={15} />
            </button>
            {runIdRef.current ? (
              <button type="button" className="ai-send stop" title="Stop generating" aria-label="Stop" onClick={cancel}>
                <StopIcon size={16} />
              </button>
            ) : (
              <button type="submit" className="ai-send" title="Send" aria-label="Send" disabled={!draft.trim()}>
                <ArrowUpIcon size={16} />
              </button>
            )}
          </div>
        </div>
        <div className="ai-composer-extra">
          <button
            type="button"
            className={`ai-pill ${attachContext ? 'on' : ''}`}
            title="Attach the active file as context"
            onClick={() => setAttachContext((value) => !value)}
          >
            @ {activeFile ? activeFile.name : 'context'}
          </button>
          <button
            type="button"
            className={`ai-pill ai-inline-pill ${inlineAIState === 'working' ? 'busy' : ''} ${inlineAIState === 'ready' ? 'on' : ''}`}
            title={inlineState.title}
            onClick={() => onToggleInlineAI?.()}
          >
            <SparkleIcon size={13} /> {inlineState.label}
          </button>
          <label className="ai-dropdown ai-level-dropdown" title="Explanation level">
            <select value={level} onChange={(event) => setLevel(event.target.value)} aria-label="Explanation level">
              {LEARN_LEVELS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
            <ChevronDownIcon size={13} />
          </label>
        </div>
      </form>

      {/* status strip */}
      <div className="ai-statusbar">
        <span className="ai-status-item"><NovaMarkIcon size={12} /> {activeProvider.label}</span>
        <span className={`ai-status-item ai-key-pill ${!activeProvider.requiresKey || keyStatus.hasKey ? 'ok' : 'warn'}`}>
          {keyLabel}
        </span>
        <button type="button" className="ai-status-link" onClick={onOpenSettings}>settings</button>
        {activeProvider.requiresKey && keyStatus.hasKey && (
          <button type="button" className="ai-status-link danger" onClick={clearKey} disabled={keyBusy}>remove key</button>
        )}
        <span className="ai-status-spacer" />
        {account ? (
          <span className="ai-quota-pill" title={`${formatExact(account.tokensRemaining)} tokens remaining`}>
            {formatTokens(account.tokensRemaining)} left
          </span>
        ) : (
          <button type="button" className="ai-signin-pill" onClick={() => onRequireSignIn?.()}>Sign in</button>
        )}
      </div>
    </aside>
  );
}
