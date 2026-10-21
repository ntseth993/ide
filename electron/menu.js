/**
 * Application menu template.
 *
 * Pure data: every item either uses a native role (Edit operations, which
 * Chromium applies to the focused element) or dispatches a command id to
 * the renderer via `send(id)`. The renderer's command registry executes
 * the command against current app state; ids shared with the command
 * palette keep the menu and palette in sync.
 *
 * Items that have no implementation yet are listed with enabled:false so
 * the menu never contains dead-looking entries that silently do nothing.
 */

const EDITOR_ACTIONS = {
  find: { label: 'Find', command: 'editor.find', accelerator: 'CmdOrCtrl+F' },
  replace: { label: 'Replace', command: 'editor.replace', accelerator: 'CmdOrCtrl+H' },
  'expand-selection': { label: 'Expand Selection', command: 'editor.expand-selection', accelerator: 'Alt+Shift+Right' },
  'cursor-below': { label: 'Add Cursor Below', command: 'editor.cursor-below', accelerator: 'Ctrl+Alt+Down' },
  'cursor-above': { label: 'Add Cursor Above', command: 'editor.cursor-above', accelerator: 'Ctrl+Alt+Up' },
  'goto-line': { label: 'Go to Line…', command: 'editor.goto-line', accelerator: 'CmdOrCtrl+G' },
  'goto-definition': { label: 'Go to Definition', command: 'editor.goto-definition', accelerator: 'F12' },
};

function editorItem(key) {
  const action = EDITOR_ACTIONS[key];
  return {
    label: action.label,
    accelerator: action.accelerator,
    click: () => sendGuard(action.command),
  };
}

// Module-level bind to avoid threading `send` through every helper.
let sendGuard = () => {};

/**
 * Build the application menu template.
 *
 * @param {object} hooks
 * @param {(commandId: string) => void} hooks.send dispatch a command id to the renderer
 * @param {() => void} hooks.showAbout native About dialog
 * @param {() => void} hooks.showDocs native Documentation dialog
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function buildMenuTemplate({ send, showAbout, showDocs }) {
  sendGuard = send;

  return [
    {
      label: '&File',
      submenu: [
        { label: 'New File', accelerator: 'CmdOrCtrl+N', click: () => send('new-file') },
        { label: 'New Folder…', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('new-folder') },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => send('open-folder') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-as') },
        { label: 'Save All', click: () => send('save-all') },
        { type: 'separator' },
        { label: 'Close Editor', accelerator: 'CmdOrCtrl+W', click: () => send('close-editor') },
        { type: 'separator' },
        { label: 'Exit', accelerator: 'Alt+F4', role: 'quit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        editorItem('find'),
        editorItem('replace'),
        { label: 'Find in Files', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('view.search') },
      ],
    },
    {
      label: '&Selection',
      submenu: [
        { role: 'selectAll', label: 'Select All' },
        editorItem('expand-selection'),
        { type: 'separator' },
        editorItem('cursor-below'),
        editorItem('cursor-above'),
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Explorer', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('view.explorer') },
        { label: 'Search', click: () => send('view.search') },
        { label: 'Extensions', accelerator: 'CmdOrCtrl+Shift+X', click: () => send('view.extensions') },
        { label: 'Source Control (coming soon)', enabled: false },
        { label: 'Run and Debug (coming soon)', enabled: false },
        { type: 'separator' },
        { label: 'Terminal', accelerator: 'CmdOrCtrl+`', click: () => send('view.terminal') },
        { label: 'AI Assistant', accelerator: 'CmdOrCtrl+Shift+A', click: () => send('view.ai') },
        { label: 'Change History', click: () => send('view.history') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send('view.settings') },
        { label: 'Command Palette', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('open-palette') },
      ],
    },
    {
      label: '&Go',
      submenu: [
        { label: 'Go to File…', accelerator: 'CmdOrCtrl+P', click: () => send('open-palette') },
        editorItem('goto-line'),
        editorItem('goto-definition'),
        { type: 'separator' },
        { label: 'Back (coming soon)', enabled: false },
        { label: 'Forward (coming soon)', enabled: false },
      ],
    },
    {
      label: '&Run',
      submenu: [
        { label: 'Run File', accelerator: 'F5', click: () => send('run.file') },
        { label: 'Start Debugging (coming soon)', enabled: false },
        { label: 'Stop', accelerator: 'Shift+F5', click: () => send('run.stop') },
      ],
    },
    {
      label: '&Terminal',
      submenu: [
        { label: 'New Terminal', accelerator: 'CmdOrCtrl+Shift+`', click: () => send('terminal.new') },
        { label: 'Split Terminal (coming soon)', enabled: false },
        { label: 'Clear Terminal', click: () => send('terminal.clear') },
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Documentation', click: () => showDocs?.() },
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+Shift+/', click: () => send('help.shortcuts') },
        { type: 'separator' },
        { label: 'About NovaCode', click: () => showAbout?.() },
      ],
    },
  ];
}

/** Command ids the menu can dispatch (used by tests and the renderer). */
const MENU_COMMANDS = [
  'new-file', 'new-folder', 'open-folder', 'save', 'save-as', 'save-all', 'close-editor',
  'editor.find', 'editor.replace', 'editor.expand-selection', 'editor.cursor-below', 'editor.cursor-above',
  'view.explorer', 'view.search', 'view.extensions', 'view.terminal', 'view.ai', 'view.history', 'view.settings',
  'open-palette', 'editor.goto-line', 'editor.goto-definition',
  'run.file', 'run.stop', 'terminal.new', 'terminal.clear', 'help.shortcuts',
];

module.exports = { buildMenuTemplate, MENU_COMMANDS, EDITOR_ACTIONS };
