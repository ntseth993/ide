/**
 * Change history panel: lists journaled AI edits for the current workspace
 * and restores them. Restores are journal entries themselves, so undoing an
 * undo is just another restore.
 */
import { useCallback, useEffect, useState } from 'react';
import { client, toUserMessage } from '../services/novaClient';
import { baseName } from '../utils/pathUtils';
import { RefreshIcon, HistoryIcon } from './Icons';

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function HistoryPanel({ workspaceRoot, onRestored }) {
  const [entries, setEntries] = useState([]);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceRoot) return;
    try {
      const list = await client.listHistory(workspaceRoot);
      setEntries(list);
      setError('');
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setLoaded(true);
    }
  }, [workspaceRoot]);

  useEffect(() => {
    setLoaded(false);
    load();
  }, [load]);

  const restore = useCallback(async (entry) => {
    setBusyId(entry.id);
    try {
      const result = await client.restoreHistory(workspaceRoot, entry.id);
      onRestored?.(result);
      await load();
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBusyId('');
    }
  }, [workspaceRoot, onRestored, load]);

  return (
    <section className="history-panel" aria-label="Change history">
      <header className="history-header">
        <div className="history-title">
          <HistoryIcon size={16} />
          <h2>Change History</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          title="Refresh history"
          aria-label="Refresh history"
          onClick={load}
        >
          <RefreshIcon size={14} />
        </button>
      </header>

      <p className="muted tiny">
        Every accepted AI edit is journaled before it touches disk. Restore writes the previous
        content back; restores are journaled too, so you can redo just as easily.
      </p>

      {error && (
        <div className="ai-error" role="alert">
          <span>{error}</span>
          <button type="button" className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>
            ×
          </button>
        </div>
      )}

      <div className="history-list">
        {!loaded && <div className="history-empty">Loading…</div>}
        {loaded && entries.length === 0 && (
          <div className="history-empty">
            <p>No journaled changes yet.</p>
            <p className="muted tiny">Accept an AI-proposed edit and it will appear here.</p>
          </div>
        )}
        {entries.map((entry) => (
          <div key={entry.id} className="history-entry">
            <div className="history-entry-main">
              <span className={`history-badge ${entry.kind}`}>{entry.kind === 'restore' ? 'Restore' : 'AI edit'}</span>
              <span className="history-file" title={entry.filePath}>{baseName(entry.filePath)}</span>
              {entry.created && <span className="history-created">new file</span>}
            </div>
            <div className="history-entry-side">
              <time dateTime={entry.ts}>{formatTime(entry.ts)}</time>
              <button
                type="button"
                className="link-button"
                disabled={busyId === entry.id}
                onClick={() => restore(entry)}
              >
                {busyId === entry.id ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
