/** Status bar: workspace, cursor position, language selector, AI state. */
import { projectName } from '../utils/pathUtils';
import { getLanguage } from '../utils/language';
import { listLanguageOptions, languageCapability } from '../services/languageSupport';

const AI_STATUS = {
  none: { label: 'AI: no key', tone: 'muted' },
  ready: { label: 'AI: ready', tone: 'ok' },
  checking: { label: 'AI: checking…', tone: 'warn' },
  error: { label: 'AI: error', tone: 'error' },
  streaming: { label: 'AI: working…', tone: 'warn' },
};

const LANGUAGE_OPTIONS = listLanguageOptions();

export default function StatusBar({
  workspaceRoot,
  activePath,
  cursor,
  tabSize,
  aiState,
  languageOverride = null,
  onLanguageChange,
}) {
  const detected = activePath ? getLanguage(activePath) : 'plaintext';
  const language = languageOverride || detected;
  const ai = AI_STATUS[aiState] || AI_STATUS.none;

  return (
    <footer className="status-bar" role="status">
      <div className="status-left">
        <span className="status-item">{projectName(workspaceRoot)}</span>
        {activePath && (
          <span className="status-item muted" title={activePath}>
            {activePath.length > 48 ? `…${activePath.slice(-48)}` : activePath}
          </span>
        )}
      </div>
      <div className="status-right">
        {cursor && (
          <span className="status-item">
            Ln {cursor.line}, Col {cursor.column}
          </span>
        )}
        <span className="status-item">Spaces: {tabSize}</span>
        <span className="status-item">UTF-8</span>
        {activePath && (
          <select
            className="status-item status-select"
            value={language}
            onChange={(event) => onLanguageChange?.(event.target.value)}
            title={languageCapability(language)}
            aria-label="Language mode"
          >
            {LANGUAGE_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
                {option.id === detected ? '' : ' (override)'}
              </option>
            ))}
          </select>
        )}
        {activePath && languageOverride && (
          <button
            type="button"
            className="status-item status-reset"
            title="Reset language to the file-extension default"
            onClick={() => onLanguageChange?.(detected)}
          >
            reset
          </button>
        )}
        <span className={`status-item ai-status tone-${ai.tone}`}>
          <span className="status-dot" />
          {ai.label}
        </span>
      </div>
    </footer>
  );
}
