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
// legible on every palette in the registry. The set below covers both the
// Monarch base tokens (keyword/string/number/comment) AND the semantic token
// scopes the TS/JS worker emits (function/class/variable/parameter/property/
// enum/namespace) — mapping those is what makes identifiers, functions and
// types each carry their own color, the way a full IDE highlights.
const DARK_RULES = [
  { token: 'comment', foreground: '64748b', fontStyle: 'italic' },
  { token: 'keyword', foreground: 'c4b5fd' },
  { token: 'keyword.control', foreground: 'e9d5ff', fontStyle: 'bold' },
  { token: 'keyword.json', foreground: '7dd3fc' },
  { token: 'storage.type', foreground: 'c4b5fd' },
  { token: 'string', foreground: '86efac' },
  { token: 'string.key.json', foreground: '67e8f9' },
  { token: 'string.value.json', foreground: '86efac' },
  { token: 'number', foreground: 'fcd34d' },
  { token: 'constant', foreground: 'fdba74' },
  { token: 'constant.language', foreground: 'fdba74' },
  { token: 'regexp', foreground: '5eead4' },
  { token: 'type', foreground: '7dd3fc' },
  { token: 'type.identifier', foreground: '7dd3fc' },
  { token: 'type.parameter', foreground: '5eead4' },
  { token: 'class', foreground: '7dd3fc' },
  { token: 'interface', foreground: '7dd3fc' },
  { token: 'enum', foreground: 'fcd34d' },
  { token: 'enumMember', foreground: 'fdba74' },
  { token: 'namespace', foreground: '7dd3fc' },
  { token: 'function', foreground: '93c5fd' },
  { token: 'method', foreground: '93c5fd' },
  { token: 'variable', foreground: 'e6ebf4' },
  { token: 'parameter', foreground: 'a5b4fc' },
  { token: 'property', foreground: '67e8f9' },
  { token: 'decorator', foreground: 'fbbf24' },
  { token: 'tag', foreground: '93c5fd' },
  { token: 'attribute.name', foreground: 'a5b4fc' },
  { token: 'attribute.value', foreground: '86efac' },
  { token: 'delimiter', foreground: '8fa0b8' },
  { token: 'operator', foreground: 'c4b5fd' },
  { token: 'invalid', foreground: 'f87171' },
];

const LIGHT_RULES = [
  { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
  { token: 'keyword', foreground: '7c3aed' },
  { token: 'keyword.control', foreground: '6d28d9', fontStyle: 'bold' },
  { token: 'keyword.json', foreground: '0369a1' },
  { token: 'storage.type', foreground: '7c3aed' },
  { token: 'string', foreground: '15803d' },
  { token: 'string.key.json', foreground: '0e7490' },
  { token: 'string.value.json', foreground: '15803d' },
  { token: 'number', foreground: 'b45309' },
  { token: 'constant', foreground: 'c2410c' },
  { token: 'constant.language', foreground: 'c2410c' },
  { token: 'regexp', foreground: '0f766e' },
  { token: 'type', foreground: '0369a1' },
  { token: 'type.identifier', foreground: '0369a1' },
  { token: 'type.parameter', foreground: '0f766e' },
  { token: 'class', foreground: '0369a1' },
  { token: 'interface', foreground: '0369a1' },
  { token: 'enum', foreground: 'b45309' },
  { token: 'enumMember', foreground: 'c2410c' },
  { token: 'namespace', foreground: '0369a1' },
  { token: 'function', foreground: '1d4ed8' },
  { token: 'method', foreground: '1d4ed8' },
  { token: 'variable', foreground: '1f2937' },
  { token: 'parameter', foreground: '6d28d9' },
  { token: 'property', foreground: '0e7490' },
  { token: 'decorator', foreground: 'b45309' },
  { token: 'tag', foreground: '1d4ed8' },
  { token: 'attribute.name', foreground: '6d28d9' },
  { token: 'attribute.value', foreground: '15803d' },
  { token: 'delimiter', foreground: '4b5563' },
  { token: 'operator', foreground: '7c3aed' },
  { token: 'invalid', foreground: 'b91c1c' },
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
