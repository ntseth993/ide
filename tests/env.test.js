/**
 * .env loader tests — parsing and non-clobbering of process.env.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnv, parse } from '../electron/services/env';

let tmpDir;
afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe('env.parse', () => {
  it('parses key=value lines, ignores blanks/comments, strips quotes', () => {
    const result = parse([
      '# a comment',
      '',
      'FOO=bar',
      'QUOTED="hello world"',
      "SINGLE='keep'",
      'WITH_EQUALS=a=b',
    ].join('\n'));
    expect(result).toEqual({
      FOO: 'bar',
      QUOTED: 'hello world',
      SINGLE: 'keep',
      WITH_EQUALS: 'a=b',
    });
  });
});

describe('env.loadEnv', () => {
  it('loads values without clobbering existing environment', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-env-'));
    const file = path.join(tmpDir, '.env');
    fs.writeFileSync(file, 'NOVACODE_TEST_ID=from-file\nNOVACODE_TEST_SET=from-file\n', 'utf8');
    process.env.NOVACODE_TEST_SET = 'already-set';
    try {
      loadEnv(file);
      expect(process.env.NOVACODE_TEST_ID).toBe('from-file');
      expect(process.env.NOVACODE_TEST_SET).toBe('already-set');
    } finally {
      delete process.env.NOVACODE_TEST_ID;
      delete process.env.NOVACODE_TEST_SET;
    }
  });

  it('is a no-op when the file is missing', () => {
    expect(() => loadEnv(path.join(os.tmpdir(), 'definitely-missing-nova', '.env'))).not.toThrow();
  });
});
