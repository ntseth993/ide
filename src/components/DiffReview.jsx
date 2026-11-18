/**
 * Diff review overlay.
 *
 * The AI proposes a whole-file edit; nothing reaches disk until the user
 * accepts. We render Monaco's diff editor for the full, syntax-highlighted
 * visual comparison, then layer per-change control on top of it using our own
 * line diff: move between changes, Accept or Reject the focused one, or resolve
 * them all at once. Accepting one change advances the review's base text, so the
 * remaining changes are recomputed against it and every apply stays patch-safe.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { getLanguage } from '../utils/language';
import {
  computeDiff,
  changesBetween,
  applyChange,
  applyChanges,
} from '../utils/lineDiff';
import { CheckIcon, CloseIcon, ChevronIcon } from './Icons';

/** "3 lines added" / "1 line removed" — singular/plural without lying. */
function countLabel(value, noun) {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

export default function DiffReview({ review, onAccept, onReject }) {
  const editorRef = useRef(null);
  const [veto, setVeto] = useState(() => new Set());
  const [focusSig, setFocusSig] = useState(null);

  // A brand-new proposal (different file or different base snapshot) starts a
  // clean slate: no rejections carried over, focus reset.
  useEffect(() => {
    setVeto(new Set());
    setFocusSig(null);
  }, [review?.path, review?.expectedOriginal]);

  const changes = useMemo(
    () => (review ? changesBetween(review.original, review.modified) : []),
    [review],
  );
  const pending = useMemo(
    () => changes.filter((c) => !veto.has(c.signature)),
    [changes, veto],
  );
  const stats = useMemo(
    () => (review ? computeDiff(review.original, review.modified) : null),
    [review],
  );

  // Keep a valid focused change as the list changes underneath us.
  const focused = useMemo(() => {
    if (!pending.length) return null;
    return pending.find((c) => c.signature === focusSig) || pending[0];
  }, [pending, focusSig]);

  useEffect(() => {
    if (focused && focused.signature !== focusSig) setFocusSig(focused.signature);
  }, [focused, focusSig]);

  // Scroll the focused change into view in both panes of the diff editor.
  useEffect(() => {
    const diffEditor = editorRef.current;
    if (!diffEditor || !focused) return;
    const reveal = (editor, line) => {
      if (!editor || typeof editor.revealLineInCenter !== 'function') return;
      editor.revealLineInCenter(Math.max(1, line + 1));
    };
    reveal(diffEditor.getOriginalEditor?.(), focused.oStart);
    reveal(diffEditor.getModifiedEditor?.(), focused.nStart);
  }, [focused, review]);

  const step = useCallback((dir) => {
    if (!pending.length) return;
    const idx = pending.findIndex((c) => c.signature === (focused && focused.signature));
    const next = pending[(idx + dir + pending.length) % pending.length];
    setFocusSig(next.signature);
  }, [pending, focused]);

  const acceptCurrent = useCallback(() => {
    if (!review || !focused) return;
    const merged = applyChange(review.original, focused);
    const nextVeto = new Set(veto);
    nextVeto.delete(focused.signature);
    setVeto(nextVeto);
    // finalize when the file now matches the proposal in full.
    onAccept(merged, { finalize: merged === review.modified });
  }, [review, focused, veto, onAccept]);

  const rejectCurrent = useCallback(() => {
    if (!focused) return;
    setVeto((current) => new Set(current).add(focused.signature));
  }, [focused]);

  const acceptAll = useCallback(() => {
    if (!review) return;
    const merged = applyChanges(review.original, changes, (c) => !veto.has(c.signature));
    onAccept(merged, { finalize: true });
  }, [review, changes, veto, onAccept]);

  if (!review) return null;
  const language = getLanguage(review.path);
  const name = review.name || review.path.split(/[\\/]/).pop();
  const rejectedCount = veto.size;

  return (
    <div className="diff-review" role="dialog" aria-modal="true" aria-label="Review proposed changes">
      <header className="diff-header">
        <div className="diff-title">
          <h3>Review proposed changes</h3>
          <span className="muted diff-file">{name}</span>
          {stats && stats.changes > 0 && (
            <span className="diff-summary" role="status">
              <em className="add">+{countLabel(stats.added, 'line')} added</em>
              <em className="del">-{countLabel(stats.removed, 'line')} removed</em>
              <em className="chg">{stats.changes} change{stats.changes === 1 ? '' : 's'} proposed</em>
            </span>
          )}
        </div>
        <div className="inline-actions">
          <button type="button" className="primary" onClick={acceptAll} disabled={!pending.length}>
            <CheckIcon size={14} /> Accept All
          </button>
          <button type="button" className="secondary" onClick={onReject}>
            <CloseIcon size={14} /> Reject All
          </button>
        </div>
      </header>

      <div className="diff-body">
        <DiffEditor
          height="100%"
          language={language}
          original={review.original}
          modified={review.modified}
          theme="novacode-dark"
          onMount={(editor) => { editorRef.current = editor; }}
          options={{
            readOnly: true,
            renderSideBySide: true,
            renderOverviewRuler: true,
            diffWordWrap: 'off',
            automaticLayout: true,
            fontSize: 13,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
          }}
        />
      </div>

      <footer className="diff-footer">
        <div className="diff-nav">
          <button
            type="button"
            className="diff-navbtn"
            onClick={() => step(-1)}
            disabled={pending.length < 2}
            aria-label="Previous change"
          >
            <ChevronIcon size={14} open style={{ transform: 'rotate(-90deg)' }} /> Prev
          </button>
          <span className="diff-counter" aria-live="polite">
            {pending.length ? `Change ${(focused ? pending.indexOf(focused) : 0) + 1} of ${pending.length}` : 'All changes resolved'}
            {rejectedCount ? ` · ${rejectedCount} rejected` : ''}
          </span>
          <button
            type="button"
            className="diff-navbtn"
            onClick={() => step(1)}
            disabled={pending.length < 2}
            aria-label="Next change"
          >
            Next <ChevronIcon size={14} open style={{ transform: 'rotate(90deg)' }} />
          </button>
        </div>

        {focused && (
          <div className="diff-change" key={focused.signature}>
            <div className="diff-change-lines" aria-label="Focused change">
              {focused.oLines.map((line, i) => (
                <div className="dl dl-del" key={`o-${i}`}>
                  <span className="dl-no old">{focused.oStart + i + 1}</span>
                  <span className="dl-mark">-</span>
                  <code>{line || ' '}</code>
                </div>
              ))}
              {focused.nLines.map((line, i) => (
                <div className="dl dl-add" key={`n-${i}`}>
                  <span className="dl-no new">{focused.nStart + i + 1}</span>
                  <span className="dl-mark">+</span>
                  <code>{line || ' '}</code>
                </div>
              ))}
            </div>
            <div className="diff-change-actions">
              <button type="button" className="primary" onClick={acceptCurrent}>
                <CheckIcon size={14} /> Accept
              </button>
              <button type="button" className="secondary" onClick={rejectCurrent}>
                <CloseIcon size={14} /> Reject
              </button>
            </div>
          </div>
        )}

        <p className="diff-note muted">
          Nothing is written until you Accept. Rejected changes keep your original code exactly.
        </p>
      </footer>
    </div>
  );
}
