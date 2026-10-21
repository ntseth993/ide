/**
 * Bundles Monaco locally so the editor works fully offline.
 *
 * @monaco-editor/react defaults to loading Monaco from a CDN; configuring
 * the loader with the npm package removes that network dependency (spec §7)
 * and defines one editor theme per NovaCode theme entry.
 */
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { THEMES } from './themes';

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

/** '#rrggbb' + alpha -> '#rrggbbaa' (the shape Monaco color keys expect). */
function withAlpha(hex, alpha) {
  const clean = String(hex || '').replace('#', '');
  const suffix = Math.round(Math.min(1, Math.max(0, alpha)) * 255).toString(16).padStart(2, '0');
  return clean.length === 6 ? `#${clean}${suffix}` : `#000000${suffix}`;
}

// Token colors per kind rather than per theme: the same syntax hues stay
// legible on every palette in the registry.
const DARK_RULES = [
  { token: 'comment', foreground: '64748b', fontStyle: 'italic' },
  { token: 'keyword', foreground: 'c4b5fd' },
  { token: 'keyword.json', foreground: '93c5fd' },
  { token: 'string', foreground: '86efac' },
  { token: 'number', foreground: 'fbbf24' },
  { token: 'type', foreground: '7dd3fc' },
  { token: 'type.identifier', foreground: '7dd3fc' },
  { token: 'tag', foreground: '93c5fd' },
  { token: 'attribute.name', foreground: 'a5b4fc' },
  { token: 'attribute.value', foreground: '86efac' },
  { token: 'delimiter', foreground: '8fa0b8' },
  { token: 'operator', foreground: 'c4b5fd' },
];

const LIGHT_RULES = [
  { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
  { token: 'keyword', foreground: '7c3aed' },
  { token: 'keyword.json', foreground: '1d4ed8' },
  { token: 'string', foreground: '15803d' },
  { token: 'number', foreground: 'b45309' },
  { token: 'type', foreground: '0369a1' },
  { token: 'type.identifier', foreground: '0369a1' },
  { token: 'tag', foreground: '1d4ed8' },
  { token: 'attribute.name', foreground: '7c3aed' },
  { token: 'attribute.value', foreground: '15803d' },
  { token: 'delimiter', foreground: '4b5563' },
  { token: 'operator', foreground: '7c3aed' },
];

/** Derive a complete Monaco theme from one NovaCode theme entry. */
export function buildMonacoColors(theme) {
  const { bg, panel, surface2, surface3, text, muted } = theme.palette;
  const highContrast = theme.id === 'high-contrast';
  return {
    'editor.background': bg,
    'editor.foreground': text,
    'editorGutter.background': bg,
    'editor.lineHighlightBackground': highContrast ? '#1a1a1a' : surface2,
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': muted,
    'editorLineNumber.activeForeground': text,
    'editorCursor.foreground': theme.accent,
    'editor.selectionBackground': withAlpha(theme.accent, highContrast ? 0.55 : 0.28),
    'editor.inactiveSelectionBackground': withAlpha(theme.accent, 0.14),
    'editor.selectionHighlightBackground': withAlpha(theme.accent, 0.12),
    'editorIndentGuide.background1': surface2,
    'editorIndentGuide.activeBackground1': surface3,
    'editorBracketMatch.background': withAlpha(theme.accent, 0.22),
    'editorBracketMatch.border': withAlpha(theme.accent, 0.5),
    'editorWidget.background': panel,
    'editorWidget.border': surface3,
    'editorSuggestWidget.background': panel,
    'editorSuggestWidget.border': surface3,
    'editorSuggestWidget.selectedBackground': surface3,
    'editorSuggestWidget.highlightForeground': theme.accent,
    'editorHoverWidget.background': panel,
    'editorHoverWidget.border': surface3,
    // Ghost text rendered by the AI inline-completion provider (Tab accepts).
    'editorGhostText.foreground': withAlpha(muted, 0.8),
    'editorInfo.foreground': theme.accent2,
    'editorError.foreground': highContrast ? '#ff5555' : '#f87171',
    'editorWarning.foreground': '#fbbf24',
    'editorOverviewRuler.border': '#00000000',
    'minimap.background': bg,
    'scrollbarSlider.background': withAlpha(muted, 0.2),
    'scrollbarSlider.hoverBackground': withAlpha(muted, 0.34),
    'scrollbarSlider.activeBackground': withAlpha(muted, 0.5),
  };
}

// One Monaco theme per registry entry, so switching theme re-skins the code
// canvas too — not just the surrounding chrome.
for (const theme of THEMES) {
  monaco.editor.defineTheme(`nova-${theme.id}`, {
    base: theme.editorBase || (theme.kind === 'light' ? 'vs' : 'vs-dark'),
    inherit: true,
    rules: theme.kind === 'light' ? LIGHT_RULES : DARK_RULES,
    colors: buildMonacoColors(theme),
  });
}

loader.config({ monaco });
