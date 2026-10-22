/**
 * Top menu bar structure (renderer side).
 *
 * Declarative data mirroring a VS Code-style menu. Every ENABLED item maps to a
 * command id registered in App's `commands` registry, so the menu bar and the
 * command palette never drift apart. Items that have no implementation yet are
 * marked `disabled: true` (shown greyed with their intended shortcut), and
 * grouping entries that would open a nested flyout are marked `submenu: true`.
 * Checkable entries (Auto Save, Word Wrap) reflect live state through the
 * resolved command's `checked` flag.
 *
 * Shape:
 *   menus: [{ label, items: [ item ] }]
 *   item : { type: 'sep' }
 *        | { label, command, hint?, checked? }        // runs a command
 *        | { label, disabled: true, hint? }           // not implemented yet
 *        | { label, submenu: true, hint? }            // nested flyout (not built)
 */
const MENUS = [
  {
    label: 'File',
    items: [
      { label: 'New File', command: 'new-file', hint: 'Ctrl+N' },
      { label: 'New Window', disabled: true, hint: 'Ctrl+Shift+N' },
      { label: 'New Window with Profile', submenu: true },
      { type: 'sep' },
      { label: 'Open File…', disabled: true, hint: 'Ctrl+O' },
      { label: 'Open Folder…', command: 'open-folder', hint: 'Ctrl+K Ctrl+O' },
      { label: 'Open Workspace from File…', disabled: true },
      { label: 'Open Recent', submenu: true },
      { type: 'sep' },
      { label: 'Add Folder to Workspace…', disabled: true },
      { label: 'Save Workspace As…', disabled: true },
      { label: 'Duplicate Workspace', disabled: true },
      { type: 'sep' },
      { label: 'Save', command: 'save', hint: 'Ctrl+S' },
      { label: 'Save As…', command: 'save-as', hint: 'Ctrl+Shift+S' },
      { label: 'Save All', command: 'save-all', hint: 'Ctrl+K S' },
      { type: 'sep' },
      { label: 'Share', submenu: true },
      { label: 'Auto Save', command: 'toggle-autosave' },
      { label: 'Preferences', submenu: true },
      { type: 'sep' },
      { label: 'Revert File', disabled: true },
      { label: 'Close Editor', command: 'close-editor', hint: 'Ctrl+F4' },
      { label: 'Close Folder', command: 'close-folder', hint: 'Ctrl+K F' },
      { label: 'Close Window', disabled: true, hint: 'Alt+F4' },
      { type: 'sep' },
      { label: 'Exit', disabled: true },
    ],
  },
  {
    label: 'Edit',
    items: [
      { label: 'Undo', command: 'editor.undo', hint: 'Ctrl+Z' },
      { label: 'Redo', command: 'editor.redo', hint: 'Ctrl+Y' },
      { type: 'sep' },
      { label: 'Cut', command: 'editor.cut', hint: 'Ctrl+X' },
      { label: 'Copy', command: 'editor.copy', hint: 'Ctrl+C' },
      { label: 'Paste', command: 'editor.paste', hint: 'Ctrl+V' },
      { type: 'sep' },
      { label: 'Find', command: 'editor.find', hint: 'Ctrl+F' },
      { label: 'Replace', command: 'editor.replace', hint: 'Ctrl+H' },
      { type: 'sep' },
      { label: 'Find in Files', command: 'view.search', hint: 'Ctrl+Shift+F' },
      { label: 'Replace in Files', disabled: true, hint: 'Ctrl+Shift+H' },
      { type: 'sep' },
      { label: 'Toggle Line Comment', command: 'editor.toggle-comment', hint: 'Ctrl+/' },
      { label: 'Toggle Block Comment', command: 'editor.block-comment', hint: 'Shift+Alt+A' },
      { label: 'Emmet: Expand Abbreviation', command: 'editor.emmet-expand', hint: 'Tab' },
      { label: 'Format Document', command: 'editor.format-document', hint: 'Shift+Alt+F' },
    ],
  },
  {
    label: 'Selection',
    items: [
      { label: 'Select All', command: 'selection.select-all', hint: 'Ctrl+A' },
      { label: 'Expand Selection', command: 'editor.expand-selection', hint: 'Shift+Alt+→' },
      { label: 'Shrink Selection', command: 'editor.shrink-selection', hint: 'Shift+Alt+←' },
      { type: 'sep' },
      { label: 'Copy Line Up', command: 'editor.copy-line-up', hint: 'Shift+Alt+↑' },
      { label: 'Copy Line Down', command: 'editor.copy-line-down', hint: 'Shift+Alt+↓' },
      { label: 'Move Line Up', command: 'editor.move-line-up', hint: 'Alt+↑' },
      { label: 'Move Line Down', command: 'editor.move-line-down', hint: 'Alt+↓' },
      { label: 'Duplicate Selection', command: 'editor.duplicate-selection' },
      { type: 'sep' },
      { label: 'Add Cursor Above', command: 'editor.cursor-above', hint: 'Ctrl+Alt+↑' },
      { label: 'Add Cursor Below', command: 'editor.cursor-below', hint: 'Ctrl+Alt+↓' },
      { label: 'Add Cursors to Line Ends', command: 'editor.cursors-line-ends', hint: 'Shift+Alt+I' },
      { label: 'Add Next Occurrence', command: 'editor.add-next-occurrence', hint: 'Ctrl+D' },
      { label: 'Add Previous Occurrence', command: 'editor.add-prev-occurrence' },
      { label: 'Select All Occurrences', command: 'editor.select-all-occurrences', hint: 'Ctrl+Shift+L' },
      { type: 'sep' },
      { label: 'Switch to Ctrl+Click for Multi-Cursor', disabled: true },
      { label: 'Column Selection Mode', command: 'editor.column-selection' },
    ],
  },
  {
    label: 'View',
    items: [
      { label: 'Command Palette…', command: 'open-palette', hint: 'Ctrl+Shift+P' },
      { label: 'Open View…', disabled: true },
      { type: 'sep' },
      { label: 'Appearance', submenu: true },
      { label: 'Editor Layout', submenu: true },
      { type: 'sep' },
      { label: 'Explorer', command: 'view.explorer', hint: 'Ctrl+Shift+E' },
      { label: 'Search', command: 'view.search', hint: 'Ctrl+Shift+F' },
      { label: 'Source Control', disabled: true, hint: 'Ctrl+Shift+G' },
      { label: 'Run', disabled: true, hint: 'Ctrl+Shift+D' },
      { label: 'Extensions', command: 'view.extensions', hint: 'Ctrl+Shift+X' },
      { type: 'sep' },
      { label: 'Problems', command: 'view.problems', hint: 'Ctrl+Shift+M' },
      { label: 'Output', command: 'view.output', hint: 'Ctrl+Shift+U' },
      { label: 'Debug Console', command: 'view.debug', hint: 'Ctrl+Shift+Y' },
      { label: 'Terminal', command: 'view.terminal', hint: 'Ctrl+`' },
      { label: 'AI Assistant', command: 'view.ai', hint: 'Ctrl+Shift+A' },
      { label: 'Change History', command: 'view.history' },
      { type: 'sep' },
      { label: 'Toggle Sidebar', command: 'toggle-sidebar', hint: 'Ctrl+B' },
      { label: 'Word Wrap', command: 'toggle-word-wrap', hint: 'Alt+Z' },
      { label: 'Switch Theme', command: 'cycle-theme' },
      { label: 'Settings', command: 'view.settings', hint: 'Ctrl+,' },
    ],
  },
  {
    label: 'Go',
    items: [
      { label: 'Back', disabled: true, hint: 'Alt+←' },
      { label: 'Forward', disabled: true, hint: 'Alt+→' },
      { label: 'Last Edit Location', disabled: true, hint: 'Ctrl+K Ctrl+Q' },
      { type: 'sep' },
      { label: 'Switch Editor', submenu: true },
      { label: 'Switch Group', submenu: true },
      { type: 'sep' },
      { label: 'Go to File…', command: 'open-palette', hint: 'Ctrl+P' },
      { label: 'Go to Symbol in Workspace…', disabled: true, hint: 'Ctrl+T' },
      { type: 'sep' },
      { label: 'Go to Symbol in Editor…', command: 'editor.goto-symbol', hint: 'Ctrl+Shift+O' },
      { label: 'Go to Definition', command: 'editor.goto-definition', hint: 'F12' },
      { label: 'Go to Declaration', command: 'editor.goto-declaration' },
      { label: 'Go to Type Definition', command: 'editor.goto-type-definition' },
      { label: 'Go to Implementations', command: 'editor.goto-implementations', hint: 'Ctrl+F12' },
      { label: 'Go to References', command: 'editor.goto-references', hint: 'Shift+F12' },
      { type: 'sep' },
      { label: 'Go to Line/Column…', command: 'editor.goto-line', hint: 'Ctrl+G' },
      { label: 'Go to Bracket', command: 'editor.goto-bracket', hint: 'Ctrl+Shift+\\' },
      { type: 'sep' },
      { label: 'Next Problem', disabled: true, hint: 'F8' },
      { label: 'Previous Problem', disabled: true, hint: 'Shift+F8' },
      { type: 'sep' },
      { label: 'Next Change', disabled: true, hint: 'Alt+F3' },
      { label: 'Previous Change', disabled: true, hint: 'Shift+Alt+F3' },
    ],
  },
  {
    label: 'Run',
    items: [
      { label: 'Start Debugging', disabled: true, hint: 'F5' },
      { label: 'Run Without Debugging', command: 'run.file', hint: 'Ctrl+F5' },
      { label: 'Stop Debugging', command: 'run.stop', hint: 'Shift+F5' },
      { label: 'Restart Debugging', disabled: true, hint: 'Ctrl+Shift+F5' },
      { type: 'sep' },
      { label: 'Open Configurations', disabled: true },
      { label: 'Add Configuration…', disabled: true },
      { type: 'sep' },
      { label: 'Step Over', disabled: true, hint: 'F10' },
      { label: 'Step Into', disabled: true, hint: 'F11' },
      { label: 'Step Out', disabled: true, hint: 'Shift+F11' },
      { label: 'Continue', disabled: true, hint: 'F5' },
      { type: 'sep' },
      { label: 'Toggle Breakpoint', disabled: true, hint: 'F9' },
      { label: 'New Breakpoint', submenu: true },
      { type: 'sep' },
      { label: 'Enable All Breakpoints', disabled: true },
      { label: 'Disable All Breakpoints', disabled: true },
      { label: 'Remove All Breakpoints', disabled: true },
      { type: 'sep' },
      { label: 'Install Additional Debuggers…', disabled: true },
    ],
  },
  {
    label: 'Terminal',
    items: [
      { label: 'New Terminal', command: 'terminal.new', hint: 'Ctrl+Shift+`' },
      { label: 'Split Terminal', disabled: true, hint: 'Ctrl+\\' },
      { type: 'sep' },
      { label: 'Run Active File', command: 'run.file', hint: 'F5' },
      { label: 'Stop', command: 'run.stop', hint: 'Shift+F5' },
      { type: 'sep' },
      { label: 'Clear Terminal', command: 'terminal.clear' },
      { label: 'Kill Terminal', disabled: true },
    ],
  },
  {
    label: 'Help',
    items: [
      { label: 'Welcome', disabled: true },
      { label: 'Show All Commands', command: 'open-palette', hint: 'Ctrl+Shift+P' },
      { label: 'Keyboard Shortcuts', command: 'help.shortcuts', hint: 'Ctrl+Shift+/' },
      { label: 'Editor Playground', disabled: true },
      { type: 'sep' },
      { label: 'Sign In…', command: 'account.sign-in' },
      { label: 'Sign Out', command: 'account.sign-out' },
      { type: 'sep' },
      { label: 'NovaCode Docs', disabled: true },
      { label: 'Show Release Notes', disabled: true },
      { type: 'sep' },
      { label: 'View License', disabled: true },
      { label: 'Privacy Policy', disabled: true },
      { type: 'sep' },
      { label: 'Toggle Developer Tools', disabled: true },
      { label: 'Check for Updates…', disabled: true },
      { type: 'sep' },
      { label: 'About', disabled: true },
    ],
  },
];

/** Command ids referenced by enabled items (used by tests). */
const MENU_BAR_COMMANDS = MENUS
  .flatMap((menu) => menu.items)
  .filter((item) => item.command)
  .map((item) => item.command);

export { MENUS, MENU_BAR_COMMANDS };
export default MENUS;
