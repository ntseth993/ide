/** Modal prompt + confirm dialogs (replaces window.prompt/confirm). */
import { useEffect, useRef, useState } from 'react';

export function PromptDialog({ open, title, initial = '', confirmLabel = 'OK', danger = false, onClose, onSubmit }) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setValue(initial);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [open, initial]);

  if (!open) return null;

  function submit(event) {
    event?.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    onClose();
  }

  return (
    <div className="palette-overlay" onMouseDown={onClose} role="presentation">
      <form
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <h3>{title}</h3>
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => event.key === 'Escape' && onClose()}
          aria-label={title}
          spellCheck="false"
        />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={danger ? 'danger' : 'primary'} disabled={!value.trim()}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'Delete', onClose, onSubmit }) {
  if (!open) return null;
  return (
    <div className="palette-overlay" onMouseDown={onClose} role="presentation">
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h3>{title}</h3>
        <p className="muted">{message}</p>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={() => { onSubmit(); onClose(); }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
