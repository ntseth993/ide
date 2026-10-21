/**
 * Tests for the `nova` CLI argument parser (electron/services/launchArgs).
 * The launcher shims forward argv verbatim to the Electron binary; these
 * tests pin the launch intents the main process must understand.
 */
import { describe, expect, it } from 'vitest';
import { parseLaunchArgs, usageText } from '../electron/services/launchArgs';

describe('parseLaunchArgs', () => {
  it('returns none for an empty launch (plain `nova`)', () => {
    expect(parseLaunchArgs([])).toEqual({ kind: 'none' });
  });

  it('recognizes --version and -v', () => {
    expect(parseLaunchArgs(['--version'], { version: '0.2.0' })).toEqual({
      kind: 'version',
      text: 'nova 0.2.0',
    });
    expect(parseLaunchArgs(['-v'], { version: '0.2.0' }).kind).toBe('version');
    expect(parseLaunchArgs(['-V'], { version: '0.2.0' }).kind).toBe('version');
  });

  it('recognizes --help, -h, and Windows-style /?', () => {
    for (const flag of ['--help', '-h', '-?', '/?']) {
      const parsed = parseLaunchArgs([flag]);
      expect(parsed.kind).toBe('help');
      expect(parsed.text).toContain('Usage:');
      expect(parsed.text).toContain('nova .');
    }
  });

  it('opens the current directory marker `.` as-is', () => {
    // `.` is resolved against the inherited working directory by main.
    expect(parseLaunchArgs(['.'])).toEqual({ kind: 'open', target: '.' });
  });

  it('passes folder and file targets through unchanged', () => {
    expect(parseLaunchArgs(['C:\\projects\\site'])).toEqual({
      kind: 'open',
      target: 'C:\\projects\\site',
    });
    expect(parseLaunchArgs(['src/index.js'])).toEqual({
      kind: 'open',
      target: 'src/index.js',
    });
  });

  it('rejects extra positional arguments loudly', () => {
    const parsed = parseLaunchArgs(['C:\\a', 'extra.js']);
    expect(parsed.kind).toBe('error');
    expect(parsed.text).toContain('extra argument');
  });

  it('rejects unknown options with a hint', () => {
    const parsed = parseLaunchArgs(['--wat']);
    expect(parsed.kind).toBe('error');
    expect(parsed.text).toContain('--wat');
    expect(parsed.text).toContain('--help');
  });

  it('honors flags that appear after the positional', () => {
    // Version/help flags win wherever they appear.
    expect(parseLaunchArgs(['C:\\a', '--help']).kind).toBe('help');
    expect(parseLaunchArgs(['C:\\a', '-v'], { version: '9.9.9' }).text).toBe('nova 9.9.9');
  });

  it('treats non-array input as no arguments', () => {
    expect(parseLaunchArgs(undefined).kind).toBe('none');
  });

  it('usage text documents every required behavior', () => {
    const text = usageText();
    expect(text).toContain('nova .');
    expect(text).toContain('nova <folder>');
    expect(text).toContain('nova <file>');
    expect(text).toContain('--help');
    expect(text).toContain('--version');
  });
});
