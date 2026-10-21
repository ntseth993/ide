import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { assertPlainName, resolveRename, resolveWithin, PathGuardError } from '../electron/services/pathGuard';

describe('pathGuard.resolveWithin', () => {
  const root = path.resolve('/workspace');

  it('allows paths inside the workspace', () => {
    expect(resolveWithin(root, 'src/app.js')).toBe(path.join(root, 'src', 'app.js'));
    expect(resolveWithin(root, path.join(root, 'a', 'b.txt'))).toBe(path.join(root, 'a', 'b.txt'));
  });

  it('rejects traversal outside the workspace', () => {
    expect(() => resolveWithin(root, '../outside.txt')).toThrow(PathGuardError);
    expect(() => resolveWithin(root, 'src/../../etc/passwd')).toThrow(PathGuardError);
    expect(() => resolveWithin(root, path.resolve('/elsewhere/file'))).toThrow(PathGuardError);
  });

  it('resolves the workspace root itself to the root', () => {
    // Resolving the root is legal (it is the base for create/read-tree);
    // destructive operations on the root are refused by the fsService.
    expect(resolveWithin(root, root)).toBe(root);
  });

  it('rejects empty or missing targets', () => {
    expect(() => resolveWithin(root, '')).toThrow(PathGuardError);
    expect(() => resolveWithin(root, null)).toThrow(PathGuardError);
  });

  it('rejects when no workspace is open', () => {
    expect(() => resolveWithin('', 'file.txt')).toThrow(PathGuardError);
  });
});

describe('pathGuard.assertPlainName', () => {
  it('accepts ordinary file and folder names', () => {
    expect(assertPlainName('app.jsx')).toBe('app.jsx');
    expect(assertPlainName('  src  ')).toBe('src');
    expect(assertPlainName('.gitignore')).toBe('.gitignore');
  });

  it('rejects path separators, traversal, and illegal characters', () => {
    expect(() => assertPlainName('a/b')).toThrow(PathGuardError);
    expect(() => assertPlainName('a\\b')).toThrow(PathGuardError);
    expect(() => assertPlainName('..')).toThrow(PathGuardError);
    expect(() => assertPlainName('col:on')).toThrow(PathGuardError);
    expect(() => assertPlainName('star*')).toThrow(PathGuardError);
    expect(() => assertPlainName('')).toThrow(PathGuardError);
  });

  it('rejects Windows reserved device names', () => {
    expect(() => assertPlainName('con')).toThrow(PathGuardError);
    expect(() => assertPlainName('NUL.txt'.split('.')[0])).toThrow(PathGuardError);
  });
});

describe('pathGuard.resolveRename', () => {
  const root = path.resolve('/workspace');

  it('returns source and destination inside the workspace', () => {
    const { source, destination } = resolveRename(root, 'src/app.js', 'main.js');
    expect(source).toBe(path.join(root, 'src', 'app.js'));
    expect(destination).toBe(path.join(root, 'src', 'main.js'));
  });

  it('rejects a new name that would escape the workspace', () => {
    expect(() => resolveRename(root, 'src/app.js', '..')).toThrow(PathGuardError);
  });
});
