/** Keyboard shortcuts reference, opened from Help > Keyboard Shortcuts. */
const SHORTCUTS = [
  ['Ctrl+N', 'File: New File'],
  ['Ctrl+Shift+N', 'File: New Folder'],
  ['Ctrl+O', 'File: Open Folder'],
  ['Ctrl+S', 'File: Save'],
  ['Ctrl+Shift+S', 'File: Save As'],
  ['Ctrl+W', 'File: Close Editor'],
  ['Ctrl+F / Ctrl+H', 'Edit: Find / Replace'],
  ['Ctrl+Shift+F', 'Edit: Find in Files'],
  ['Alt+Shift+Right', 'Selection: Expand Selection'],
  ['Ctrl+Shift+E', 'View: Explorer'],
  ['Ctrl+Shift+X', 'View: Extensions'],
  ['Ctrl+`', 'View: Toggle Terminal'],
  ['Ctrl+B', 'View: Toggle Sidebar'],
  ['Ctrl+Shift+A', 'View: AI Assistant'],
  ['Ctrl+,', 'View: Settings'],
  ['Ctrl+P', 'Go to File / Command Palette'],
  ['Ctrl+G', 'Go to Line'],
  ['F12', 'Go to Definition'],
  ['F5', 'Run: Run File'],
  ['Shift+F5', 'Run: Stop'],
  ['Ctrl+Shift+`', 'Terminal: New Terminal'],
];

export default function ShortcutsDialog({ open, onClose }) {
  if (!open) return null;
  return (
    <div className="palette-overlay" onMouseDown={onClose} role="presentation">
      <div
        className="modal-dialog shortcuts-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h3>Keyboard Shortcuts</h3>
        <ul className="shortcuts-list">
          {SHORTCUTS.map(([keys, label]) => (
            <li key={keys}>
              <kbd>{keys}</kbd>
              <span>{label}</span>
            </li>
          ))}
        </ul>
        <p className="muted tiny">
          Undo, Redo, Cut, Copy, Paste, and Select All use standard native behavior.
          Commands marked &quot;coming soon&quot; in the menus are not implemented yet.
        </p>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
