/** Diff review overlay: AI-proposed edits are shown against the original. */
import { DiffEditor } from '@monaco-editor/react';
import { getLanguage } from '../utils/language';
import { CheckIcon, CloseIcon } from './Icons';

export default function DiffReview({ review, onAccept, onReject }) {
  if (!review) return null;
  const language = getLanguage(review.path);
  const name = review.path.split(/[\\/]/).pop();

  return (
    <div className="diff-review" role="dialog" aria-modal="true" aria-label="Review proposed changes">
      <header className="diff-header">
        <div>
          <h3>Review proposed changes</h3>
          <span className="muted">{name}</span>
        </div>
        <div className="inline-actions">
          <button type="button" className="primary" onClick={onAccept}>
            <CheckIcon size={14} /> Apply changes
          </button>
          <button type="button" className="secondary" onClick={onReject}>
            <CloseIcon size={14} /> Discard
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
          options={{
            readOnly: true,
            renderSideBySide: true,
            automaticLayout: true,
            fontSize: 13,
            minimap: { enabled: false },
          }}
        />
      </div>
      <p className="diff-note muted">
        Nothing is written until you apply. The original stays untouched on disk.
      </p>
    </div>
  );
}
