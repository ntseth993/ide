import { describe, expect, it } from 'vitest';
import {
  SNIPPET_ALIASES,
  getBuiltinSnippets,
  isCustomSnippet,
  listSnippetShortcutEntries,
  mergeSnippetsByLanguage,
} from '../src/services/builtinSnippets';

describe('built-in code shortcuts', () => {
  it('defines snippets as prefix + tab-stop body', () => {
    const javascript = getBuiltinSnippets('javascript');
    const fn = javascript.find((snippet) => snippet.prefix === 'fn');
    expect(fn).toBeTruthy();
    expect(fn.body).toContain('$1');
    expect(javascript.length).toBeGreaterThan(5);
  });

  it('covers the languages people actually type in', () => {
    for (const language of ['javascript', 'typescript', 'python', 'html', 'css', 'json', 'markdown', 'shell', 'go', 'sql']) {
      expect(getBuiltinSnippets(language).length, language).toBeGreaterThan(0);
    }
  });

  it('follows dialect aliases instead of duplicating entries', () => {
    expect(Object.keys(SNIPPET_ALIASES).length).toBeGreaterThan(0);
    expect(getBuiltinSnippets('typescriptreact')).toEqual(getBuiltinSnippets('typescript'));
    expect(getBuiltinSnippets('py')).toEqual(getBuiltinSnippets('python'));
    expect(getBuiltinSnippets('klingon')).toEqual([]);
  });

  it('lists every shortcut for the Settings reference', () => {
    const entries = listSnippetShortcutEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries.slice(0, 20)) {
      expect(entry.prefix).toBeTruthy();
      expect(entry.language).toBeTruthy();
    }
  });

  it('refuses malformed snippet shapes', () => {
    expect(isCustomSnippet(null)).toBe(false);
    expect(isCustomSnippet({ prefix: 'fn' })).toBe(false);
    expect(isCustomSnippet({ prefix: 'fn', body: 'x' })).toBe(true);
  });
});

describe('mergeSnippetsByLanguage', () => {
  it('keeps built-ins tagged as NovaCode shortcuts', () => {
    const merged = mergeSnippetsByLanguage([]);
    const javascript = merged.get('javascript');
    expect(javascript.length).toBeGreaterThan(0);
    expect(javascript.every((snippet) => snippet.source === 'NovaCode')).toBe(true);
  });

  it('adds extension contributions next to the built-ins', () => {
    const merged = mergeSnippetsByLanguage([
      { javascript: [{ prefix: 'log', body: 'console.log($1)', description: 'from extension' }] },
    ]);
    const logs = merged.get('javascript').filter((snippet) => snippet.prefix === 'log');
    expect(logs.map((snippet) => snippet.source).sort()).toEqual(['NovaCode', 'extension']);
  });

  it('copies shortcuts onto aliased dialect ids', () => {
    const merged = mergeSnippetsByLanguage([]);
    expect(merged.has('javascriptreact')).toBe(true);
    const prefixes = merged.get('javascriptreact').map((snippet) => snippet.prefix);
    expect(prefixes).toEqual(expect.arrayContaining(merged.get('javascript').map((snippet) => snippet.prefix)));
  });

  it('drops junk and collapses exact repeats', () => {
    const merged = mergeSnippetsByLanguage([
      { javascript: [{ prefix: 'zz', body: '' }, { body: 'no prefix' }, null, 'not-an-object'] },
      { '': [{ prefix: 'x', body: 'y' }] },
      { python: [{ prefix: 'fn', body: 'def():' }, { prefix: 'fn', body: 'def():' }] },
    ]);
    expect(merged.get('javascript').find((snippet) => snippet.prefix === 'zz')).toBeUndefined();
    expect(merged.has('')).toBe(false);
    expect(merged.get('python').filter((snippet) => snippet.prefix === 'fn')).toHaveLength(1);
  });
});
