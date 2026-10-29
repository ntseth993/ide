/**
 * Deploy service tests — detect / build / export against REAL temp folders.
 * No mocks except the terminal runner (build), which is injected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDeployService, BUNDLE_DIR } from '../electron/services/deploy/deployService';

const quiet = { info() {}, warn() {}, error() {} };
let dir;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function write(rel, content = '') {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

describe('deploy service — detect', () => {
  it('infers a vite project: build command, package manager and existing output', async () => {
    write('package.json', JSON.stringify({
      name: 'acme',
      scripts: { build: 'vite build', dev: 'vite' },
      devDependencies: { vite: '^5.0.0' },
    }));
    write('package-lock.json', '{}');
    write('dist/index.html', '<html></html>');
    const svc = createDeployService({ logger: quiet });

    const p = await svc.detect(dir);
    expect(p.kind).toBe('node');
    expect(p.framework).toBe('vite');
    expect(p.projectName).toBe('acme');
    expect(p.packageManager).toBe('npm');
    expect(p.buildCommand).toBe('npm run build');
    expect(p.outputDir).toBe('dist');
    expect(p.outputExists).toBe(true);
  });

  it('reads the package manager from the lockfile actually present', async () => {
    write('package.json', JSON.stringify({ name: 'x', scripts: { build: 'build' } }));
    write('pnpm-lock.yaml', '');
    const svc = createDeployService({ logger: quiet });
    const p = await svc.detect(dir);
    expect(p.packageManager).toBe('pnpm');
  });

  it('falls back to the first existing common output when no framework matches', async () => {
    write('package.json', JSON.stringify({ name: 'x', scripts: { build: 'make-it' } }));
    write('build/app.js', '');
    const svc = createDeployService({ logger: quiet });
    const p = await svc.detect(dir);
    expect(p.framework).toBeNull();
    expect(p.outputDir).toBe('build');
    expect(p.outputExists).toBe(true);
  });

  it('detects a bare static site (index.html, no package.json)', async () => {
    write('index.html', '<h1>hi</h1>');
    const svc = createDeployService({ logger: quiet });
    const p = await svc.detect(dir);
    expect(p.kind).toBe('static');
    expect(p.outputDir).toBe('.');
    expect(p.outputExists).toBe(true);
  });

  it('reports unknown + a warning when nothing deployable exists', async () => {
    write('README.md', 'docs only');
    const svc = createDeployService({ logger: quiet });
    const p = await svc.detect(dir);
    expect(p.kind).toBe('unknown');
    expect(p.warnings.join(' ')).toMatch(/No package.json or index.html/);
  });

  it('flags SSR frameworks (next) with a server-runtime warning', async () => {
    write('package.json', JSON.stringify({ name: 'n', scripts: { build: 'next build' }, dependencies: { next: '14' } }));
    const svc = createDeployService({ logger: quiet });
    const p = await svc.detect(dir);
    expect(p.framework).toBe('next');
    expect(p.ssr).toBe(true);
    expect(p.warnings.join(' ')).toMatch(/server runtime/i);
  });
});

describe('deploy service — build', () => {
  it('runs the injected capture with the workspace root + trimmed command', async () => {
    let seen = null;
    const svc = createDeployService({
      logger: quiet,
      runCapture: async (opts) => { seen = opts; return { output: 'ok', code: 0 }; },
    });
    const res = await svc.build(dir, { command: '  npm run build  ' });
    expect(res.code).toBe(0);
    expect(seen.command).toBe('npm run build');
    expect(path.resolve(seen.root)).toBe(path.resolve(dir));
  });

  it('rejects an empty command', async () => {
    const svc = createDeployService({ logger: quiet, runCapture: async () => ({ code: 0 }) });
    await expect(svc.build(dir, { command: '   ' })).rejects.toThrow(/build command is required/i);
  });

  it('throws if no runner is wired', async () => {
    const svc = createDeployService({ logger: quiet });
    await expect(svc.build(dir, { command: 'npm run build' })).rejects.toThrow(/unavailable/i);
  });
});

describe('deploy service — export bundle', () => {
  it('copies the output folder into .novacode/deploy and counts bytes', async () => {
    write('dist/index.html', '<html>hello</html>');
    write('dist/assets/app.js', 'console.log(1)');
    const svc = createDeployService({ logger: quiet });

    const r = await svc.exportBundle(dir, { outputDir: 'dist' });
    expect(r.files).toBe(2);
    expect(r.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, BUNDLE_DIR, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(dir, BUNDLE_DIR, 'assets', 'app.js'))).toBe(true);
  });

  it('starts from a clean bundle (removed files do not linger)', async () => {
    write('dist/keep.txt', 'a');
    write('dist/stale.txt', 'b');
    const svc = createDeployService({ logger: quiet });
    await svc.exportBundle(dir, { outputDir: 'dist' });
    fs.rmSync(path.join(dir, 'dist', 'stale.txt'));
    await svc.exportBundle(dir, { outputDir: 'dist' });
    expect(fs.existsSync(path.join(dir, BUNDLE_DIR, 'stale.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dir, BUNDLE_DIR, 'keep.txt'))).toBe(true);
  });

  it('errors when the output directory does not exist', async () => {
    const svc = createDeployService({ logger: quiet });
    await expect(svc.exportBundle(dir, { outputDir: 'nope' })).rejects.toThrow(/not found/i);
  });
});
