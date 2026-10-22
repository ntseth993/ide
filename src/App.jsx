/**
 * App orchestrator: owns workspace, tabs, dialogs, layout, and hotkeys.
 * Feature components stay presentational and receive actions as props.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { client, isDesktop, toUserMessage } from './services/novaClient';
import { useSettings } from './hooks/useSettings';
import { baseName, joinPath, normalizePath, parentPath, projectName } from './utils/pathUtils';
import ActivityBar from './components/ActivityBar';
import MenuBar from './components/MenuBar';
import ExplorerPanel from './components/ExplorerPanel';
import SearchPanel from './components/SearchPanel';
import EditorArea from './components/EditorArea';
import TerminalPanel from './components/TerminalPanel';
import AIPanel from './components/AIPanel';
import SettingsPanel from './components/SettingsPanel';
import StatusBar from './components/StatusBar';
import CommandPalette from './components/CommandPalette';
import ToastStack from './components/Toast';
import DiffReview from './components/DiffReview';
import { PromptDialog, ConfirmDialog } from './components/Dialogs';
import WelcomeScreen from './components/WelcomeScreen';
import HistoryPanel from './components/HistoryPanel';
import ExtensionsView from './components/ExtensionsView';
import NovaLinkView from './components/NovaLinkView';
import ShortcutsDialog from './components/ShortcutsDialog';
import SignInDialog from './components/SignInDialog';
import * as bus from './services/bus';
import { languageRunCommand } from './services/languageSupport';
import { getLanguage } from './utils/language';
import { getTheme, THEMES, THEME_IDS } from './themes';
import { mergeSnippetsByLanguage } from './services/builtinSnippets';
import { registerInlineAI } from './services/inlineAI';

const RECENT_KEY = 'novacode-recent';
const RECENT_LIMIT = 8;

function sessionKey(root) {
  return `novacode-session:${normalizePath(root)}`;
}

function flattenFiles(nodes, out = []) {
  for (const node of nodes) {
    if (node.type === 'file') out.push(node.path);
    if (node.children?.length) flattenFiles(node.children, out);
  }
  return out;
}

export default function App() {
  const { settings, update, ready } = useSettings();
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [tree, setTree] = useState([]);
  const [expanded, setExpanded] = useState(new Set());
  const [selectedPath, setSelectedPath] = useState('');
  const [leftView, setLeftView] = useState('explorer');
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [rightMode, setRightMode] = useState('ai'); // ai | settings | none

  const [tabs, setTabs] = useState([]);
  const [activePath, setActivePath] = useState('');
  const [docs, setDocs] = useState({});
  const [cursor, setCursor] = useState(null);
  const [revealRequest, setRevealRequest] = useState(null);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [review, setReview] = useState(null);
  const [aiStreamingRunId, setAiStreamingRunId] = useState(null);
  const [aiState, setAiState] = useState('none');
  // 'agent' plans and rewrites files, 'ask' explains them.
  const [aiMode, setAiMode] = useState('agent');
  const [inlineAIState, setInlineAIState] = useState('off');

  const [promptState, setPromptState] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [extensionsState, setExtensionsState] = useState({ installed: [], available: [], exampleCatalog: true });
  const [extensionsBusyId, setExtensionsBusyId] = useState(null);
  const [extensionsError, setExtensionsError] = useState('');
  const [monacoApi, setMonacoApi] = useState(null);
  const [languageOverrides, setLanguageOverrides] = useState({});
  const [runtimes, setRuntimes] = useState(null);
  const [account, setAccount] = useState(null);
  const [signInOpen, setSignInOpen] = useState(false);
  const [signInMode, setSignInMode] = useState('browser');
  const [signInUrl, setSignInUrl] = useState('');
  const [authError, setAuthError] = useState('');
  const [recentProjects, setRecentProjects] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
    } catch {
      return [];
    }
  });
  const toastId = useRef(0);
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const activeRef = useRef(activePath);
  activeRef.current = activePath;
  // Active Monaco instance for menu-driven editor commands (find, goto, …).
  const editorApiRef = useRef(null);
  // Latest AI/editor state for the inline completion provider, which must read
  // current values without being re-registered on every keystroke.
  const inlineAIConfigRef = useRef({});
  inlineAIConfigRef.current = {
    enabled: Boolean(settings.inlineAI),
    signedIn: Boolean(account),
    provider: settings.ai.provider,
    model: settings.ai.model,
    baseUrl: settings.ai.baseUrl,
    tabSize: settings.tabSize,
    path: activePath ? normalizePath(activePath) : null,
  };

  const notify = useCallback((text, tone = 'info') => {
    const id = (toastId.current += 1);
    setToasts((current) => [...current, { id, text, tone }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 3200);
  }, []);

  // Load the signed-in account (if any) once on startup.
  useEffect(() => {
    client.getAccount().then((value) => setAccount(value || null)).catch(() => {});
  }, []);

  const handleBeginSignIn = useCallback(async () => {
    setAuthError('');
    setSignInUrl('');
    let result;
    try {
      result = await client.beginLogin();
    } catch {
      // Desktop bridge present but the flow failed — fall back to the in-app form.
      setSignInMode('form');
      setSignInOpen(true);
      return;
    }
    if (result?.local) {
      // Browser preview mode (no Electron): collect the email in-app.
      setSignInMode('form');
    } else {
      setSignInMode('browser');
      setSignInUrl(result?.url || '');
    }
    setSignInOpen(true);
  }, []);

  const handleLocalSignIn = useCallback(async (email, name) => {
    const signedIn = await client.signIn(email, name);
    setAccount(signedIn);
    setSignInOpen(false);
    setSignInUrl('');
    setAuthError('');
    notify(`Signed in as ${signedIn.email} — 1,000M tokens ready`, 'ok');
  }, [notify]);

  const handleCancelSignIn = useCallback(() => {
    client.cancelLogin();
    setSignInOpen(false);
    setSignInUrl('');
    setAuthError('');
  }, []);

  // The browser page posts back to a loopback server in the main process; when
  // the session arrives we land it here and dismiss the waiting dialog.
  useEffect(() => {
    return client.onAuthSession((signedIn) => {
      if (!signedIn) return;
      setAccount(signedIn);
      setSignInOpen(false);
      setSignInUrl('');
      setAuthError('');
      notify(`Signed in as ${signedIn.email} — 1,000M tokens ready`, 'ok');
    });
  }, [notify]);

  const handleSignOut = useCallback(async () => {
    try {
      await client.signOut();
      setAccount(null);
      setSignInUrl('');
      notify('Signed out');
    } catch (error) {
      notify(toUserMessage(error), 'error');
    }
  }, [notify]);

  // Merged contributions from ENABLED extensions (declarative data only).
  const extensionContributions = useMemo(() => {
    const merged = { theme: null, snippets: [], trimOnSave: false };
    for (const record of extensionsState.installed || []) {
      if (!record.enabled) continue;
      const contributes = record.manifest.contributes || {};
      if (!merged.theme && Array.isArray(contributes.themes) && contributes.themes.length) {
        merged.theme = contributes.themes[0];
      }
      if (contributes.snippets) merged.snippets.push(contributes.snippets);
      if (Array.isArray(contributes.formatters)) {
        merged.trimOnSave = merged.trimOnSave
          || contributes.formatters.some((formatter) => formatter.trimTrailingWhitespace);
      }
    }
    return merged;
  }, [extensionsState]);
  const trimOnSaveRef = useRef(false);
  trimOnSaveRef.current = extensionContributions.trimOnSave;

  // ---- theme variables -----------------------------------------------------
  useEffect(() => {
    const root = document.documentElement;
    const theme = getTheme(settings.theme);
    const palette = theme.palette;
    root.style.setProperty('--accent', settings.accent || theme.accent);
    root.style.setProperty('--accent-2', theme.accent2);
    root.style.setProperty('--accent-3', theme.accent3);
    root.style.setProperty('--bg', palette.bg);
    root.style.setProperty('--panel', palette.panel);
    root.style.setProperty('--surface', palette.surface);
    root.style.setProperty('--surface-2', palette.surface2);
    root.style.setProperty('--surface-3', palette.surface3);
    root.style.setProperty('--text', palette.text);
    root.style.setProperty('--muted', palette.muted);
    root.style.setProperty('--border', palette.border);
    // Derived tokens stay coherent across every palette.
    root.style.setProperty('--faint', `color-mix(in srgb, ${palette.muted} 72%, ${palette.bg})`);
    root.style.setProperty('--border-strong', `color-mix(in srgb, ${palette.muted} 34%, transparent)`);
    root.dataset.theme = theme.id;
    root.dataset.themeKind = theme.kind;
    root.style.colorScheme = theme.kind;
    // Decorative motion kill switch (Settings → Appearance).
    root.classList.toggle('reduce-animations', Boolean(settings.reduceAnimations));
    // Enabled theme extensions override individual CSS variables last.
    const extColors = extensionContributions.theme?.colors;
    if (extColors) {
      for (const [name, value] of Object.entries(extColors)) {
        root.style.setProperty(name, value);
      }
    }
    // Keep the native window and the pre-hydration canvas in sync with the
    // content, so a theme switch really covers the whole app (title bar,
    // window background, first paint) and not just the panels.
    const canvas = (root.style.getPropertyValue('--bg') || palette.bg).trim();
    root.style.setProperty('--nc-startup-bg', canvas);
    client.setWindowAppearance({ background: canvas, kind: theme.kind });
  }, [settings.theme, settings.accent, settings.reduceAnimations, extensionContributions.theme]);

  useEffect(() => {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recentProjects));
    } catch {
      /* storage unavailable */
    }
  }, [recentProjects]);

  // ---- workspace -----------------------------------------------------------
  const refreshTree = useCallback(async (root) => {
    if (!root) return [];
    try {
      const nodes = await client.readDir(root, root);
      setTree(nodes);
      return nodes;
    } catch (error) {
      notify(toUserMessage(error), 'error');
      return [];
    }
  }, [notify]);

  const openWorkspace = useCallback(async (folder) => {
    try {
      const resolved = await client.validateWorkspace(folder);
      setWorkspaceRoot(resolved);
      setSelectedPath(resolved);
      setExpanded(new Set());
      setRecentProjects((current) => [resolved, ...current.filter((item) => item !== resolved)].slice(0, RECENT_LIMIT));
      const nodes = await refreshTree(resolved);
      setTabs([]);
      setActivePath('');
      setDocs({});
      // Restore last session for this workspace.
      try {
        const saved = JSON.parse(localStorage.getItem(sessionKey(resolved)));
        if (saved?.tabs?.length && nodes) {
          const validFiles = new Set(flattenFiles(nodes));
          const validTabs = saved.tabs.filter((tabPath) => validFiles.has(tabPath));
          if (validTabs.length) {
            for (const tabPath of validTabs) {
              const text = await client.readFile(resolved, tabPath);
              setDocs((current) => ({ ...current, [tabPath]: { text, dirty: false } }));
            }
            setTabs(validTabs);
            const restore = validTabs.includes(saved.activePath) ? saved.activePath : validTabs[0];
            setActivePath(restore);
            setExpanded((current) => {
              const next = new Set(current);
              validTabs.forEach((tabPath) => {
                const parent = parentPath(tabPath);
                if (parent && normalizePath(parent).startsWith(normalizePath(resolved))) next.add(parent);
              });
              return next;
            });
          }
        }
      } catch {
        /* session restore is best-effort */
      }
    } catch (error) {
      notify(toUserMessage(error), 'error');
    }
  }, [notify, refreshTree]);

  const handleOpenFolder = useCallback(async () => {
    try {
      const directory = await client.chooseDirectory();
      if (directory) await openWorkspace(directory);
    } catch (error) {
      notify(toUserMessage(error), 'error');
    }
  }, [notify, openWorkspace]);

  const handleNewProject = useCallback(async () => {
    try {
      const directory = await client.chooseDirectory();
      if (!directory) return;
      const srcFolder = joinPath(directory, 'src');
      await client.createFolder(directory, directory, 'src');
      await client.createFile(directory, directory, 'README.md');
      await client.writeFile(directory, joinPath(directory, 'README.md'),
        '# My NovaCode Project\n\nCreated with NovaCode IDE.\n\n## Getting started\n\n1. Open the terminal (Ctrl+`)\n2. Run `node src/index.js`\n');
      await client.createFile(directory, srcFolder, 'index.js');
      await client.writeFile(directory, joinPath(srcFolder, 'index.js'),
        'console.log("Hello from NovaCode IDE!");\n');
      await openWorkspace(directory);
      notify('Project scaffold created');
    } catch (error) {
      notify(toUserMessage(error), 'error');
    }
  }, [notify, openWorkspace]);

  // ---- tabs & docs -----------------------------------------------------------
  // rootOverride lets callers open a file before workspaceRoot state has
  // propagated (e.g. the CLI request path: open parent folder, then file).
  const openFile = useCallback(async (filePath, revealLine = null, rootOverride = null) => {
    const root = rootOverride || workspaceRoot;
    if (!root) return;
    try {
      setSelectedPath(filePath);
      if (!docsRef.current[filePath]) {
        const text = await client.readFile(root, filePath);
        setDocs((current) => ({ ...current, [filePath]: { text, dirty: false } }));
      }
      setTabs((current) => (current.includes(filePath) ? current : [...current, filePath]));
      setActivePath(filePath);
      if (revealLine) {
        setRevealRequest({ path: filePath, line: revealLine, ts: Date.now() });
      }
    } catch (error) {
      notify(toUserMessage(error), 'error');
    }
  }, [notify, workspaceRoot]);

  // `nova <folder|file>` from the CLI arrives as a main-process event.
  useEffect(() => {
    return client.onWorkspaceRequest(async (request) => {
      if (!request || typeof request.path !== 'string') return;
      if (request.kind === 'workspace') {
        await openWorkspace(request.path);
      } else if (request.kind === 'file') {
        const root = parentPath(request.path);
        if (root) {
          await openWorkspace(root);
          await openFile(request.path, null, root);
        }
      } else if (request.kind === 'error') {
        notify(request.message || 'That path could not be opened.', 'error');
      }
    });
  }, [notify, openFile, openWorkspace]);

  const saveTab = useCallback(async (filePath, { silent = false } = {}) => {
    const doc = docsRef.current[filePath];
    if (!doc) return;
    try {
      // Enabled formatter extensions may adjust text before it reaches disk.
      const text = trimOnSaveRef.current ? doc.text.replace(/[ \t]+$/gm, '') : doc.text;
      await client.writeFile(workspaceRoot, filePath, text);
      setDocs((current) => ({ ...current, [filePath]: { text, dirty: false } }));
      if (!silent) notify(`Saved ${baseName(filePath)}`);
    } catch (error) {
      notify(toUserMessage(error), 'error');
    }
  }, [notify, workspaceRoot]);

  // Save the active document under a new name in the same folder (menu + palette).
  const handleSaveAs = useCallback(() => {
    const filePath = activeRef.current;
    const doc = filePath ? docsRef.current[filePath] : null;
    if (!filePath || !doc || !workspaceRoot) {
      notify('Open a file to use Save As.', 'error');
      return;
    }
    setPromptState({
      title: 'Save As',
      initial: baseName(filePath),
      onSubmit: async (name) => {
        const trimmed = String(name || '').trim();
        if (!trimmed) return;
        const dir = parentPath(filePath) || workspaceRoot;
        const newPath = joinPath(dir, trimmed);
        try {
          await client.writeFile(workspaceRoot, newPath, doc.text);
          await refreshTree(workspaceRoot);
          await openFile(newPath);
          notify(`Saved ${trimmed}`);
        } catch (error) {
          notify(toUserMessage(error), 'error');
        }
      },
    });
  }, [notify, openFile, refreshTree, workspaceRoot]);

  // Execute a Monaco editor command on the active editor (menu dispatch).
  const runEditorAction = useCallback((actionId) => {
    const editor = editorApiRef.current?.editor;
    if (!editor || editor.isDisposed?.()) {
      notify('Open a file first.', 'error');
      return;
    }
    editor.getAction(actionId)?.run();
  }, [notify]);

  const closeTab = useCallback((filePath) => {
    const doc = docsRef.current[filePath];
    const doClose = () => {
      setTabs((current) => {
        const next = current.filter((path) => path !== filePath);
        if (activeRef.current === filePath) {
          setActivePath(next[next.length - 1] || '');
        }
        return next;
      });
      setDocs((current) => {
        const next = { ...current };
        delete next[filePath];
        return next;
      });
    };
    if (doc?.dirty) {
      setConfirmState({
        title: 'Unsaved changes',
        message: `${baseName(filePath)} has unsaved changes. Close without saving?`,
        confirmLabel: 'Close without saving',
        onSubmit: doClose,
      });
    } else {
      doClose();
    }
  }, []);

  const handleChange = useCallback((filePath, text) => {
    setDocs((current) => ({
      ...current,
      [filePath]: { text, dirty: current[filePath]?.text !== text },
    }));
  }, []);

  // Autosave (optional setting).
  useEffect(() => {
    if (!settings.autosave || !workspaceRoot) return undefined;
    const dirtyPaths = Object.entries(docs)
      .filter(([, doc]) => doc.dirty)
      .map(([path]) => path);
    if (dirtyPaths.length === 0) return undefined;
    const timer = setTimeout(() => {
      dirtyPaths.forEach((path) => saveTab(path, { silent: true }));
    }, 800);
    return () => clearTimeout(timer);
  }, [docs, settings.autosave, workspaceRoot, saveTab]);

  // Session persistence.
  useEffect(() => {
    if (!workspaceRoot) return;
    try {
      localStorage.setItem(sessionKey(workspaceRoot), JSON.stringify({ tabs, activePath }));
    } catch {
      /* storage unavailable */
    }
  }, [tabs, activePath, workspaceRoot]);

  // Warn before closing with unsaved work.
  useEffect(() => {
    const hasDirty = Object.values(docs).some((doc) => doc.dirty);
    const handler = (event) => {
      if (hasDirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [docs]);

  // ---- file operations (explorer) --------------------------------------------
  const targetDir = useCallback(() => {
    if (!workspaceRoot) return null;
    if (!selectedPath || normalizePath(selectedPath) === normalizePath(workspaceRoot)) return workspaceRoot;
    // Folders in the tree carry children; decide by checking the tree.
    const isFolder = (nodes) => nodes.some((node) => {
      if (node.path === selectedPath) return node.type === 'folder';
      return node.children ? isFolder(node.children) : false;
    });
    return isFolder(tree) ? selectedPath : parentPath(selectedPath) || workspaceRoot;
  }, [selectedPath, tree, workspaceRoot]);

  const handleCreateFile = useCallback(() => {
    const dir = targetDir();
    if (!dir) return;
    setPromptState({
      title: `New file in ${baseName(dir) || 'workspace'}`,
      onSubmit: async (name) => {
        try {
          const { path: newPath } = await client.createFile(workspaceRoot, dir, name);
          await refreshTree(workspaceRoot);
          setExpanded((current) => new Set(current).add(normalizePath(dir)));
          await openFile(newPath);
        } catch (error) {
          notify(toUserMessage(error), 'error');
        }
      },
    });
  }, [notify, openFile, refreshTree, targetDir, workspaceRoot]);

  const handleCreateFolder = useCallback(() => {
    const dir = targetDir();
    if (!dir) return;
    setPromptState({
      title: `New folder in ${baseName(dir) || 'workspace'}`,
      onSubmit: async (name) => {
        try {
          await client.createFolder(workspaceRoot, dir, name);
          await refreshTree(workspaceRoot);
          setExpanded((current) => {
            const next = new Set(current);
            next.add(normalizePath(dir));
            next.add(normalizePath(joinPath(dir, name)));
            return next;
          });
        } catch (error) {
          notify(toUserMessage(error), 'error');
        }
      },
    });
  }, [notify, refreshTree, targetDir, workspaceRoot]);

  const handleRename = useCallback((node) => {
    setPromptState({
      title: `Rename ${node.name}`,
      initial: node.name,
      onSubmit: async (newName) => {
        try {
          const { path: newPath } = await client.renamePath(workspaceRoot, node.path, newName);
          setTabs((current) => current.map((path) => (path === node.path ? newPath : path)));
          setActivePath((current) => (current === node.path ? newPath : current));
          setDocs((current) => {
            const next = { ...current };
            if (next[node.path]) {
              next[newPath] = next[node.path];
              delete next[node.path];
            }
            return next;
          });
          if (node.type === 'folder') {
            setExpanded((current) => {
              const next = new Set();
              current.forEach((folder) => {
                next.add(folder === node.path ? newPath : folder.replace(node.path, newPath));
              });
              return next;
            });
          }
          await refreshTree(workspaceRoot);
          notify('Renamed');
        } catch (error) {
          notify(toUserMessage(error), 'error');
        }
      },
    });
  }, [notify, refreshTree, workspaceRoot]);

  const handleDelete = useCallback((node) => {
    setConfirmState({
      title: `Delete ${node.name}`,
      message: node.type === 'folder'
        ? `Delete "${node.name}" and everything inside it? This cannot be undone.`
        : `Delete "${node.name}"? This cannot be undone.`,
      onSubmit: async () => {
        try {
          await client.deletePath(workspaceRoot, node.path);
          const prefix = `${normalizePath(node.path)}/`;
          const doomed = node.type === 'folder'
            ? tabs.filter((path) => normalizePath(path).startsWith(prefix) || path === node.path)
            : tabs.filter((path) => path === node.path);
          doomed.forEach((path) => closeTab(path));
          if (activePath === node.path && !doomed.includes(node.path)) closeTab(node.path);
          await refreshTree(workspaceRoot);
          notify('Deleted');
        } catch (error) {
          notify(toUserMessage(error), 'error');
        }
      },
    });
  }, [activePath, closeTab, notify, refreshTree, tabs, workspaceRoot]);

  // ---- AI ---------------------------------------------------------------------
  const activeFile = useMemo(() => {
    if (!activePath || !docs[activePath]) return null;
    return {
      path: activePath,
      name: baseName(activePath),
      language: (activePath.split('.').pop() || '').toLowerCase(),
      text: docs[activePath].text,
    };
  }, [activePath, docs]);

  const handleProposeEdit = useCallback((proposal) => {
    setReview(proposal);
  }, []);

  const handleAcceptReview = useCallback(async () => {
    if (!review) return;
    try {
      // Journaled apply: the main process records previous content BEFORE the
      // write, so every accepted AI edit is restorable from Change History.
      await client.applyAiEdit(workspaceRoot, review.path, review.modified);
      setDocs((current) => ({
        ...current,
        [review.path]: { text: review.modified, dirty: false },
      }));
      setTabs((current) => (current.includes(review.path) ? current : [...current, review.path]));
      setActivePath(review.path);
      setReview(null);
      notify('Changes applied — restore anytime from Change History');
    } catch (error) {
      notify(toUserMessage(error), 'error');
    }
  }, [notify, review, workspaceRoot]);

  const handleRestored = useCallback((result) => {
    if (!result?.filePath) return;
    if (result.content === null) {
      // The edit had created this file; restoring removed it.
      setDocs((current) => {
        const next = { ...current };
        delete next[result.filePath];
        return next;
      });
      setTabs((current) => current.filter((tab) => tab !== result.filePath));
      setActivePath((current) => (current === result.filePath ? '' : current));
      notify(`Removed ${baseName(result.filePath)} (back to pre-edit state)`);
    } else {
      setDocs((current) => ({ ...current, [result.filePath]: { text: result.content, dirty: false } }));
      notify(`Restored ${baseName(result.filePath)}`);
    }
  }, [notify]);

  // ---- layout -------------------------------------------------------------------
  const layout = settings.layout;
  const setLayout = useCallback((patch) => update({ layout: { ...layout, ...patch } }), [layout, update]);

  const startDrag = useCallback((kind) => (event) => {
    event.preventDefault();
    const startPos = kind === 'terminalHeight' ? event.clientY : event.clientX;
    const startSize = kind === 'terminalHeight' ? layout.terminalHeight : kind === 'aiPanelWidth' ? layout.aiPanelWidth : layout.sidebarWidth;
    const invert = kind !== 'terminalHeight' && kind !== 'sidebarWidth';

    function onMove(moveEvent) {
      const delta = (kind === 'terminalHeight' ? startPos - moveEvent.clientY : moveEvent.clientX - startPos) * (invert ? -1 : 1);
      if (kind === 'terminalHeight') setLayout({ terminalHeight: startSize + delta });
      else if (kind === 'aiPanelWidth') setLayout({ aiPanelWidth: startSize - delta });
      else setLayout({ sidebarWidth: startSize + delta });
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [layout, setLayout]);

  // Run the active file with its detected interpreter in the terminal.
  // (Defined after setLayout because it toggles terminal visibility.)
  const handleRunFile = useCallback(() => {
    const filePath = activeRef.current;
    if (!filePath || !workspaceRoot) {
      notify('Open a file to run.', 'error');
      return;
    }
    const command = languageRunCommand(getLanguage(filePath), filePath);
    if (!command) {
      notify(`No run command is configured for ${baseName(filePath)} yet.`, 'error');
      return;
    }
    setLayout({ terminalVisible: true });
    bus.emit('terminal:run', { command });
    notify(`Running ${baseName(filePath)}…`);
  }, [notify, setLayout, workspaceRoot]);

  // ---- extensions -------------------------------------------------------------
  const refreshExtensions = useCallback(async () => {
    try {
      setExtensionsState(await client.listExtensions());
      setExtensionsError('');
    } catch (error) {
      setExtensionsError(toUserMessage(error));
    }
  }, []);

  useEffect(() => {
    refreshExtensions();
  }, [refreshExtensions]);

  const handleInstallExtension = useCallback(async (id) => {
    setExtensionsBusyId(id);
    try {
      await client.installExtension(id);
      await refreshExtensions();
      notify('Extension installed');
    } catch (error) {
      setExtensionsError(toUserMessage(error));
    } finally {
      setExtensionsBusyId(null);
    }
  }, [notify, refreshExtensions]);

  const handleToggleExtension = useCallback(async (id, enabled) => {
    setExtensionsBusyId(id);
    try {
      await client.setExtensionEnabled(id, enabled);
      await refreshExtensions();
      notify(enabled ? 'Extension enabled' : 'Extension disabled');
    } catch (error) {
      setExtensionsError(toUserMessage(error));
    } finally {
      setExtensionsBusyId(null);
    }
  }, [notify, refreshExtensions]);

  const handleUpdateExtension = useCallback(async (id) => {
    setExtensionsBusyId(id);
    try {
      const result = await client.updateExtension(id);
      await refreshExtensions();
      notify(result?.updated ? `Updated to v${result.version}` : 'Already up to date');
    } catch (error) {
      setExtensionsError(toUserMessage(error));
    } finally {
      setExtensionsBusyId(null);
    }
  }, [notify, refreshExtensions]);

  const handleUninstallExtension = useCallback(async (id) => {
    setExtensionsBusyId(id);
    try {
      await client.uninstallExtension(id);
      await refreshExtensions();
      notify('Extension uninstalled');
    } catch (error) {
      setExtensionsError(toUserMessage(error));
    } finally {
      setExtensionsBusyId(null);
    }
  }, [notify, refreshExtensions]);

  // Code shortcuts: built-in snippet prefixes plus anything an enabled
  // extension contributes. Typing e.g. `fn` and accepting inserts a skeleton
  // with tab stops, so Tab walks the placeholders.
  useEffect(() => {
    const monaco = monacoApi?.monaco;
    if (!monaco) return undefined;
    const disposables = [];
    const snippetsByLanguage = mergeSnippetsByLanguage(extensionContributions.snippets);
    for (const [languageId, snippets] of snippetsByLanguage) {
      disposables.push(monaco.languages.registerCompletionItemProvider(languageId, {
        provideCompletionItems(model, position) {
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };
          return {
            suggestions: snippets.map((snippet) => ({
              label: snippet.prefix,
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: snippet.body,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: snippet.description ? `${snippet.description} · ${snippet.source}` : `${snippet.source} snippet`,
              range,
            })),
          };
        },
      }));
    }
    return () => disposables.forEach((disposable) => disposable.dispose());
  }, [extensionContributions.snippets, monacoApi]);

  // AI inline suggestions (ghost text at the caret, Tab commits).
  useEffect(() => {
    const monaco = monacoApi?.monaco;
    if (!monaco) return undefined;
    const handle = registerInlineAI({
      monaco,
      getConfig: () => inlineAIConfigRef.current,
      onStatus: (status) => setInlineAIState(status),
    });
    return () => handle.dispose();
  }, [monacoApi]);

  // Detect language runtimes once when the Settings panel opens.
  useEffect(() => {
    if (rightMode !== 'settings' || runtimes) return;
    let active = true;
    client.detectRuntimes()
      .then((data) => { if (active) setRuntimes(data); })
      .catch(() => { /* surfaced in the panel via null state */ });
    return () => { active = false; };
  }, [rightMode, runtimes]);

  // ---- NovaLink -------------------------------------------------------------
  // Read the current editor selection so the NovaLink panel can offer "Share
  // Selected Code" without the renderer component ever touching Monaco state.
  const getEditorSelection = useCallback(() => {
    const editor = editorApiRef.current?.editor;
    if (!editor || editor.isDisposed?.()) return null;
    const model = editor.getModel?.();
    const selection = editor.getSelection?.();
    if (!model || !selection || selection.isEmpty?.()) return null;
    const text = model.getValueInRange(selection);
    if (!text) return null;
    const path = activeRef.current ? normalizePath(activeRef.current) : '';
    return { text, language: model.getLanguageId?.() || '', path };
  }, []);

  // ---- commands & hotkeys ----------------------------------------------------------
  // Switching theme also adopts that theme accent, which is what makes a
  // "Dragon" or "Flowers" switch feel complete; the accent stays editable after.
  const applyTheme = useCallback((id) => {
    const theme = getTheme(id);
    update({ theme: theme.id, accent: theme.accent });
    notify(`${theme.label} theme applied`);
  }, [notify, update]);

  const commands = useMemo(() => {
    const list = [
      { id: 'open-folder', label: 'File: Open Folder…', hint: 'Ctrl+O', run: handleOpenFolder },
      { id: 'new-project', label: 'File: New Project…', run: handleNewProject },
      { id: 'new-file', label: 'File: New File…', hint: 'Ctrl+N', run: handleCreateFile },
      { id: 'new-folder', label: 'File: New Folder…', run: handleCreateFolder },
      { id: 'save', label: 'File: Save', hint: 'Ctrl+S', run: () => activeRef.current && saveTab(activeRef.current) },
      {
        id: 'save-all',
        label: 'File: Save All',
        run: () => Object.entries(docsRef.current).filter(([, doc]) => doc.dirty).forEach(([path]) => saveTab(path, { silent: true })),
      },
      { id: 'save-as', label: 'File: Save As…', hint: 'Ctrl+Shift+S', run: handleSaveAs },
      { id: 'close-editor', label: 'File: Close Editor', hint: 'Ctrl+W', run: () => activeRef.current && closeTab(activeRef.current) },
      {
        id: 'close-folder',
        label: 'File: Close Folder',
        run: () => {
          setWorkspaceRoot('');
          setTabs([]);
          setDocs({});
          setActivePath('');
          setSelectedPath('');
          setTree([]);
          setExpanded(new Set());
        },
      },
      { id: 'editor.find', label: 'Edit: Find', hint: 'Ctrl+F', run: () => runEditorAction('actions.find') },
      { id: 'editor.replace', label: 'Edit: Replace', hint: 'Ctrl+H', run: () => runEditorAction('editor.action.startFindReplaceAction') },
      { id: 'editor.undo', label: 'Edit: Undo', hint: 'Ctrl+Z', run: () => runEditorAction('undo') },
      { id: 'editor.redo', label: 'Edit: Redo', hint: 'Ctrl+Y', run: () => runEditorAction('redo') },
      { id: 'editor.cut', label: 'Edit: Cut', hint: 'Ctrl+X', run: () => runEditorAction('editor.action.clipboardCutAction') },
      { id: 'editor.copy', label: 'Edit: Copy', hint: 'Ctrl+C', run: () => runEditorAction('editor.action.clipboardCopyAction') },
      { id: 'editor.paste', label: 'Edit: Paste', hint: 'Ctrl+V', run: () => runEditorAction('editor.action.clipboardPasteAction') },
      { id: 'selection.select-all', label: 'Selection: Select All', hint: 'Ctrl+A', run: () => runEditorAction('editor.action.selectAll') },
      { id: 'editor.expand-selection', label: 'Selection: Expand Selection', run: () => runEditorAction('editor.action.smartSelect.expand') },
      { id: 'editor.cursor-below', label: 'Selection: Add Cursor Below', run: () => runEditorAction('editor.action.insertCursorBelow') },
      { id: 'editor.cursor-above', label: 'Selection: Add Cursor Above', run: () => runEditorAction('editor.action.insertCursorAbove') },
      { id: 'editor.goto-line', label: 'Go: Go to Line…', hint: 'Ctrl+G', run: () => runEditorAction('editor.action.gotoLine') },
      { id: 'editor.goto-definition', label: 'Go: Go to Definition', hint: 'F12', run: () => runEditorAction('editor.action.revealDefinition') },
      { id: 'editor.toggle-comment', label: 'Edit: Toggle Line Comment', hint: 'Ctrl+/', run: () => runEditorAction('editor.action.commentLine') },
      { id: 'editor.block-comment', label: 'Edit: Toggle Block Comment', hint: 'Shift+Alt+A', run: () => runEditorAction('editor.action.blockComment') },
      { id: 'editor.emmet-expand', label: 'Edit: Emmet Expand Abbreviation', run: () => runEditorAction('editor.emmet.action.expandAbbreviation') },
      { id: 'editor.format-document', label: 'Edit: Format Document', hint: 'Shift+Alt+F', run: () => runEditorAction('editor.action.formatDocument') },
      { id: 'editor.shrink-selection', label: 'Selection: Shrink Selection', run: () => runEditorAction('editor.action.smartSelect.shrink') },
      { id: 'editor.copy-line-up', label: 'Selection: Copy Line Up', run: () => runEditorAction('editor.action.copyLinesUpAction') },
      { id: 'editor.copy-line-down', label: 'Selection: Copy Line Down', run: () => runEditorAction('editor.action.copyLinesDownAction') },
      { id: 'editor.move-line-up', label: 'Selection: Move Line Up', run: () => runEditorAction('editor.action.moveLinesUpAction') },
      { id: 'editor.move-line-down', label: 'Selection: Move Line Down', run: () => runEditorAction('editor.action.moveLinesDownAction') },
      { id: 'editor.duplicate-selection', label: 'Selection: Duplicate Selection', run: () => runEditorAction('editor.action.duplicateSelection') },
      { id: 'editor.cursors-line-ends', label: 'Selection: Add Cursors to Line Ends', run: () => runEditorAction('editor.action.addCursorsToLineEnds') },
      { id: 'editor.add-next-occurrence', label: 'Selection: Add Next Occurrence', hint: 'Ctrl+D', run: () => runEditorAction('editor.action.addSelectionToNextFindMatch') },
      { id: 'editor.add-prev-occurrence', label: 'Selection: Add Previous Occurrence', run: () => runEditorAction('editor.action.addSelectionToPreviousFindMatch') },
      { id: 'editor.select-all-occurrences', label: 'Selection: Select All Occurrences', hint: 'Ctrl+Shift+L', run: () => runEditorAction('editor.action.selectHighlights') },
      { id: 'editor.column-selection', label: 'Selection: Column Selection Mode', run: () => runEditorAction('editor.action.toggleColumnSelection') },
      { id: 'editor.goto-symbol', label: 'Go: Go to Symbol in Editor…', hint: 'Ctrl+Shift+O', run: () => runEditorAction('editor.action.gotoSymbol') },
      { id: 'editor.goto-bracket', label: 'Go: Go to Bracket', hint: 'Ctrl+Shift+\\', run: () => runEditorAction('editor.action.jumpToBracket') },
      { id: 'editor.goto-declaration', label: 'Go: Go to Declaration', run: () => runEditorAction('editor.action.revealDeclaration') },
      { id: 'editor.goto-type-definition', label: 'Go: Go to Type Definition', run: () => runEditorAction('editor.action.goToTypeDefinition') },
      { id: 'editor.goto-implementations', label: 'Go: Go to Implementations', hint: 'Ctrl+F12', run: () => runEditorAction('editor.action.goToImplementation') },
      { id: 'editor.goto-references', label: 'Go: Go to References', hint: 'Shift+F12', run: () => runEditorAction('editor.action.goToReferences') },
      { id: 'view.explorer', label: 'View: Explorer', hint: 'Ctrl+Shift+E', run: () => { setLeftView('explorer'); setSidebarVisible(true); } },
      { id: 'view.search', label: 'View: Search', run: () => { setLeftView('search'); setSidebarVisible(true); } },
      { id: 'view.extensions', label: 'View: Extensions', hint: 'Ctrl+Shift+X', run: () => { setLeftView('extensions'); setSidebarVisible(true); } },
      { id: 'view.novalink', label: 'View: NovaLink (peer collaboration)', run: () => { setLeftView('novalink'); setSidebarVisible(true); } },
      { id: 'toggle-terminal', label: 'View: Toggle Terminal', hint: 'Ctrl+`', run: () => setLayout({ terminalVisible: !layout.terminalVisible }) },
      { id: 'view.terminal', label: 'View: Terminal', run: () => setLayout({ terminalVisible: true }) },
      {
        id: 'view.problems',
        label: 'View: Problems',
        hint: 'Ctrl+Shift+M',
        run: () => { setLayout({ terminalVisible: true }); bus.emit('panel:tab', { tab: 'problems' }); },
      },
      {
        id: 'view.output',
        label: 'View: Output',
        hint: 'Ctrl+Shift+U',
        run: () => { setLayout({ terminalVisible: true }); bus.emit('panel:tab', { tab: 'output' }); },
      },
      {
        id: 'view.debug',
        label: 'View: Debug Console',
        hint: 'Ctrl+Shift+Y',
        run: () => { setLayout({ terminalVisible: true }); bus.emit('panel:tab', { tab: 'debug' }); },
      },
      { id: 'toggle-sidebar', label: 'View: Toggle Sidebar', hint: 'Ctrl+B', run: () => setSidebarVisible((visible) => !visible) },
      { id: 'toggle-ai', label: 'View: Toggle AI Panel', run: () => setRightMode((mode) => (mode === 'ai' ? 'none' : 'ai')) },
      { id: 'view.ai', label: 'View: AI Assistant', hint: 'Ctrl+Shift+A', run: () => setRightMode('ai') },
      { id: 'view.history', label: 'View: Change History', run: () => setRightMode('history') },
      { id: 'view.settings', label: 'View: Open Settings', hint: 'Ctrl+,', run: () => setRightMode('settings') },
      { id: 'open-settings', label: 'View: Open Settings', run: () => setRightMode('settings') },
      { id: 'open-history', label: 'View: Open Change History', run: () => setRightMode('history') },
      { id: 'open-palette', label: 'View: Command Palette', hint: 'Ctrl+P', run: () => setPaletteOpen((open) => !open) },
      {
        id: 'cycle-theme',
        label: 'View: Next Theme',
        run: () => applyTheme(THEME_IDS[(THEME_IDS.indexOf(settings.theme) + 1) % THEME_IDS.length]),
      },
      ...THEMES.map((theme) => ({
        id: `theme.${theme.id}`,
        label: `Theme: ${theme.label}`,
        hint: theme.id === settings.theme ? 'active' : undefined,
        run: () => applyTheme(theme.id),
      })),
      {
        id: 'toggle-inline-ai',
        label: 'AI: Toggle Inline Suggestions',
        hint: 'Tab accepts',
        checked: Boolean(settings.inlineAI),
        run: () => update({ inlineAI: !settings.inlineAI }),
      },
      { id: 'ai.mode-agent', label: 'AI: Agent Mode (plans and edits files)', run: () => { setAiMode('agent'); setRightMode('ai'); } },
      { id: 'ai.mode-ask', label: 'AI: Ask Mode (explain only)', run: () => { setAiMode('ask'); setRightMode('ai'); } },
      { id: 'editor.snippets', label: 'Insert: Code Snippet Shortcut', hint: 'Ctrl+Space', run: () => runEditorAction('editor.action.triggerSuggest') },
      { id: 'toggle-autosave', label: 'File: Toggle Auto Save', checked: Boolean(settings.autosave), run: () => update({ autosave: !settings.autosave }) },
      { id: 'toggle-word-wrap', label: 'View: Toggle Word Wrap', hint: 'Alt+Z', checked: Boolean(settings.wordWrap), run: () => update({ wordWrap: !settings.wordWrap }) },
      { id: 'terminal.new', label: 'Terminal: New Terminal', hint: 'Ctrl+Shift+`', run: () => { setLayout({ terminalVisible: true }); bus.emit('terminal:new'); } },
      { id: 'terminal.clear', label: 'Terminal: Clear', run: () => bus.emit('terminal:clear') },
      { id: 'run.file', label: 'Run: Run File', hint: 'F5', run: handleRunFile },
      { id: 'run.stop', label: 'Run: Stop', hint: 'Shift+F5', run: () => bus.emit('terminal:stop') },
      { id: 'help.shortcuts', label: 'Help: Keyboard Shortcuts', run: () => setShortcutsOpen(true) },
      { id: 'account.sign-in', label: 'Account: Sign In…', run: handleBeginSignIn },
      { id: 'account.sign-out', label: 'Account: Sign Out', run: handleSignOut },
    ];
    return list;
  }, [applyTheme, closeTab, handleBeginSignIn, handleCreateFile, handleCreateFolder, handleNewProject, handleOpenFolder, handleRunFile, handleSaveAs, handleSignOut, layout.terminalVisible, runEditorAction, saveTab, setLayout, settings.autosave, settings.inlineAI, settings.theme, settings.wordWrap, update]);

  // The native application menu dispatches these same command ids.
  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  useEffect(() => client.onMenuCommand((commandId) => {
    const command = commandsRef.current.find((entry) => entry.id === commandId);
    if (command) {
      command.run();
    } else {
      notify(`Command is not available yet: ${commandId}`, 'error');
    }
  }), [notify]);

  const paletteFiles = useMemo(() => {
    const files = flattenFiles(tree);
    return files.map((path) => ({ path, open: () => openFile(path) }));
  }, [openFile, tree]);

  useEffect(() => {
    function onKeyDown(event) {
      const ctrlOrMeta = event.ctrlKey || event.metaKey;
      if (!ctrlOrMeta) {
        if (event.key === 'Escape') setPaletteOpen(false);
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        if (activeRef.current) saveTab(activeRef.current);
      } else if (key === 'p') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (key === 'b') {
        event.preventDefault();
        setSidebarVisible((visible) => !visible);
      } else if (key === '`') {
        event.preventDefault();
        setLayout({ terminalVisible: !layout.terminalVisible });
      } else if (key === 'w' && activeRef.current) {
        event.preventDefault();
        closeTab(activeRef.current);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeTab, layout.terminalVisible, saveTab, setLayout]);

  if (!ready) {
    return <div className="app-loading">Starting NovaCode…</div>;
  }

  return (
    <div className="app-root">
      <MenuBar commands={commands} account={account} onSignIn={handleBeginSignIn} onSignOut={handleSignOut} />
      <div className="app-shell">
      <ActivityBar
        view={leftView}
        onView={(view) => {
          setLeftView(view);
          setSidebarVisible(true);
        }}
        terminalVisible={layout.terminalVisible}
        aiPanelVisible={rightMode !== 'none'}
        sidebarVisible={sidebarVisible}
        onToggleTerminal={() => setLayout({ terminalVisible: !layout.terminalVisible })}
        onToggleAiPanel={() => setRightMode((mode) => (mode === 'ai' ? 'none' : 'ai'))}
        onToggleSidebar={() => setSidebarVisible((visible) => !visible)}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenSettings={() => setRightMode('settings')}
        onOpenHistory={() => setRightMode('history')}
        settingsActive={rightMode === 'settings'}
        historyActive={rightMode === 'history'}
      />

      <main className="workspace">
        {!workspaceRoot ? (
          <div className="workbench">
            {sidebarVisible && leftView !== 'explorer' && (
              <>
                <div className="sidebar" style={{ width: layout.sidebarWidth }}>
                  {leftView === 'extensions' ? (
                    <ExtensionsView
                      data={extensionsState}
                      busyId={extensionsBusyId}
                      error={extensionsError}
                      onRefresh={refreshExtensions}
                      onInstall={handleInstallExtension}
                      onToggle={handleToggleExtension}
                      onUpdate={handleUpdateExtension}
                      onUninstall={handleUninstallExtension}
                      onInstalled={refreshExtensions}
                    />
                  ) : leftView === 'novalink' ? (
                    <NovaLinkView
                      workspaceRoot={workspaceRoot}
                      activeFilePath={activePath}
                      getEditorSelection={getEditorSelection}
                      onNotify={notify}
                    />
                  ) : (
                    <SearchPanel root={workspaceRoot} onOpenResult={(filePath, line) => openFile(filePath, line)} />
                  )}
                </div>
                <div className="splitter vertical" onPointerDown={startDrag('sidebarWidth')} role="separator" aria-orientation="vertical" />
              </>
            )}
            <div className="editor-column">
              <WelcomeScreen
                recentProjects={recentProjects}
                onOpenFolder={handleOpenFolder}
                onNewProject={handleNewProject}
                onOpenRecent={openWorkspace}
                onCommand={(commandId) => {
                  const command = commandsRef.current.find((entry) => entry.id === commandId);
                  if (command) command.run();
                }}
                account={account}
                isDesktop={isDesktop}
                onSignIn={handleBeginSignIn}
                onSignOut={handleSignOut}
                theme={settings.theme}
                onSetTheme={applyTheme}
              />
            </div>
          </div>
        ) : (
          <>
            <div className="workbench">
              {sidebarVisible && (
                <>
                  <div className="sidebar" style={{ width: layout.sidebarWidth }}>
                    {leftView === 'explorer' ? (
                      <ExplorerPanel
                        tree={tree}
                        root={workspaceRoot}
                        activeTab={activePath}
                        selectedPath={selectedPath}
                        expanded={expanded}
                        onToggleFolder={(folderPath) => setExpanded((current) => {
                          const next = new Set(current);
                          if (next.has(folderPath)) next.delete(folderPath);
                          else next.add(folderPath);
                          return next;
                        })}
                        onOpenFile={openFile}
                        onCreateFile={handleCreateFile}
                        onCreateFolder={handleCreateFolder}
                        onRename={handleRename}
                        onDelete={handleDelete}
                        onRefresh={() => refreshTree(workspaceRoot)}
                      />
                    ) : leftView === 'extensions' ? (
                      <ExtensionsView
                        data={extensionsState}
                        busyId={extensionsBusyId}
                        error={extensionsError}
                        onRefresh={refreshExtensions}
                        onInstall={handleInstallExtension}
                        onToggle={handleToggleExtension}
                        onUpdate={handleUpdateExtension}
                        onUninstall={handleUninstallExtension}
                        onInstalled={refreshExtensions}
                      />
                    ) : leftView === 'novalink' ? (
                      <NovaLinkView
                        workspaceRoot={workspaceRoot}
                        activeFilePath={activePath}
                        getEditorSelection={getEditorSelection}
                        onNotify={notify}
                      />
                    ) : (
                      <SearchPanel
                        root={workspaceRoot}
                        onOpenResult={(filePath, line) => openFile(filePath, line)}
                      />
                    )}
                  </div>
                  <div className="splitter vertical" onPointerDown={startDrag('sidebarWidth')} role="separator" aria-orientation="vertical" />
                </>
              )}

              <div className="editor-column">
                <EditorArea
                  tabs={tabs}
                  activePath={activePath}
                  docs={docs}
                  settings={settings}
                  revealRequest={revealRequest}
                  onSelectTab={setActivePath}
                  onCloseTab={closeTab}
                  onChange={handleChange}
                  onCursor={setCursor}
                  onEditorMount={(editor, monaco) => {
                    editorApiRef.current = { editor, monaco };
                    setMonacoApi({ monaco });
                  }}
                  language={languageOverrides[activePath] || null}
                />
                <TerminalPanel
                  root={workspaceRoot}
                  height={layout.terminalHeight}
                  visible={layout.terminalVisible}
                  commands={commands}
                  onClose={() => setLayout({ terminalVisible: false })}
                />
                {layout.terminalVisible && (
                  <div className="splitter horizontal" onPointerDown={startDrag('terminalHeight')} role="separator" aria-orientation="horizontal" />
                )}
              </div>

              {rightMode !== 'none' && (
                <>
                  <div className="splitter vertical right" onPointerDown={startDrag('aiPanelWidth')} role="separator" aria-orientation="vertical" />
                  <div className="right-panel" style={{ width: layout.aiPanelWidth }}>
                    {rightMode === 'ai' ? (
                      <AIPanel
                        aiSettings={settings.ai}
                        activeFile={activeFile}
                        workspaceName={projectName(workspaceRoot)}
                        account={account}
                        mode={aiMode}
                        onModeChange={setAiMode}
                        inlineAIState={inlineAIState}
                        onToggleInlineAI={() => {
                          const next = !settings.inlineAI;
                          update({ inlineAI: next });
                          notify(next ? 'AI inline suggestions on' : 'AI inline suggestions off');
                        }}
                        onAccountChange={setAccount}
                        onRequireSignIn={handleBeginSignIn}
                        onProviderChange={(id) => update({ ai: { ...settings.ai, provider: id } })}
                        streamingRunId={aiStreamingRunId}
                        onStreamingChange={(runId) => {
                          setAiStreamingRunId(runId);
                          if (runId) setAiState('streaming');
                        }}
                        onProposeEdit={handleProposeEdit}
                        onOpenSettings={() => setRightMode('settings')}
                        onOpenHistory={() => setRightMode('history')}
                      />
                    ) : rightMode === 'history' ? (
                      <HistoryPanel workspaceRoot={workspaceRoot} onRestored={handleRestored} />
                    ) : (
                      <SettingsPanel settings={settings} update={update} runtimes={runtimes} />
                    )}
                  </div>
                </>
              )}
            </div>
          </>
        )}

        <StatusBar
          workspaceRoot={workspaceRoot}
          activePath={activePath}
          cursor={cursor}
          tabSize={settings.tabSize}
          aiState={aiState}
          languageOverride={languageOverrides[activePath] || null}
          onLanguageChange={(languageId) => setLanguageOverrides((current) => ({
            ...current,
            [activePath]: languageId,
          }))}
        />
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        files={paletteFiles}
      />

      <PromptDialog
        open={Boolean(promptState)}
        title={promptState?.title || ''}
        initial={promptState?.initial || ''}
        onClose={() => setPromptState(null)}
        onSubmit={(value) => promptState?.onSubmit?.(value)}
      />

      <ConfirmDialog
        open={Boolean(confirmState)}
        title={confirmState?.title || ''}
        message={confirmState?.message || ''}
        confirmLabel={confirmState?.confirmLabel || 'Delete'}
        onClose={() => setConfirmState(null)}
        onSubmit={() => confirmState?.onSubmit?.()}
      />

      <DiffReview review={review} onAccept={handleAcceptReview} onReject={() => setReview(null)} />

      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      <SignInDialog
        open={signInOpen}
        mode={signInMode}
        url={signInUrl}
        error={authError}
        onOpen={handleBeginSignIn}
        onSubmit={handleLocalSignIn}
        onCancel={handleCancelSignIn}
      />

      <ToastStack toasts={toasts} onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))} />
      </div>
    </div>
  );
}
