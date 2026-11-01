/**
 * Code snippet message renderer.
 *
 * Chat messages that carry `kind: 'code'` render as a read-only Monaco block
 * with a language chip, a copy button, and an optional "Open in editor"
 * affordance. This is what makes NovaLink belong in an IDE instead of being a
 * generic messenger with a code bolt-on.
 *
 * We deliberately do NOT auto-write the snippet to the workspace filesystem —
 * the user picks where it lands by routing through the existing open-file
 * pipeline.
 */
import { useCallback, useState } from 'react';
import Editor from '@monaco-editor/react';
import * as bus from '../../services/bus';

const MAX_INLINE_LINES = 40;

export default function CodeSnippet({ code, language, path, sender, copyLabel = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  const lineCount = (code || '').split(/\r?\n/).length;
  const collapsed = lineCount > MAX_INLINE_LINES;

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can throw if the document isn't focused; nothing to fall
      // back to that's better than the button silently not doing anything.
    }
  }, [code]);

  function openInEditor() {
    bus.emit('novalink:openInEditor', {
      name: path || `${(sender || 'peer').replace(/[^a-z0-9._-]+/gi, '_')}-snippet.${(language || 'txt')}`,
      language: language || 'plaintext',
      content: code || '',
    });
  }

  return (
    <div className={`novalink-code-block ${collapsed ? 'collapsed' : ''}`}>
      <header className="novalink-code-head">
        <span className="novalink-code-lang">{language || 'text'}</span>
        {path ? <span className="novalink-code-path" title={path}>{path}</span> : null}
        <span className="spacer" />
        <button type="button" className="ghost tiny" onClick={onCopy}>{copied ? 'Copied' : copyLabel}</button>
        <button type="button" className="ghost tiny" onClick={openInEditor}>Open in editor</button>
      </header>
      <div className={`novalink-code-body ${collapsed ? 'clip' : ''}`}>
        <Editor
          value={code || ''}
          language={language || 'plaintext'}
          theme="vs-dark"
          height={collapsed ? '240px' : `${Math.min(640, Math.max(60, lineCount * 22 + 12))}px`}
          options={{
            readOnly: true,
            domReadOnly: true,
            minimap: { enabled: false },
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            renderLineHighlight: 'none',
            overviewRulerLanes: 0,
            fontSize: 12,
            fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
            contextmenu: false,
            folding: false,
            automaticLayout: false,
            wordWrap: 'off',
            scrollbar: { vertical: 'hidden', horizontal: 'auto' },
          }}
        />
      </div>
    </div>
  );
}
