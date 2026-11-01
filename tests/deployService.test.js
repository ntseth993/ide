/**
 * Deploy service tests — detect / build / export against REAL temp folders.
 * No mocks except the terminal runner (build), which is injected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDeployService, BUNDLE_DIR, applyDeployClassification, SERVER_ENTRY } from '../electron/services/deploy/deployService';

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

describe('deploy service — detect: what a real deployment needs to know', () => {
  it('says whether dependencies are actually installed', async () => {
    write('package.json', JSON.stringify({ name: 'x', scripts: { build: 'vite build' }, devDependencies: { vite: '5' } }));
    const svc = createDeployService({ logger: quiet });
    expect((await svc.detect(dir)).nodeModulesInstalled).toBe(false);

    // An empty node_modules folder counts as not installed: `npm i` was interrupted.
    fs.mkdirSync(path.join(dir, 'node_modules'));
    expect((await svc.detect(dir)).nodeModulesInstalled).toBe(false);

    fs.writeFileSync(path.join(dir, 'node_modules', 'vite.js'), '//', 'utf8');
    expect((await svc.detect(dir)).nodeModulesInstalled).toBe(true);
  });

  it('reports the gaps that must be fixed before deploying', async () => {
    write('package.json', '{ not json');
    write('index.html', 'a');
    const svc = createDeployService({ logger: quiet });
    const p = await svc.detect(dir);
    expect(p.deployable).toBe(false);
    expect(p.blockers.join(' ')).toMatch(/package.json is not valid JSON/);
  });

  it('has no blocker for a folder that only needs uploading', async () => {
    write('index.html', '<h1>hi</h1>');
    write('style.css', 'body{}');
    const svc = createDeployService({ logger: quiet });
    const p = await svc.detect(dir);
    expect(p.deployable).toBe(true);
    expect(p.blockers).toEqual([]);
    expect(p.deployMode).toBe('prebuilt');
    expect(p.targetKind).toBe('static');
  });

  it('tells the user to open the folder that holds the project, not a subfolder', async () => {
    write('nested/package.json', '{}');
    const svc = createDeployService({ logger: quiet });
    const p = await svc.detect(dir);
    expect(p.deployMode).toBe('unsupported');
    expect(p.blockers.join(' ')).toMatch(/workspace root/i);
  });
});

describe('deploy service — detect: provider config wins, and is never rewritten', () => {
  it('uses the netlify.toml publish directory over the framework default', async () => {
    write('package.json', JSON.stringify({ name: 'v', scripts: { build: 'vite build' }, devDependencies: { vite: '5' } }));
    write('netlify.toml', '[build]\n  command = "npm run build"\n  publish = "public"\n');
    write('public/index.html', 'a');
    write('dist/index.html', 'b');
    const svc = createDeployService({ logger: quiet });

    const before = fs.readFileSync(path.join(dir, 'netlify.toml'), 'utf8');
    const p = await svc.detect(dir);
    expect(p.providerConfig.netlify.publish).toBe('public');
    expect(p.providerConfig.netlify.buildCommand).toBe('npm run build');
    expect(p.outputDir).toBe('public');
    // §7: suggesting settings must not touch the project's own files.
    expect(fs.readFileSync(path.join(dir, 'netlify.toml'), 'utf8')).toBe(before);
  });

  it('uses vercel.json outputDirectory and reports serverless functions', async () => {
    write('package.json', JSON.stringify({ name: 'v', scripts: { build: 'build' } }));
    write('vercel.json', JSON.stringify({ outputDirectory: 'out', functions: { 'api/*.js': {} } }));
    write('out/index.html', 'a');
    const svc = createDeployService({ logger: quiet });
    const p = await svc.detect(dir);
    expect(p.providerConfig.vercel.outputDirectory).toBe('out');
    expect(p.providerConfig.vercel.functions).toBe(true);
    expect(p.outputDir).toBe('out');
  });

  it('honours a custom vite outDir', async () => {
    write('package.json', JSON.stringify({ name: 'v', scripts: { build: 'vite build' }, devDependencies: { vite: '5' } }));
    write('vite.config.js', 'export default { build: { outDir: "deploy-here" } };');
    write('deploy-here/index.html', 'a');
    const svc = createDeployService({ logger: quiet });
    expect((await svc.detect(dir)).outputDir).toBe('deploy-here');
  });

  it('treats a static-export Next.js app as uploadable output instead of a server build', async () => {
    write('package.json', JSON.stringify({
      name: 'n', scripts: { build: 'next build' }, dependencies: { next: '14' },
    }));
    write('next.config.mjs', 'export default { output: "export" };');
    write('out/index.html', 'a');
    const svc = createDeployService({ logger: quiet });
    const p = await svc.detect(dir);
    expect(p.providerConfig.nextStaticExport).toBe(true);
    expect(p.targetKind).toBe('static');
    expect(p.deployMode).toBe('prebuilt');
  });
});

describe('deploy service — detect: backend vs static honesty', () => {
  it('ships a Next.js app as source for the host to build, never as a static folder', async () => {
    write('package.json', JSON.stringify({
      name: 'n', scripts: { build: 'next build' }, dependencies: { next: '14' },
    }));
    const svc = createDeployService({ logger: quiet });
    const p = await svc.detect(dir);
    expect(p.deployMode).toBe('provider-build');
    expect(p.targetKind).toBe('server');
    expect(p.warnings.join(' ')).toMatch(/renders on the server/i);
  });

  it('warns when a static upload would leave a detected API behind', async () => {
    write('package.json', JSON.stringify({
      name: 'full',
      scripts: { build: 'vite build' },
      dependencies: { express: '4' },
      devDependencies: { vite: '5' },
    }));
    write('dist/index.html', 'a');
    const svc = createDeployService({ logger: quiet });
    const p = await svc.detect(dir);
    expect(p.backend.detected).toBe(true);
    expect(p.backend.evidence).toContain('dependency express');
    expect(p.frontendOnly).toBe(true);
    expect(p.deployable).toBe(true); // allowed, but only after an explicit acknowledgement
    expect(p.warnings.join(' ')).toMatch(/endpoints will not exist/i);
  });

  it('counts a server folder as a backend even with no framework dependencies', async () => {
    write('package.json', JSON.stringify({ name: 'plain', scripts: { build: 'build' } }));
    write('server/index.js', 'module.exports = 1;');
    write('build/index.html', 'a');
    const svc = createDeployService({ logger: quiet });
    const p = await svc.detect(dir);
    expect(p.backend.evidence).toContain('server/ folder');
    expect(p.backend.detected).toBe(true);
  });

  it('reads a plain server entry point, but not a bundled library main', () => {
    expect(SERVER_ENTRY.test('server.js')).toBe(true);
    expect(SERVER_ENTRY.test('app.production.js')).toBe(true);
    expect(SERVER_ENTRY.test('bot.ts')).toBe(true);
    expect(SERVER_ENTRY.test('index.js')).toBe(false); // ambiguous on purpose
    // The false positive this replaced: "main": "dist/index.js" is a library.
    expect(SERVER_ENTRY.test(path.basename('dist/index.js'))).toBe(false);
  });

  it('does not call a library a backend just because it has an index entry', async () => {
    write('package.json', JSON.stringify({
      name: 'lib', main: 'dist/index.js', scripts: { build: 'vite build' }, devDependencies: { vite: '5' },
    }));
    write('dist/index.js', 'module.exports = 1;');
    write('dist/index.html', 'a');
    const svc = createDeployService({ logger: quiet });
    const p = await svc.detect(dir);
    expect(p.backend.detected).toBe(false);
    expect(p.frontendOnly).toBe(false);
    expect(p.warnings.join(' ')).not.toMatch(/Server-side code was detected/);
  });

  it('refuses to pretend a Python server is deployable, and says what to change', async () => {
    write('requirements.txt', 'fastapi\nuvicorn\n');
    write('app/main.py', 'from fastapi import FastAPI');
    const svc = createDeployService({ logger: quiet });
    const p = await svc.detect(dir);
    expect(p.kind).toBe('python');
    expect(p.targetKind).toBe('server');
    expect(p.deployMode).toBe('unsupported');
    expect(p.deployable).toBe(false);
    expect(p.blockers.join(' ')).toMatch(/FastAPI/);
    expect(p.blockers.join(' ')).toMatch(/will not pretend to deploy it/i);
    expect(p.warnings.join(' ')).toMatch(/Render, Railway, Fly\.io/);
  });

  it('refuses to publish an Electron desktop app as a website, and says what to do instead', async () => {
    // This repo's own shape: a Vite renderer plus a main process. Hosting the
    // bundle would publish a page that cannot read files or run a terminal.
    write('package.json', JSON.stringify({
      name: 'ide',
      main: 'electron/main.js',
      scripts: { build: 'vite build' },
      devDependencies: { vite: '5', electron: '33' },
      build: { appId: 'com.example.ide' },
    }));
    write('dist/index.html', 'a');
    const p = await createDeployService({ logger: quiet }).detect(dir);
    expect(p.desktop.detected).toBe(true);
    expect(p.desktop.evidence).toEqual([
      'electron is a dependency',
      'an electron-builder "build" config',
      'entry point electron/main.js',
    ]);
    expect(p.deployable).toBe(false);
    expect(p.blockers.join(' ')).toMatch(/Electron desktop app/);
    expect(p.blockers.join(' ')).toMatch(/cannot open files/);
    expect(p.blockers.join(' ')).toMatch(/Package an installer/);
  });

  it('does not mistake an ordinary web app for a desktop app', async () => {
    write('package.json', JSON.stringify({
      name: 'site', main: 'dist/index.js', scripts: { build: 'vite build' }, devDependencies: { vite: '5' },
    }));
    write('dist/index.html', 'a');
    const p = await createDeployService({ logger: quiet }).detect(dir);
    expect(p.desktop.detected).toBe(false);
    expect(p.deployable).toBe(true);
    expect(p.blockers).toEqual([]);
  });

  it('classifies a bare folder with nothing to build as not deployable', () => {
    const profile = applyDeployClassification({
      framework: null, scripts: {}, outputExists: false, providerConfig: { nextStaticExport: false },
      backend: { detected: false, evidence: [] }, warnings: [], blockers: [],
    });
    expect(profile.deployable).toBe(false);
    expect(profile.blockers.join(' ')).toMatch(/add a build script/i);
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
