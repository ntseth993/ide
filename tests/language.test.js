// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { getLanguage, getFileExtension, getTypeBadge } from '../src/utils/language';
import { fuzzyScore, joinPath, baseName, parentPath } from '../src/utils/pathUtils';
import { extractFirstCodeBlock } from '../src/components/AIPanel';

describe('language detection', () => {
  it('maps extensions to Monaco languages', () => {
    expect(getLanguage('main.js')).toBe('javascript');
    expect(getLanguage('script.py')).toBe('python');
    expect(getLanguage('page.html')).toBe('html');
    expect(getLanguage('styles.scss')).toBe('scss');
    expect(getLanguage('Dockerfile')).toBe('dockerfile');
    expect(getLanguage('data.unknown')).toBe('plaintext');
  });

  it('handles full paths and edge cases', () => {
    expect(getFileExtension('C:\\repo\\src\\app.tsx')).toBe('tsx');
    expect(getFileExtension('noext')).toBe('');
    expect(getFileExtension('')).toBe('');
  });

  it('provides type badges', () => {
    expect(getTypeBadge('a.js').tone).toBe('js');
    expect(getTypeBadge('b.txt').label).toBe('•');
  });
});

describe('path utils', () => {
  it('joins and splits with both separators', () => {
    expect(joinPath('C:\\repo', 'src\\app.js')).toBe('C:/repo/src/app.js');
    expect(baseName('C:/repo/src/app.js')).toBe('app.js');
    expect(parentPath('C:/repo/src/app.js')).toBe('C:/repo/src');
  });

  it('scores fuzzy matches', () => {
    expect(fuzzyScore('app', 'src/app.js')).toBeGreaterThan(0);
    expect(fuzzyScore('zzz', 'src/app.js')).toBe(-1);
    expect(fuzzyScore('', 'anything')).toBe(1);
  });
});

describe('extractFirstCodeBlock', () => {
  it('extracts the first fenced block with its language', () => {
    const text = 'Sure!\n```js\nconst a = 1;\n```\nAnd another\n```py\nprint(1)\n```';
    expect(extractFirstCodeBlock(text)).toEqual({ language: 'js', code: 'const a = 1;\n' });
  });

  it('returns null when there is no code block', () => {
    expect(extractFirstCodeBlock('no code here')).toBeNull();
    expect(extractFirstCodeBlock('')).toBeNull();
  });
});
