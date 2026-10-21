/** Multi-file workspace search panel. */
import { useState } from 'react';
import { normalizePath } from '../utils/pathUtils';

export default function SearchPanel({ root, onOpenResult }) {
  const [query, setQuery] = useState('');
  const [isRegex, setIsRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function runSearch(event) {
    event.preventDefault();
    if (!query.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const { window } = globalThis;
      const response = await window.novaApi.searchWorkspace(root, { query, isRegex, caseSensitive });
      setResults(response);
    } catch (searchError) {
      setResults(null);
      setError(searchError?.message || 'Search failed.');
    } finally {
      setBusy(false);
    }
  }

  const grouped = new Map();
  (results?.results || []).forEach((hit) => {
    if (!grouped.has(hit.path)) grouped.set(hit.path, []);
    grouped.get(hit.path).push(hit);
  });

  return (
    <section className="side-panel" aria-label="Search">
      <header className="panel-header">
        <h3>Search</h3>
      </header>

      <form className="search-form" onSubmit={runSearch}>
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={root ? 'Search in workspace' : 'Open a folder to search'}
          disabled={!root}
          aria-label="Search query"
        />
        <div className="search-options">
          <label className="check-inline">
            <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
            Aa
          </label>
          <label className="check-inline">
            <input type="checkbox" checked={isRegex} onChange={(e) => setIsRegex(e.target.checked)} />
            .*
          </label>
          <button type="submit" className="primary small" disabled={!root || busy || !query.trim()}>
            {busy ? 'Searching…' : 'Search'}
          </button>
        </div>
      </form>

      {error && <p className="form-error small-pad">{error}</p>}

      <div className="search-results">
        {results && (
          <p className="muted small-pad">
            {results.results.length} match{results.results.length === 1 ? '' : 'es'} in {results.searchedFiles} file
            {results.searchedFiles === 1 ? '' : 's'}
            {results.truncated ? ' (truncated at 200)' : ''}
          </p>
        )}
        {[...grouped.entries()].map(([filePath, hits]) => (
          <div key={filePath} className="search-file-group">
            <div className="search-file-name">{normalizePath(filePath).split('/').pop()}</div>
            {hits.map((hit) => (
              <button
                key={`${hit.path}:${hit.line}`}
                type="button"
                className="search-hit"
                onClick={() => onOpenResult(hit.path, hit.line)}
                title={hit.preview}
              >
                <span className="hit-line">L{hit.line}</span>
                <span className="hit-preview">{hit.preview}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
