/** Command palette: fuzzy actions + quick open files, keyboard driven. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyScore, normalizePath } from '../utils/pathUtils';

export default function CommandPalette({ open, onClose, commands, files }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const items = useMemo(() => {
    const commandItems = commands.map((command) => ({
      kind: 'command',
      id: command.id,
      label: command.label,
      hint: command.hint || '',
      score: fuzzyScore(query.replace(/^>/, '').trim(), command.label),
      run: command.run,
    }));
    const isFileMode = query.startsWith('@') || !query.startsWith('>');
    const fileItems = isFileMode
      ? files.map((file) => ({
          kind: 'file',
          id: file.path,
          label: normalizePath(file.path).split('/').pop(),
          hint: normalizePath(file.path),
          score: fuzzyScore(query.replace(/^@/, '').trim(), normalizePath(file.path)),
          run: () => files.find((f) => f.path === file.path)?.open?.(),
        }))
      : [];
    const fileQuery = query.replace(/^@/, '').trim();
    const scored = [...commandItems, ...fileItems]
      .map((item) => ({
        ...item,
        score: item.kind === 'file' && fileQuery ? fuzzyScore(fileQuery, normalizePath(item.id)) : item.score,
      }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
    return scored;
  }, [commands, files, query]);

  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(0, items.length - 1)));
  }, [items.length]);

  if (!open) return null;

  function choose(item) {
    onClose();
    item.run?.();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIndex((current) => Math.min(current + 1, items.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = items[index];
      if (item) choose(item);
    }
  }

  return (
    <div className="palette-overlay" onMouseDown={onClose} role="presentation">
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a command or @ to find files…"
          aria-label="Search commands and files"
          spellCheck="false"
        />
        <ul className="palette-list" ref={listRef}>
          {items.length === 0 && <li className="palette-empty muted">No matches</li>}
          {items.map((item, itemIndex) => (
            <li key={`${item.kind}-${item.id}`}>
              <button
                type="button"
                className={`palette-item${itemIndex === index ? ' active' : ''}`}
                onMouseEnter={() => setIndex(itemIndex)}
                onClick={() => choose(item)}
              >
                <span className="palette-kind">{item.kind === 'command' ? '⌘' : '📄'}</span>
                <span className="palette-label">{item.label}</span>
                {item.hint && <span className="palette-hint muted">{item.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
