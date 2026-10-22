/** Integrated terminal panel: shell profiles, streaming output, command autocomplete. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { client, toUserMessage } from '../services/novaClient';
import * as bus from '../services/bus';
import { joinPath, normalizePath, parentPath } from '../utils/pathUtils';
import { PlayIcon, StopIcon, TrashIcon, MoreIcon, ChevronDownIcon, PlusIcon, CloseIcon, MaximizeIcon, MinimizeIcon } from './Icons';

/** Terminal "More actions" menu — every enabled entry maps to a command id in
 *  App's shared registry, mirroring the top menu bar's Terminal submenu. */
const TERMINAL_MENU = [
  { label: 'New Terminal', command: 'terminal.new', hint: 'Ctrl+Shift+`' },
  { label: 'Split Terminal', disabled: true, hint: 'coming soon' },
  { label: 'Clear Terminal', command: 'terminal.clear' },
  { type: 'sep' },
  { label: 'Run Active File', command: 'run.file', hint: 'F5' },
  { label: 'Stop', command: 'run.stop', hint: 'Shift+F5' },
];

// Handy starting points surfaced while typing (filtered by prefix).
const COMMON_COMMANDS = [
  'npm run dev', 'npm install', 'npm test', 'npm run build', 'npm run lint',
  'git status', 'git add .', 'git commit', 'git push', 'git pull', 'git diff',
  'node .', 'python .', 'pip install ', 'cargo build', 'dotnet run', 'go run .',
  'ls', 'cd ', 'mkdir ', 'echo ', 'cat ', 'clear', 'exit',
];

const MAX_INPUT_HEIGHT = 168;

// Bottom-panel sections, mirroring VS Code's tabbed panel. Terminal is fully
// wired; Output mirrors the run log; Problems/Debug/Ports render honest states.
const PANEL_TABS = [
  { id: 'problems', label: 'Problems' },
  { id: 'output', label: 'Output' },
  { id: 'debug', label: 'Debug Console' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'ports', label: 'Ports' },
];

// --- working-directory helpers for the interactive prompt -------------------
// The session tracks its own cwd so `cd` persists between commands, mirroring a
// real shell. Everything stays confined to the workspace root (the same guard
// the main process enforces), so a terminal can never escape the open folder.
function isAbsolutePath(p) { return /^[a-zA-Z]:\//.test(p) || p.startsWith('/'); }
function withinRoot(root, p) { return p === root || p.startsWith(`${root}/`); }
function collapsePath(p) {
  const win = /^[a-zA-Z]:\//.test(p);
  const prefix = win ? p.slice(0, 3) : (p.startsWith('/') ? '/' : '');
  const stack = [];
  for (const seg of p.slice(prefix.length).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { stack.pop(); continue; }
    stack.push(seg);
  }
  return prefix + stack.join('/');
}
function resolveCwd(root, from, arg) {
  const a = normalizePath(arg).trim();
  let target;
  if (!a) target = from;
  else if (a === '~') target = root;
  else if (isAbsolutePath(a)) target = collapsePath(a);
  else if (a === '..') { const parent = parentPath(from); target = withinRoot(root, parent) ? parent : root; }
  else target = collapsePath(joinPath(from, a));
  if (!withinRoot(root, target)) return { error: 'cd: access outside the workspace folder is not allowed.' };
  return { path: target };
}

function PanelMenu({ commands, items }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function run(commandId) {
    setOpen(false);
    commandsRef.current.find((entry) => entry.id === commandId)?.run();
  }

  return (
    <div className="menu-group" ref={wrapRef}>
      <button
        type="button"
        className={open ? 'icon-button menu-trigger open' : 'icon-button menu-trigger'}
        title="Terminal actions"
        aria-label="Terminal actions"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreIcon size={16} />
      </button>
      {open && (
        <ul className="menu-dropdown right" role="menu" aria-label="Terminal actions">
          {items.map((item, index) =>
            item.type === 'sep' ? (
              <li key={`sep-${index}`} className="menu-sep" role="separator" />
            ) : (
              <li key={item.label} role="none">
                <button
                  type="button"
                  role="menuitem"
                  className={item.disabled ? 'menu-item disabled' : 'menu-item'}
                  disabled={Boolean(item.disabled)}
                  onClick={() => !item.disabled && run(item.command)}
                >
                  <span className="menu-item-label">{item.label}</span>
                  {item.hint && <span className="menu-item-hint">{item.hint}</span>}
                </button>
              </li>
            )
          )}
        </ul>
      )}
    </div>
  );
}

/** Shell-profile picker (PowerShell / Command Prompt / bash …), like an editor's
 *  terminal profile dropdown. Selecting one changes how commands are spawned. */
function ProfileMenu({ profiles, activeId, onSelect }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!profiles.length) return null;
  const active = profiles.find((p) => p.id === activeId) || profiles[0];

  return (
    <div className="term-profile-wrap menu-group" ref={wrapRef}>
      <button
        type="button"
        className="term-profile"
        title="Select shell"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{active.label}</span>
        <ChevronDownIcon size={13} />
      </button>
      {open && (
        <ul className="term-profile-menu" role="listbox" aria-label="Shell profiles">
          {profiles.map((profile) => (
            <li key={profile.id} role="none">
              <button
                type="button"
                role="option"
                aria-selected={profile.id === active.id}
                className={profile.id === active.id ? 'menu-item selected' : 'menu-item'}
                onClick={() => {
                  onSelect(profile.id);
                  setOpen(false);
                }}
              >
                <span className="menu-item-label">{profile.label}</span>
                {profile.default && <span className="menu-item-hint">default</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function TerminalPanel({ root, height, visible, commands = [], problems = [], onOpenProblem, onClose }) {
  const [lines, setLines] = useState([{ type: 'system', text: 'NovaCode terminal ready.' }]);
  const [activeTab, setActiveTab] = useState('terminal');
  // Panel size: 'normal' (user height), 'max' (fills the editor column),
  // 'min' (collapsed to just the header bar).
  const [sizeState, setSizeState] = useState('normal');
  const [cwd, setCwd] = useState(() => normalizePath(root));
  const [platform, setPlatform] = useState('');
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [runningId, setRunningId] = useState(null);
  const [lastExit, setLastExit] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [activeProfile, setActiveProfile] = useState('');
  const [suggestActive, setSuggestActive] = useState(-1);
  const [focused, setFocused] = useState(false);
  const outputRef = useRef(null);
  const inputRef = useRef(null);
  // Mirrors for bus handlers so menu-driven commands never act on stale state.
  const runningRef = useRef(null);
  runningRef.current = runningId;
  const rootRef = useRef(root);
  rootRef.current = root;
  const profileRef = useRef('');
  profileRef.current = activeProfile;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  // Latest runCommand for the once-registered bus subscription (avoids stale closures).
  const runCommandRef = useRef(null);

  // The prompt reflects the live shell: `PS C:\path>` for PowerShell, `C:\path>`
  // for cmd, `path $` for bash-like profiles — just like an integrated terminal.
  function buildPrompt() {
    if (!root) return '';
    const isWin = platform === 'win32';
    const display = isWin ? cwd.replace(/\//g, '\\') : cwd;
    if (activeProfile === 'cmd') return `${display}> `;
    if (activeProfile === 'powershell') return `PS ${display}> `;
    return `${display} $ `;
  }
  const prompt = buildPrompt();
  const promptRef = useRef(prompt);
  promptRef.current = prompt;

  // Opening a different workspace resets the session directory.
  useEffect(() => {
    setCwd(normalizePath(root));
  }, [root]);

  useEffect(() => {
    client.terminalProfiles().then((result) => {
      setProfiles(result?.profiles || []);
      setPlatform(result?.platform || '');
      if (result?.defaultId) setActiveProfile(result.defaultId);
    }).catch(() => setProfiles([]));
  }, []);

  useEffect(() => {
    const unsubscribe = client.onTerminalEvent((event) => {
      setLines((current) => {
        const next = [...current];
        if (event.type === 'exit') {
          let parsed = null;
          try {
            parsed = JSON.parse(event.data);
          } catch {
            parsed = { code: null };
          }
          setLastExit(parsed);
          next.push({ type: 'system', text: `Exit code: ${parsed?.code ?? 'unknown'}${parsed?.signal ? ` (${parsed.signal})` : ''}` });
        } else {
          const text = event.data.replace(/\r\n/g, '\n');
          const last = next[next.length - 1];
          if (last && last.type === event.type && !last.text.endsWith('\n')) {
            next[next.length - 1] = { ...last, text: last.text + text };
          } else {
            next.push({ type: event.type, text });
          }
        }
        return next;
      });
      if (event.type === 'exit' || event.type === 'error') {
        setRunningId((current) => (current === event.runId ? null : current));
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines]);

  // Menu-driven terminal commands travel over the app event bus.
  useEffect(() => {
    const offs = [
      bus.subscribe('terminal:clear', () => {
        setLines([]);
        setLastExit(null);
      }),
      bus.subscribe('terminal:new', () => {
        // A fresh shell session: clear the buffer, reset the working directory
        // back to the workspace root, and focus the prompt so it feels like a
        // newly opened terminal rather than a no-op.
        setSizeState((state) => (state === 'min' ? 'normal' : state));
        setActiveTab('terminal');
        setLines([{ type: 'system', text: 'NovaCode terminal ready.' }]);
        setLastExit(null);
        setCommand('');
        setCwd(normalizePath(rootRef.current));
        requestAnimationFrame(() => inputRef.current?.focus());
      }),
      bus.subscribe('panel:tab', ({ tab } = {}) => {
        if (tab) setActiveTab(tab);
      }),
      bus.subscribe('terminal:stop', () => {
        if (runningRef.current) client.cancelTerminal(runningRef.current);
      }),
      bus.subscribe('terminal:run', ({ command: cmd } = {}) => {
        if (typeof cmd === 'string' && cmd.trim()) runCommandRef.current?.(cmd.trim());
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  async function runCommand(trimmed) {
    if (!trimmed || !rootRef.current || runningRef.current) return;
    setCommand('');
    setSuggestActive(-1);
    setHistory((current) => [trimmed, ...current.filter((entry) => entry !== trimmed)].slice(0, 50));
    setHistoryIndex(-1);
    // Echo the command the way a shell does: prompt + typed text, then the output.
    setLines((current) => [...current, { type: 'command', text: `${promptRef.current}${trimmed}` }]);
    if (handleLocalCommand(trimmed)) return;
    try {
      const { runId } = await client.startTerminal({ root: rootRef.current, cwd: cwdRef.current || rootRef.current, command: trimmed, profile: profileRef.current || undefined });
      setRunningId(runId);
    } catch (error) {
      setLines((current) => [...current, { type: 'stderr', text: toUserMessage(error) }]);
    }
  }
  runCommandRef.current = runCommand;

  // Built-ins handled in-app so the session feels continuous: `cd` moves the
  // tracked working directory (workspace-confined), `clear`/`cls` wipes output.
  function handleLocalCommand(trimmed) {
    const lower = trimmed.toLowerCase();
    if (lower === 'clear' || lower === 'cls') {
      setLines([]);
      return true;
    }
    if (lower === 'pwd') {
      setLines((current) => [...current, { type: 'stdout', text: platform === 'win32' ? cwd.replace(/\//g, '\\') : cwd }]);
      return true;
    }
    const cdMatch = /^cd(?:\s+(.*))?$/.exec(trimmed);
    if (cdMatch) {
      const raw = (cdMatch[1] || '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      if (!raw) return true; // bare `cd` stays put
      const result = resolveCwd(normalizePath(rootRef.current), cwdRef.current, raw);
      if (result.error) {
        setLines((current) => [...current, { type: 'stderr', text: result.error }]);
      } else {
        setCwd(result.path);
      }
      return true;
    }
    return false;
  }

  function run(event) {
    event?.preventDefault();
    runCommand(command.trim());
  }

  function cancel() {
    if (runningId) client.cancelTerminal(runningId);
  }

  // Live suggestions: recent history first, then common commands, prefix-matched.
  const suggestions = useMemo(() => {
    const value = command;
    if (!value || value.includes('\n')) return [];
    const lower = value.toLowerCase();
    const seen = new Set();
    const out = [];
    for (const entry of history) {
      if (entry !== value && entry.toLowerCase().startsWith(lower) && !seen.has(entry)) {
        seen.add(entry);
        out.push(entry);
      }
    }
    for (const entry of COMMON_COMMANDS) {
      if (entry !== value && entry.toLowerCase().startsWith(lower) && !seen.has(entry)) {
        seen.add(entry);
        out.push(entry);
      }
    }
    return out.slice(0, 7);
  }, [command, history]);

  const suggestionsOpen = focused && suggestions.length > 0;

  function acceptSuggestion(value) {
    setCommand(value);
    setSuggestActive(-1);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(value.length, value.length);
      }
    });
  }

  function handleKeyDown(event) {
    const { key } = event;
    if (suggestionsOpen) {
      if (key === 'ArrowDown') {
        event.preventDefault();
        setSuggestActive((i) => (i + 1) % suggestions.length);
        return;
      }
      if (key === 'ArrowUp') {
        event.preventDefault();
        setSuggestActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
        return;
      }
      if (key === 'Tab') {
        event.preventDefault();
        acceptSuggestion(suggestions[suggestActive >= 0 ? suggestActive : 0]);
        return;
      }
      if (key === 'Enter' && suggestActive >= 0) {
        event.preventDefault();
        acceptSuggestion(suggestions[suggestActive]);
        return;
      }
      if (key === 'Escape') {
        event.preventDefault();
        setSuggestActive(-1);
        setFocused(false);
        return;
      }
    }
    if (key === 'ArrowUp' && history.length && !command.includes('\n')) {
      event.preventDefault();
      const nextIndex = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(nextIndex);
      setCommand(history[nextIndex]);
      setSuggestActive(-1);
    } else if (key === 'ArrowDown' && historyIndex >= 0 && !command.includes('\n')) {
      event.preventDefault();
      const nextIndex = historyIndex - 1;
      setHistoryIndex(nextIndex);
      setCommand(nextIndex >= 0 ? history[nextIndex] : '');
      setSuggestActive(-1);
    }
    // Enter runs the command; Shift+Enter drops in a newline (multiline input).
    if (key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      run();
    }
  }

  // Auto-grow the command box with its content (up to a cap).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [command]);

  if (!visible) return null;

  const isMax = sizeState === 'max';
  const isMin = sizeState === 'min';
  const panelHeight = isMax ? '72%' : isMin ? undefined : height;

  const outputLines = lines.filter((line) => line.type !== 'command');
  const problemCount = problems.length;

  return (
    <section
      className={`terminal-panel${isMax ? ' maximized' : ''}${isMin ? ' minimized' : ''}`}
      style={{ height: panelHeight }}
      aria-label="Panel"
    >
      <div className="panel-header panel-header-tabs">
        <div className="panel-tabs" role="tablist" aria-label="Panel sections">
          {PANEL_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`panel-tab${activeTab === tab.id ? ' active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
              {tab.id === 'problems' && problemCount > 0 && (
                <span className="panel-tab-badge">{problemCount}</span>
              )}
            </button>
          ))}
        </div>
        <div className="inline-actions">
          {activeTab === 'terminal' && (
            <>
              <ProfileMenu profiles={profiles} activeId={activeProfile} onSelect={setActiveProfile} />
              {lastExit && <span className="muted tiny">last exit: {lastExit.code ?? 'n/a'}</span>}
              <button
                type="button"
                className="icon-button"
                title="New terminal"
                aria-label="New terminal"
                onClick={() => commands.find((entry) => entry.id === 'terminal.new')?.run()}
              >
                <PlusIcon size={15} />
              </button>
              {runningId ? (
                <button type="button" className="icon-button danger" title="Stop command" onClick={cancel}>
                  <StopIcon size={15} />
                </button>
              ) : null}
              <button
                type="button"
                className="icon-button"
                title="Clear output"
                onClick={() => {
                  setLines([]);
                  setLastExit(null);
                }}
              >
                <TrashIcon size={15} />
              </button>
              <PanelMenu commands={commands} items={TERMINAL_MENU} />
            </>
          )}
          {activeTab === 'output' && (
            <button
              type="button"
              className="icon-button"
              title="Clear output"
              aria-label="Clear output"
              onClick={() => setLines([])}
            >
              <TrashIcon size={15} />
            </button>
          )}
          <button
            type="button"
            className={isMax ? 'icon-button is-active' : 'icon-button'}
            title={isMax ? 'Restore panel size' : 'Maximize panel'}
            aria-label={isMax ? 'Restore panel size' : 'Maximize panel'}
            aria-pressed={isMax}
            onClick={() => setSizeState((state) => (state === 'max' ? 'normal' : 'max'))}
          >
            <MaximizeIcon size={15} />
          </button>
          <button
            type="button"
            className={isMin ? 'icon-button is-active' : 'icon-button'}
            title={isMin ? 'Restore panel' : 'Minimize panel'}
            aria-label={isMin ? 'Restore panel' : 'Minimize panel'}
            aria-pressed={isMin}
            onClick={() => setSizeState((state) => (state === 'min' ? 'normal' : 'min'))}
          >
            <MinimizeIcon size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Close panel"
            aria-label="Close panel"
            onClick={() => (onClose ? onClose() : commands.find((entry) => entry.id === 'toggle-terminal')?.run())}
          >
            <CloseIcon size={15} />
          </button>
        </div>
      </div>

      {activeTab === 'terminal' && (
        <>
          <div className="terminal-output" ref={outputRef}>
            {lines.map((line, index) => (
              <pre key={index} className={`term-${line.type}`}>
                {line.text}
              </pre>
            ))}
          </div>

          <form className="terminal-input-row" onSubmit={run}>
            <span className="terminal-prompt">{root ? prompt : '—'}</span>
            <div className="terminal-input-wrap">
              {suggestionsOpen && (
                <ul className="term-suggestions" role="listbox" aria-label="Command suggestions">
                  {suggestions.map((entry, index) => (
                    <li key={entry} role="none">
                      <button
                        type="button"
                        role="option"
                        aria-selected={index === suggestActive}
                        className={index === suggestActive ? 'term-suggestion active' : 'term-suggestion'}
                        onMouseEnter={() => setSuggestActive(index)}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          acceptSuggestion(entry);
                        }}
                      >
                        <code>{entry}</code>
                        {index === suggestActive && <span className="term-suggestion-hint">Tab</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <textarea
                ref={inputRef}
                className="terminal-input"
                rows={1}
                value={command}
                onChange={(event) => {
                  setCommand(event.target.value);
                  setSuggestActive(-1);
                }}
                onKeyDown={handleKeyDown}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder={root ? 'Run a command — ↑ history, Tab to complete, Shift+Enter for newline' : 'Open a folder first'}
                disabled={!root || Boolean(runningId)}
                aria-label="Terminal command"
                spellCheck="false"
              />
            </div>
            <button type="submit" className="icon-button" title="Run" disabled={!root || Boolean(runningId) || !command.trim()}>
              <PlayIcon size={14} />
            </button>
          </form>
        </>
      )}

      {activeTab === 'output' && (
        <div className="terminal-output output-log">
          {outputLines.length === 0 ? (
            <div className="panel-empty">No output yet — run a command in the Terminal.</div>
          ) : (
            outputLines.map((line, index) => (
              <pre key={index} className={`term-${line.type}`}>
                {line.text}
              </pre>
            ))
          )}
        </div>
      )}

      {activeTab === 'problems' && (
        <div className="panel-list">
          {problemCount === 0 ? (
            <div className="panel-empty">No problems have been detected in the workspace.</div>
          ) : (
            problems.map((problem, index) => (
              <button
                type="button"
                key={index}
                className="problem-row"
                onClick={() => onOpenProblem?.(problem)}
              >
                <span className={`problem-sev sev-${problem.severity ?? 'info'}`} aria-hidden="true" />
                <span className="problem-msg">{problem.message}</span>
                <span className="problem-loc muted tiny">{problem.file}{problem.line ? `:${problem.line}` : ''}</span>
              </button>
            ))
          )}
        </div>
      )}

      {activeTab === 'debug' && (
        <div className="panel-empty">The debug console appears when you start a debugging session.</div>
      )}

      {activeTab === 'ports' && (
        <div className="panel-empty">No forwarded ports. A port shows up here when a running process opens one.</div>
      )}
    </section>
  );
}
