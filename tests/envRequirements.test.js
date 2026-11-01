/**
 * Environment requirement detection tests.
 *
 * The rule under test is the one that matters for §9 of the deploy spec: the
 * scanner may report the NAME of a variable and where it is read, and must never
 * report a value — not from source, not from .env, not in a warning.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectEnvRequirements, envKeysFrom, isBuildTime,
} from '../electron/services/deploy/envRequirements';

const quiet = { info() {}, warn() {}, error() {} };
let dir;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-req-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function write(rel, content = '') {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function keys(result) {
  return result.required.map((entry) => entry.key);
}

describe('env requirement scan', () => {
  it('finds server-side process.env reads and names the file', async () => {
    write('server/index.js', 'const key = process.env.STRIPE_SECRET_KEY;\nconst db = process.env["DATABASE_URL"];');
    const result = await detectEnvRequirements({ root: dir, logger: quiet });
    expect(keys(result).sort()).toEqual(['DATABASE_URL', 'STRIPE_SECRET_KEY']);
    expect(result.required.find((e) => e.key === 'DATABASE_URL').source).toBe('server/index.js');
    expect(result.missing).toEqual(['DATABASE_URL', 'STRIPE_SECRET_KEY']);
  });

  it('marks framework-prefixed names as build-time', async () => {
    write('src/main.jsx', 'fetch(import.meta.env.VITE_API_URL);');
    write('app/page.js', 'const k = process.env.NEXT_PUBLIC_MAP_KEY;');
    const result = await detectEnvRequirements({ root: dir, logger: quiet });
    const vite = result.required.find((e) => e.key === 'VITE_API_URL');
    expect(vite.buildTime).toBe(true);
    expect(result.required.find((e) => e.key === 'NEXT_PUBLIC_MAP_KEY').buildTime).toBe(true);
    expect(isBuildTime('VITE_API_URL')).toBe(true);
    expect(isBuildTime('SECRET')).toBe(false);
  });

  it('reads the contract from .env.example keys, ignoring their values', async () => {
    write('.env.example', 'API_URL=\n# comment\nexport WEBHOOK_SECRET = "hunter2"\n');
    const result = await detectEnvRequirements({ root: dir, logger: quiet });
    expect(result.fromExampleFiles.sort()).toEqual(['API_URL', 'WEBHOOK_SECRET']);
    expect(keys(result).sort()).toEqual(['API_URL', 'WEBHOOK_SECRET']);
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('treats a variable defined in .env as accounted for, without reading its value', async () => {
    write('server/app.js', 'process.env.UPLOAD_DIR');
    write('server/.keep.js', 'process.env.NOT_FOUND_ANYWHERE');
    write('.env', 'UPLOAD_DIR=/tmp/uploads\nSECRET_TOKEN=abc123');
    const result = await detectEnvRequirements({ root: dir, logger: quiet });
    expect(result.locallyDefined).toEqual(['UPLOAD_DIR', 'SECRET_TOKEN']);
    expect(result.missing).toEqual(['NOT_FOUND_ANYWHERE']);
    expect(JSON.stringify(result)).not.toContain('abc123');
    expect(JSON.stringify(result)).not.toContain('/tmp/uploads');
  });

  it('drops names the host already knows', async () => {
    write('src/api.js', 'process.env.API_URL');
    const result = await detectEnvRequirements({
      root: dir, providerKeys: ['API_URL'], logger: quiet,
    });
    expect(result.providerDefined).toEqual(['API_URL']);
    expect(result.missing).toEqual([]);
  });

  it('supports python and runtime-style reads', async () => {
    write('app/main.py', 'os.environ["DATABASE_URL"]\nos.environ.get("REDIS_URL", "x")');
    write('config.ru', 'ENV["API_TOKEN"]');
    const result = await detectEnvRequirements({ root: dir, logger: quiet });
    expect(keys(result).sort()).toEqual(['API_TOKEN', 'DATABASE_URL', 'REDIS_URL']);
  });

  it('ignores variables every host already provides', async () => {
    write('src/server.js', 'process.env.NODE_ENV; process.env.PORT; process.env.PATH;');
    const result = await detectEnvRequirements({ root: dir, logger: quiet });
    expect(result.required).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it('skips build output, dependencies and binary-ish folders', async () => {
    write('node_modules/pkg/index.js', 'process.env.SHOULD_NOT_APPEAR');
    write('dist/app.js', 'process.env.SHOULD_NOT_APPEAR_EITHER');
    write('public/global.js', 'process.env.PUBLIC_ONE');
    write('src/app.js', 'process.env.REAL_ONE');
    const result = await detectEnvRequirements({ root: dir, logger: quiet });
    expect(keys(result)).toEqual(['REAL_ONE']);
  });

  it('reports nothing for a project with no environment reads', async () => {
    write('index.html', '<h1>static</h1>');
    write('src/app.js', 'const x = 1;');
    const result = await detectEnvRequirements({ root: dir, logger: quiet });
    expect(result.required).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('says so when the file budget was exhausted', async () => {
    // The budget is injectable so the promise can be tested without 400 real
    // files; the production default still caps a huge repo the same way.
    for (let i = 0; i < 6; i += 1) write(`src/f${i}.js`, `process.env.VAR_${i}`);
    const result = await detectEnvRequirements({
      root: dir, limits: { maxScanFiles: 3 }, logger: quiet,
    });
    expect(result.required).toHaveLength(3);
    expect(result.warnings.join(' ')).toMatch(/first 3 source files; add any remaining/i);
  });

  it('never lets a caller raise the budget above the safe default', async () => {
    write('src/app.js', 'process.env.SAFE_ONE');
    const result = await detectEnvRequirements({
      root: dir, limits: { maxScanFiles: 100000, maxScanBytes: 64 * 1024 * 1024 }, logger: quiet,
    });
    expect(keys(result)).toEqual(['SAFE_ONE']);
    expect(result.warnings).toEqual([]);
  });

  it('skips a file larger than the byte budget instead of reading it', async () => {
    write('src/app.js', `process.env.INSIDE_BIG_FILE ${'pad'.repeat(5000)}`);
    const result = await detectEnvRequirements({
      root: dir, limits: { maxScanBytes: 64 }, logger: quiet,
    });
    expect(result.required).toEqual([]);
  });
});

describe('envKeysFrom', () => {
  it('keeps names and throws the values away', () => {
    expect(envKeysFrom('A=1\nB = 2\nexport C=3\n# D=4\nBAD-NAME=5\nlower_ok=6\n')).toEqual(['A', 'B', 'C', 'lower_ok']);
    expect(envKeysFrom('')).toEqual([]);
    expect(envKeysFrom(null)).toEqual([]);
  });
});
