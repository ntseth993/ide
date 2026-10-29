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
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { client, toUserMessage } from '../services/novaClient';
import { formatTokens, formatExact } from '../utils/tokens';
import { buildChatSystemPrompt } from '../services/aiPrompts';
import { parseToolCalls, isAutoTool, describeToolCall, formatToolResults } from '../services/agentTools';
import { StopIcon, CheckIcon, SparkleIcon, PlusIcon, HistoryIcon, MicIcon, ChevronDownIcon, NovaMarkIcon, ArrowUpIcon, InfinityIcon, TrashIcon } from './Icons';

const LEARN_LEVELS = ['beginner', 'intermediate', 'advanced'];
const MODES = [
  { id: 'agent', label: 'Agent', title: 'Plans a change, can run commands and read/write files, then shows a diff to review' },
  { id: 'ask', label: 'Ask', title: 'Explains code and answers questions without touching the project' },
];
// Safety cap on how many tool round-trips a single Agent turn may chain.
const MAX_AGENT_STEPS = 8;
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

// Fenced languages that carry Agent tool protocol, not real code — never
// offered as an edit and never shown as a code block.
const TOOL_FENCES = ['novacode-tool', 'novacode-tool-result'];
const isToolFence = (lang) => TOOL_FENCES.includes((lang || '').trim());

/** Extract the first fenced code block, skipping Agent tool blocks. */
export function extractFirstCodeBlock(text) {
  const re = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
  let match = re.exec(text || '');
  while (match) {
    if (!isToolFence(match[1])) return { language: match[1] || '', code: match[2] };
    match = re.exec(text || '');
  }
  return null;
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
    // Tool blocks render as action cards elsewhere, so drop them here.
    if (!isToolFence(match[1])) {
      segments.push({ type: 'code', lang: match[1] || '', value: match[2].replace(/\n$/, '') });
    }
    last = re.lastIndex;
    match = re.exec(text);
  }
  if (last < text.length) segments.push({ type: 'text', value: text.slice(last) });
  return segments;
}

/** Render inline markdown: bold, italic, inline code, and links. */
function renderInline(text, keyBase) {
  const nodes = [];
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_|`(.+?)`|\[(.+?)\]\((.+?)\))/g;
  let last = 0;
  let n = 0;
  let match = re.exec(text);
  while (match) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const key = `${keyBase}-i${n++}`;
    if (match[2] !== undefined) nodes.push(<strong key={key}>{match[2]}</strong>);
    else if (match[3] !== undefined) nodes.push(<em key={key}>{match[3]}</em>);
    else if (match[4] !== undefined) nodes.push(<em key={key}>{match[4]}</em>);
    else if (match[5] !== undefined) nodes.push(<code key={key} className="ai-inline-code">{match[5]}</code>);
    else if (match[6] !== undefined) {
      nodes.push(<a key={key} href={match[7]} className="ai-link" target="_blank" rel="noreferrer noopener">{match[6]}</a>);
    }
    last = re.lastIndex;
    match = re.exec(text);
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Split a prose block into lightweight markdown blocks: headings, lists, quotes, paragraphs. */
function renderProseBlocks(value, keyBase) {
  const out = [];
  let para = [];
  let list = null;
  let k = 0;
  const flushPara = () => {
    if (!para.length) return;
    const kb = `${keyBase}-t${k++}`;
    out.push(<p className="ai-text" key={kb}>{renderInline(para.join('\n'), kb)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const kb = `${keyBase}-l${k++}`;
    const items = list.items.map((item, idx) => (
      <li key={`${kb}-${idx}`}>{renderInline(item, `${kb}-${idx}`)}</li>
    ));
    out.push(list.ordered
      ? <ol className="ai-list" key={kb}>{items}</ol>
      : <ul className="ai-list" key={kb}>{items}</ul>);
    list = null;
  };
  for (const rawLine of value.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const orderedItem = /^\d+[.)]\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (heading) {
      flushPara(); flushList();
      const kb = `${keyBase}-h${k++}`;
      const level = Math.min(6, heading[1].length);
      out.push(<div className={`ai-heading ai-h${level}`} key={kb}>{renderInline(heading[2], kb)}</div>);
    } else if (bullet) {
      flushPara();
      if (list && list.ordered) flushList();
      list = list || { ordered: false, items: [] };
      list.items.push(bullet[1]);
    } else if (orderedItem) {
      flushPara();
      if (list && !list.ordered) flushList();
      list = list || { ordered: true, items: [] };
      list.items.push(orderedItem[1]);
    } else if (quote) {
      flushPara(); flushList();
      const kb = `${keyBase}-q${k++}`;
      out.push(<blockquote className="ai-quote" key={kb}>{renderInline(quote[1], kb)}</blockquote>);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  return out;
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
          segment.value.trim() && <Fragment key={index}>{renderProseBlocks(segment.value, `s${index}`)}</Fragment>
        )
      )}
    </div>
  );
}

const ACTION_STATUS = {
  awaiting: { label: 'Waiting for approval', tone: 'awaiting' },
  running: { label: 'Running', tone: 'running' },
  done: { label: 'Done', tone: 'done' },
  error: { label: 'Failed', tone: 'error' },
  skipped: { label: 'Skipped', tone: 'skipped' },
};

function clipOutput(text) {
  const value = String(text || '');
  return value.length > 2000 ? `${value.slice(0, 2000)}\n… truncated for display` : value;
}

// One card per tool call: shows what the Agent wants to do, its live status,
// captured output, and (for run_command) the Run / Skip approval buttons.
function ActionCard({ action, onApprove, onSkip }) {
  const status = ACTION_STATUS[action.status] || ACTION_STATUS.running;
  const showOutput = action.output && (action.tool === 'run_command' || action.tool === 'read_file');
  return (
    <div className={`ai-action ai-action-${action.tool} is-${status.tone}`}>
      <div className="ai-action-head">
        <span className="ai-action-title">{action.title}</span>
        {action.detail && <code className="ai-action-detail">{action.detail}</code>}
        <span className={`ai-action-status tone-${status.tone}`}>{status.label}</span>
      </div>
      {action.tool === 'run_command' && action.status === 'awaiting' && (
        <div className="ai-action-approve">
          <span className="ai-action-hint">Allow NovaCode to run this command in your workspace?</span>
          <div className="ai-action-buttons">
            <button type="button" className="ai-action-run" onClick={() => onApprove(action.id)}>Run</button>
            <button type="button" className="ai-action-skip" onClick={() => onSkip(action.id)}>Skip</button>
          </div>
        </div>
      )}
      {action.error && <pre className="ai-action-error">{action.error}</pre>}
      {showOutput && <pre className="ai-action-output">{clipOutput(action.output)}</pre>}
    </div>
  );
}

export default function AIPanel({
  aiSettings,
  activeFile,
  workspaceName,
  workspaceRoot,
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
  // Transient "the AI is busy, waiting…" note shown while a rate-limited run
  // pauses before retrying, so an empty bubble never looks stuck.
  const [streamStatus, setStreamStatus] = useState('');
  const runIdRef = useRef(null);
  // True between calling startChat() and its reply landing. Events for the new
  // run can arrive first (see the tolerant guard in the AI event handler).
  const startingRef = useRef(false);
  const threadRef = useRef(null);
  // Auto-scroll follows the streaming answer, but yields when the user scrolls
  // up to read something, so it never fights manual navigation.
  const stickToBottomRef = useRef(true);
  const inputRef = useRef(null);
  // Agent mode offers a diff automatically, once per assistant answer.
  const finishReasonRef = useRef(null);
  const proposedAnswersRef = useRef(0);
  // Agent loop plumbing: raw text of the streaming turn, a resolver so the
  // event handler can complete a promise-based chatOnce, and approval gates.
  const accumRef = useRef('');
  const resolverRef = useRef(null);
  const busyRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const approvalResolversRef = useRef({});
  const [agentRunning, setAgentRunning] = useState(false);
  // Local conversation history (Add / Recent / Delete).
  const [sessions, setSessions] = useState(loadSessions);
  const [currentId, setCurrentId] = useState(makeSessionId);
  const [recentOpen, setRecentOpen] = useState(false);
  const recentRef = useRef(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  // Fresh messages snapshot so back-to-back queued turns chain correctly
  // (each reads the latest history instead of a stale closure).
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // Messages typed while a run is active are queued and answered in order, so
  // the free tier's rate-limit pauses never silently drop a message.
  const queueRef = useRef([]);
  const processingRef = useRef(false);
  const [pendingCount, setPendingCount] = useState(0);

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
      if (event.runId !== runIdRef.current) {
        // Events can beat the startChat() reply — e.g. an instant "no API key"
        // error. While a run is starting, adopt its id so the outcome reaches
        // the UI instead of leaving the assistant bubble spinning forever.
        if (runIdRef.current == null && startingRef.current) runIdRef.current = event.runId;
        else return;
      }
      if (event.type === 'delta') {
        accumRef.current += event.data;
        setStreamStatus('');
        setMessages((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last?.role === 'assistant') {
            next[next.length - 1] = { ...last, content: last.content + event.data };
          }
          return next;
        });
      } else if (event.type === 'status') {
        setStreamStatus(event.data);
      } else if (event.type === 'error') {
        startingRef.current = false;
        setStreamStatus('');
        // Drop the placeholder bubble so a failed turn doesn't spin forever.
        setMessages((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last?.role === 'assistant' && !last.content && !last.actions?.length) next.pop();
          return next;
        });
        setError(event.data);
        setStreaming(false);
        runIdRef.current = null;
        onStreamingChange(null);
        const resolve = resolverRef.current;
        resolverRef.current = null;
        if (resolve) resolve({ text: accumRef.current, reason: 'error', error: event.data });
      } else if (event.type === 'done') {
        startingRef.current = false;
        setStreamStatus('');
        try {
          finishReasonRef.current = JSON.parse(event.data || '{}').reason || null;
        } catch {
          finishReasonRef.current = null;
        }
        runIdRef.current = null;
        setStreaming(false);
        onStreamingChange(null);
        const resolve = resolverRef.current;
        resolverRef.current = null;
        if (resolve) resolve({ text: accumRef.current, reason: finishReasonRef.current });
      }
    });
    return unsubscribe;
  }, [onStreamingChange, onAccountChange]);

  // Follow the streaming answer: keep the thread pinned to the bottom as new
  // content (or a waiting note) arrives, unless the user scrolled up to read.
  useEffect(() => {
    const el = threadRef.current;
    if (el && stickToBottomRef.current) el.scrollTo?.({ top: el.scrollHeight });
  }, [messages, streamStatus]);

  // Persist the live thread into the recent list as it grows; empty threads
  // are skipped so an abandoned chat never clutters the history.
  //
  // DEBOUNCED on purpose: while a reply streams, `messages` changes on every
  // token, and each change would otherwise copy every session and run
  // JSON.stringify over the full history — hundreds of times per reply, which
  // stalls the UI and makes answers feel slow. Coalesce bursts into a single
  // save shortly after the stream (or typing) settles.
  useEffect(() => {
    if (!messages.length) return undefined;
    const timer = setTimeout(() => {
      const entry = { id: currentId, title: sessionTitle(messages), messages, updatedAt: Date.now() };
      const next = [entry, ...sessionsRef.current.filter((s) => s.id !== currentId)]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_SESSIONS);
      sessionsRef.current = next;
      setSessions(next);
      persistSessions(next);
    }, 450);
    return () => clearTimeout(timer);
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
    stopRun();
    setCurrentId(id);
    setMessages(Array.isArray(found.messages) ? found.messages : []);
    setDraft('');
    setError('');
    proposedAnswersRef.current = countAnswers(found.messages || []);
    finishReasonRef.current = null;
    setRecentOpen(false);
  }

  function deleteSession(id) {
    stopRun();
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

  // Build the exact turns sent to the model: one system prompt for the mode,
  // then the running history (assistant turns carry the raw tool JSON so the
  // model sees what it emitted; tool results arrive as user turns).
  function buildPayload(history, chatMode) {
    const useContext = chatMode === 'agent' || attachContext;
    return [
      {
        role: 'system',
        content: buildChatSystemPrompt({
          mode: chatMode,
          level,
          activeFile: useContext ? activeFile : null,
          workspaceName,
        }),
      },
      ...history.map((message) => ({ role: message.role, content: message.raw || message.content })),
    ];
  }

  // One streaming model turn, resolved when the run finishes so the agent
  // loop can await it. The visible assistant bubble fills in from deltas.
  function chatOnce(history, chatMode) {
    return new Promise((resolve) => {
      accumRef.current = '';
      finishReasonRef.current = null;
      resolverRef.current = resolve;
      startingRef.current = true;
      setMessages((current) => [...current, { role: 'assistant', content: '', actions: [] }]);
      stickToBottomRef.current = true;
      threadRef.current?.scrollTo?.({ top: threadRef.current.scrollHeight });
      client
        .startChat({ provider, messages: buildPayload(history, chatMode), temperature: aiSettings.temperature })
        .then(({ runId }) => {
          // An immediate error/done event may already have completed this run.
          if (!startingRef.current) return;
          runIdRef.current = runId;
          setStreaming(true);
          onStreamingChange(runId);
          startingRef.current = false;
        })
        .catch((chatError) => {
          startingRef.current = false;
          runIdRef.current = null;
          setStreaming(false);
          onStreamingChange(null);
          resolverRef.current = null;
          resolve({ text: '', reason: 'error', error: toUserMessage(chatError) });
        });
    });
  }

  // Attach an action card to the current (last) assistant turn.
  function addStepAction(action) {
    setMessages((current) => {
      const next = [...current];
      for (let i = next.length - 1; i >= 0; i -= 1) {
        if (next[i].role === 'assistant') {
          next[i] = { ...next[i], actions: [...(next[i].actions || []), action] };
          break;
        }
      }
      return next;
    });
  }

  function updateStepAction(id, patch) {
    setMessages((current) => current.map((message) => (
      message.role === 'assistant' && message.actions?.some((a) => a.id === id)
        ? { ...message, actions: message.actions.map((a) => (a.id === id ? { ...a, ...patch } : a)) }
        : message
    )));
  }

  // Route a validated tool call to the right bridge, returning a structured
  // result for the model. Never throws — failures come back as { ok:false }.
  async function executeTool(call) {
    const args = call.args || {};
    if (call.tool === 'run_command') {
      if (!workspaceRoot) return { tool: call.tool, args, ok: false, error: 'Open a folder first so commands run inside your workspace.' };
      const r = await client.runTerminalCapture({ root: workspaceRoot, cwd: args.cwd, command: args.command });
      return { tool: call.tool, args, ok: !r.error && r.code === 0, output: r.output || '', code: r.code ?? null, error: r.error || '' };
    }
    if (call.tool === 'read_file') {
      if (!workspaceRoot) return { tool: call.tool, args, ok: false, error: 'Open a folder first.' };
      try {
        const content = await client.readFile(workspaceRoot, args.path);
        return { tool: call.tool, args, ok: true, output: typeof content === 'string' ? content : '' };
      } catch (readError) {
        return { tool: call.tool, args, ok: false, error: toUserMessage(readError) };
      }
    }
    if (call.tool === 'write_file') {
      const original = activeFile && activeFile.path === args.path ? activeFile.text : '';
      onProposeEdit?.({ path: args.path, original, modified: args.content || '' });
      return { tool: call.tool, args, ok: true, output: '', note: `Opened a diff for ${args.path} for the user to review and accept.` };
    }
    return { tool: call.tool, args, ok: false, error: `Unknown tool: ${call.tool}` };
  }

  // Auto tools run at once; run_command parks until the user clicks Run.
  function handleToolCall(call) {
    const { title, detail } = describeToolCall(call);
    const base = { id: call.id, tool: call.tool, args: call.args, title, detail };
    if (isAutoTool(call.tool)) {
      addStepAction({ ...base, status: 'running', output: '', code: null, error: '' });
      return executeTool(call).then((result) => {
        updateStepAction(call.id, {
          status: result.skipped ? 'skipped' : result.ok ? 'done' : 'error',
          output: result.output || '',
          code: result.code ?? null,
          error: result.error || '',
        });
        return result;
      });
    }
    addStepAction({ ...base, status: 'awaiting', output: '', code: null, error: '' });
    return new Promise((resolve) => {
      approvalResolversRef.current[call.id] = { call, resolve };
    });
  }

  // The Agent turn loop: ask, act, feed results back, repeat — bounded so a
  // stuck model can't spin forever.
  async function runAgent(initialHistory) {
    busyRef.current = true;
    setAgentRunning(true);
    let history = initialHistory;
    try {
      for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
        if (cancelRequestedRef.current) break;
        const res = await chatOnce(history, 'agent');
        if (res.error) { setError(res.error); break; }
        if (cancelRequestedRef.current || ABORTED_REASONS.includes(res.reason)) break;
        history = [...history, { role: 'assistant', content: res.text, raw: res.text }];
        const calls = parseToolCalls(res.text);
        if (!calls.length) break; // a plain answer ends the turn
        const results = [];
        for (const call of calls) {
          if (cancelRequestedRef.current) break;
          results.push(await handleToolCall(call));
        }
        if (cancelRequestedRef.current) break;
        const resultsMsg = formatToolResults(results);
        history = [...history, { role: 'user', content: resultsMsg, raw: resultsMsg }];
      }
    } finally {
      busyRef.current = false;
      setAgentRunning(false);
      finishReasonRef.current = null;
    }
  }

  async function send(event) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (!account) {
      setError('Sign in to use the assistant.');
      onRequireSignIn?.();
      return;
    }
    setDraft('');
    // Queue the message and let a single loop answer them one-by-one. Typing
    // while the assistant is busy (or waiting out a rate limit) no longer
    // drops the message.
    queueRef.current.push(text);
    setPendingCount(queueRef.current.length);
    if (processingRef.current) return;
    processingRef.current = true;
    try {
      while (queueRef.current.length) {
        const next = queueRef.current.shift();
        setPendingCount(queueRef.current.length);
        await runOneTurn(next);
        if (cancelRequestedRef.current) break;
      }
    } finally {
      processingRef.current = false;
      queueRef.current = [];
      setPendingCount(0);
    }
  }

  // One user turn -> model answer (Ask) or a full agent loop, built from the
  // freshest history so back-to-back queued messages chain correctly.
  async function runOneTurn(text) {
    setError('');
    cancelRequestedRef.current = false;
    // An agent edit is useless without the file, so context is mandatory there.
    const useContext = mode === 'agent' || attachContext;
    const userRaw = useContext && activeFile
      ? `${text}\n\n--- Attached file: ${activeFile.name} ---\n${activeFile.text.slice(0, 12000)}`
      : text;
    const history = [
      ...messagesRef.current.map(({ role, content, raw }) => ({ role, content, raw })),
      { role: 'user', content: text, raw: userRaw },
    ];
    setMessages((current) => [...current, { role: 'user', content: text, raw: userRaw }]);
    stickToBottomRef.current = true;
    threadRef.current?.scrollTo?.({ top: threadRef.current.scrollHeight });

    if (mode === 'agent') {
      await runAgent(history);
    } else {
      busyRef.current = true;
      await chatOnce(history, 'ask');
      busyRef.current = false;
    }
  }

  // Resolve every parked approval so an awaiting run_command can't hang the
  // loop after the user stops or switches chats.
  function resolveAllPending() {
    const entries = Object.values(approvalResolversRef.current);
    approvalResolversRef.current = {};
    entries.forEach(({ call, resolve }) => {
      updateStepAction(call.id, { status: 'skipped' });
      resolve({ tool: call.tool, args: call.args, ok: false, skipped: true, output: '' });
    });
  }

  function stopRun() {
    cancelRequestedRef.current = true;
    startingRef.current = false;
    // Stop also discards anything still waiting in the queue.
    queueRef.current = [];
    setPendingCount(0);
    if (runIdRef.current) client.cancelChat(runIdRef.current);
    resolveAllPending();
  }

  function cancel() {
    stopRun();
  }

  function approveAction(id) {
    const pending = approvalResolversRef.current[id];
    if (!pending) return undefined;
    delete approvalResolversRef.current[id];
    updateStepAction(id, { status: 'running' });
    return executeTool(pending.call).then((result) => {
      updateStepAction(id, {
        status: result.skipped ? 'skipped' : result.ok ? 'done' : 'error',
        output: result.output || '',
        code: result.code ?? null,
        error: result.error || '',
      });
      pending.resolve(result);
    });
  }

  function skipAction(id) {
    const pending = approvalResolversRef.current[id];
    if (!pending) return;
    delete approvalResolversRef.current[id];
    updateStepAction(id, { status: 'skipped' });
    pending.resolve({ tool: pending.call.tool, args: pending.call.args, ok: false, skipped: true, output: '' });
  }

  function newChat() {
    stopRun();
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
  // While the agent loop is running we hold off, since write_file opens the
  // diff itself and intermediate turns are just plans with tool calls.
  useEffect(() => {
    if (streaming || agentRunning || mode !== 'agent' || !activeFile || error) return;
    if (ABORTED_REASONS.includes(finishReasonRef.current)) return;
    const answers = countAnswers(messages);
    if (!answers || proposedAnswersRef.current === answers) return;
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    const block = lastAssistant ? extractFirstCodeBlock(lastAssistant.content) : null;
    if (!block) return;
    proposedAnswersRef.current = answers;
    onProposeEdit?.({ path: activeFile.path, original: activeFile.text, modified: block.code });
  }, [streaming, agentRunning, mode, error, messages, activeFile, onProposeEdit]);

  const inlineState = INLINE_STATES[inlineAIState] || INLINE_STATES.idle;

  const lastAssistantWithCode = activeFile
    ? [...messages].reverse().find((m) => m.role === 'assistant' && extractFirstCodeBlock(m.content))
    : null;
  const canPropose = Boolean(lastAssistantWithCode) && !runIdRef.current && !agentRunning;
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
      <div
        className="ai-thread"
        ref={threadRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
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
            const isEmpty = !message.content && !message.actions?.length;
            // Only spin the "typing" dots while a run is actually live for THIS
            // bubble; otherwise a leftover empty turn pulses forever.
            const showTyping = isEmpty && isLast && message.role === 'assistant' && (streaming || agentRunning);
            return (
              <div key={index} className={`ai-message ${message.role}${streamingThis ? ' streaming' : ''}`}>
                <div className="ai-message-role">{message.role === 'user' ? 'You' : 'NovaCode'}</div>
                {message.actions?.length > 0 && (
                  <div className="ai-actions">
                    {message.actions.map((action) => (
                      <ActionCard key={action.id} action={action} onApprove={approveAction} onSkip={skipAction} />
                    ))}
                  </div>
                )}
                {message.content
                  ? <MessageBody content={message.content} />
                  : (showTyping
                    ? <div className="ai-message-body">
                      {streamStatus
                        ? <p className="ai-text ai-stream-status">{streamStatus}</p>
                        : <span className="ai-typing" aria-hidden="true"><i /><i /><i /></span>}
                    </div>
                    : null)}
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

      {pendingCount > 0 && (
        <div className="ai-queue-hint" role="status">
          {pendingCount} message{pendingCount > 1 ? 's' : ''} queued — the assistant will answer each one in turn.
        </div>
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
            {runIdRef.current || agentRunning ? (
              <button type="button" className="ai-send stop" title="Stop the agent" aria-label="Stop" onClick={cancel}>
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
