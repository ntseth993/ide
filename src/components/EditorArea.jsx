/** Editor area: tab strip, breadcrumb, and the Monaco instance. */
import { useEffect, useRef } from 'react';
import { Editor } from '@monaco-editor/react';
import { normalizePath } from '../utils/pathUtils';
import { getLanguage } from '../utils/language';
import { monacoThemeFor } from '../themes';
import { CloseIcon } from './Icons';

export default function EditorArea({
  tabs,
  activePath,
  docs,
  settings,
  revealRequest,
  onSelectTab,
  onCloseTab,
  onChange,
  onCursor,
  onEditorMount,
  language: languageOverride,
  // Non-file tabs (e.g. Settings) that live in the same strip and replace the
  // editor surface with their own content when active.
  specialTabs = [],
  activeSpecial = null,
  specialContent = null,
  onSelectSpecial = () => {},
  onCloseSpecial = () => {},
}) {
  const editorRef = useRef(null);
  const activeDoc = activePath ? docs[activePath] : null;

  // Jump to a requested line (used by search results).
  useEffect(() => {
    if (!revealRequest || !editorRef.current) return;
    const editor = editorRef.current;
    if (revealRequest.path !== activePath) return;
    editor.revealLineInCenter(revealRequest.line);
    editor.setPosition({ lineNumber: revealRequest.line, column: 1 });
    editor.focus();
  }, [revealRequest, activePath]);

  function definitionPath(path) {
    const relative = normalizePath(path);
    const rootName = relative.split('/').slice(0, -1);
    return rootName.join('/');
  }

  return (
    <section className="editor-area" aria-label="Editor">
      <div className="tabstrip" role="tablist">
        {tabs.length === 0 && specialTabs.length === 0 && <div className="tabstrip-empty">No file opened</div>}
        {tabs.map((path) => {
          const doc = docs[path];
          const name = normalizePath(path).split('/').pop();
          return (
            <div
              key={path}
              role="tab"
              aria-selected={path === activePath}
              tabIndex={0}
              className={`tab${path === activePath ? ' active' : ''}`}
              onClick={() => onSelectTab(path)}
              onKeyDown={(event) => event.key === 'Enter' && onSelectTab(path)}
              title={path}
            >
              <span className="tab-name">{name}</span>
              {doc?.dirty && <span className="dirty-dot" aria-label="Unsaved changes" />}
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(path);
                }}
              >
                <CloseIcon size={12} />
              </button>
            </div>
          );
        })}
        {specialTabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={activeSpecial === tab.id}
            tabIndex={0}
            className={`tab special${activeSpecial === tab.id ? ' active' : ''}`}
            onClick={() => onSelectSpecial(tab.id)}
            onKeyDown={(event) => event.key === 'Enter' && onSelectSpecial(tab.id)}
            title={tab.label}
          >
            <span className="tab-name">{tab.label}</span>
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${tab.label}`}
              onClick={(event) => {
                event.stopPropagation();
                onCloseSpecial(tab.id);
              }}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        ))}
      </div>

      {activePath && !activeSpecial && (
        <div className="breadcrumb" aria-label="Breadcrumb">
          <span className="crumb muted">{definitionPath(activePath)}</span>
          <span className="crumb-sep">/</span>
          <span className="crumb current">{normalizePath(activePath).split('/').pop()}</span>
        </div>
      )}

      {activeSpecial ? (
        <div className="editor-settings">{specialContent}</div>
      ) : activeDoc ? (
        <Editor
          height="100%"
          wrapperProps={{ className: 'monaco-host' }}
          theme={monacoThemeFor(settings.theme)}
          language={languageOverride || getLanguage(activePath)}
          value={activeDoc.text}
          onChange={(value) => onChange(activePath, value ?? '')}
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            editor.onDidChangeCursorPosition((event) => {
              onCursor({ line: event.position.lineNumber, column: event.position.column });
            });
            onEditorMount?.(editor, monaco);
          }}
          options={{
            fontSize: settings.fontSize,
            tabSize: settings.tabSize,
            wordWrap: settings.wordWrap ? 'on' : 'off',
            minimap: { enabled: settings.minimap },
            lineNumbers: settings.lineNumbers,
            cursorBlinking: settings.cursorBlinking,
            renderWhitespace: settings.renderWhitespace,
            fontLigatures: Boolean(settings.fontLigatures),
            bracketPairColorization: { enabled: settings.bracketPairColorization !== false },
            autoClosingBrackets: settings.autoClosingBrackets === false ? 'never' : 'always',
            // AI ghost-text suggestions: show them and let Tab commit.
            inlineSuggest: { enabled: true },
            quickSuggestions: { other: true, comments: false, strings: true },
            smoothScrolling: true,
            automaticLayout: true,
            padding: { top: 12, bottom: 24 },
            scrollBeyondLastLine: false,
            renderLineHighlight: 'all',
            fixedOverflowWidgets: true,
          }}
        />
      ) : (
        <div className="editor-placeholder">
          <h2>No file opened</h2>
          <p>
            Open a file from the explorer, or press{' '}
            <kbd>Ctrl</kbd>+<kbd>P</kbd> for the command palette.
          </p>
        </div>
      )}
    </section>
  );
}
