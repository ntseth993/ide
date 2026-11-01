/**
 * Source collector tests — what is allowed to leave the machine.
 *
 * Runs against real temp folders, because the whole point of this module is the
 * walk: secret rules, ignore rules, provider ignore files, limits and digests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  collectBundle, createIgnoreMatcher, compileIgnoreRule, deniedFile, IGNORE_FILES,
} from '../electron/services/deploy/sourceFiles';

const quiet = { info() {}, warn() {}, error() {} };
let dir;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-files-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function write(rel, content = 'x') {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function paths(bundle) {
  return bundle.files.map((f) => f.path);
}

describe('collectBundle — uploadable set', () => {
  it('collects files with posix paths, sha1 digests and lazy content', async () => {
    write('index.html', '<h1>hi</h1>');
    write('assets/app.js', 'console.log(1)');
    const bundle = await collectBundle({ root: dir, dir, logger: quiet });

    expect(paths(bundle).sort()).toEqual(['assets/app.js', 'index.html']);
    expect(bundle.fileCount).toBe(2);
    const index = bundle.files.find((f) => f.path === 'index.html');
    expect(index.sha).toBe(crypto.createHash('sha1').update('<h1>hi</h1>').digest('hex'));
    expect(index.size).toBe(11);
    expect((await index.read()).toString()).toBe('<h1>hi</h1>');
    expect(bundle.totalBytes).toBe(11 + 14);
  });

  it('uploads only the requested subfolder, relative to it', async () => {
    write('dist/index.html', 'a');
    write('src/secretish.txt', 'b');
    const bundle = await collectBundle({ root: dir, dir: path.join(dir, 'dist'), logger: quiet });
    expect(paths(bundle)).toEqual(['index.html']);
  });

  it('never walks into dependencies, VCS state or NovaCode folders', async () => {
    write('index.html', 'a');
    write('node_modules/left-pad/index.js', 'b');
    write('.git/config', 'c');
    write('.novacode/deploy/index.html', 'd');
    write('.next/server.js', 'e');
    write('.vscode/settings.json', 'f');
    const bundle = await collectBundle({ root: dir, dir, logger: quiet });
    expect(paths(bundle)).toEqual(['index.html']);
  });

  it('skips anything that is not a regular file', async () => {
    write('index.html', 'a');
    fs.mkdirSync(path.join(dir, 'empty-dir'));
    const bundle = await collectBundle({ root: dir, dir, logger: quiet });
    expect(paths(bundle)).toEqual(['index.html']);
  });
});

describe('collectBundle — secrets are refused by name, whatever the ignores say', () => {
  const SECRET_FILES = [
    ['.env', 'local environment secrets'],
    ['.env.local', 'local environment secrets'],
    ['.env.production', 'local environment secrets'],
    ['server.pem', 'private key material'],
    ['tls.key', 'private key material'],
    ['id_ed25519', 'ssh key material'],
    ['novacode-secrets.json', 'NovaCode credential store'],
    ['app.novadb', 'local database files'],
    ['cache.sqlite', 'local database files'],
    ['debug.log', 'build/log output'],
    ['.npmrc', 'registry credentials'],
    ['credentials.prod', 'cloud credentials'],
    ['.DS_Store', 'OS metadata'],
  ];

  it.each(SECRET_FILES)('excludes %s and reports the reason', async (file, reason) => {
    write('index.html', 'a');
    write(file, 'SECRET VALUE MUST NOT TRAVEL');
    const bundle = await collectBundle({ root: dir, dir, logger: quiet });
    expect(paths(bundle)).toEqual(['index.html']);
    expect(bundle.excluded.secrets).toEqual([{ path: file, reason }]);
  });

  it('a .gitignore negation cannot re-admit a secret', async () => {
    write('.gitignore', 'index.html\n!.env\n');
    write('index.html', 'a');
    write('.env', 'API_KEY=nope');
    const bundle = await collectBundle({ root: dir, dir, logger: quiet });
    expect(paths(bundle)).toEqual([]);
    expect(bundle.excluded.secrets.map((s) => s.path)).toEqual(['.env']);
  });

  it('never lets a secret value reach the bundle descriptor', async () => {
    write('index.html', 'a');
    write('.env', 'PASSWORD=hunter4');
    write('deploy.pem', 'PRIVATE KEY MATERIAL');
    const bundle = await collectBundle({ root: dir, dir, logger: quiet });
    const serialised = JSON.stringify({ files: bundle.files.map(({ read: _omitLazyReader, ...rest }) => rest), excluded: bundle.excluded });
    expect(serialised).not.toContain('hunter4');
    expect(serialised).not.toContain('PRIVATE KEY MATERIAL');
  });
});

describe('collectBundle — ignore rules', () => {
  it('honours the project .gitignore and never uploads the ignore files themselves', async () => {
    write('.gitignore', IGNORE_FILES.map((name) => `# ${name}`).concat(['*.map', 'temp/']).join('\n'));
    write('index.html', 'a');
    write('app.js.map', 'sourcemap');
    write('temp/draft.txt', 'draft');
    const bundle = await collectBundle({ root: dir, dir, logger: quiet });
    expect(paths(bundle)).toEqual(['index.html']);
    expect(bundle.excluded.ignored).toBeGreaterThanOrEqual(3);
  });

  it('honours a provider-specific ignore file', async () => {
    write('.vercelignore', 'private/**');
    write('index.html', 'a');
    write('private/notes.txt', 'b');
    const bundle = await collectBundle({ root: dir, dir, logger: quiet });
    expect(paths(bundle)).toEqual(['index.html']);
  });

  it('applies a nested .gitignore to its own subtree', async () => {
    write('src/index.js', 'a');
    write('src/.gitignore', 'scratch.js');
    write('src/scratch.js', 'b');
    write('scratch.js', 'c');
    const bundle = await collectBundle({ root: dir, dir: path.join(dir, 'src'), logger: quiet });
    expect(paths(bundle)).toEqual(['index.js']);
  });

  it('ignores the workspace root ignore file when a build folder is uploaded', async () => {
    // dist/ contents are exactly what the build produced: the root .gitignore
    // describes the source tree, not this folder, so only rules inside it count.
    write('.gitignore', 'index.html');
    write('dist/index.html', 'a');
    const bundle = await collectBundle({ root: dir, dir: path.join(dir, 'dist'), logger: quiet });
    expect(paths(bundle)).toEqual(['index.html']);
  });
});

describe('collectBundle — limits and honesty', () => {
  it('reports an empty result instead of pretending there is something to send', async () => {
    write('.gitignore', '*');
    const bundle = await collectBundle({ root: dir, dir, logger: quiet });
    expect(bundle.fileCount).toBe(0);
    expect(bundle.warnings.join(' ')).toMatch(/no uploadable files/i);
  });

  it('stops at the file limit with a warning', async () => {
    write('a.txt', '1');
    write('b.txt', '2');
    write('c.txt', '3');
    const bundle = await collectBundle({ root: dir, dir, limits: { maxFiles: 2 }, logger: quiet });
    expect(bundle.fileCount).toBe(2);
    expect(bundle.warnings.join(' ')).toMatch(/Stopped after 2 files/);
  });

  it('skips oversized files and says so', async () => {
    write('small.txt', 'ok');
    write('big.bin', 'x'.repeat(500));
    const bundle = await collectBundle({ root: dir, dir, limits: { maxFileBytes: 100 }, logger: quiet });
    expect(paths(bundle)).toEqual(['small.txt']);
    expect(bundle.excluded.tooLarge).toEqual([{ path: 'big.bin', size: 500 }]);
    expect(bundle.warnings.join(' ')).toMatch(/per-file limit/);
  });

  it('stops adding files once the total size budget is used', async () => {
    write('a.txt', 'x'.repeat(60));
    write('b.txt', 'x'.repeat(60));
    const bundle = await collectBundle({ root: dir, dir, limits: { maxTotalBytes: 100 }, logger: quiet });
    expect(bundle.fileCount).toBe(1);
    expect(bundle.warnings.join(' ')).toMatch(/would exceed/);
  });

  it('refuses a folder outside the workspace', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    try {
      await expect(collectBundle({ root: dir, dir: outside, logger: quiet })).rejects.toThrow(/outside|workspace|not within/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('gitignore subset', () => {
  function matcher(lines) {
    return createIgnoreMatcher({ '': lines });
  }

  it('ignores comments and blank lines', () => {
    expect(compileIgnoreRule('# a comment')).toBeNull();
    expect(compileIgnoreRule('   ')).toBeNull();
  });

  it('matches a bare name at any depth', () => {
    const isIgnored = matcher(['node_modules']);
    expect(isIgnored('node_modules')).toBe(true);
    expect(isIgnored('a/node_modules')).toBe(true);
    expect(isIgnored('src/index.js')).toBe(false);
  });

  it('supports * and ** globs', () => {
    expect(matcher(['*.map'])('dist/app.js.map')).toBe(true);
    expect(matcher(['private/**'])('private/deep/inner.txt')).toBe(true);
    // 'build/*' matches every direct child; a matched child that is a folder is
    // pruned with its whole subtree, which is how git behaves too.
    expect(matcher(['build/*'])('build/app.js')).toBe(true);
    expect(matcher(['build/*'])('build/deep/inner.txt')).toBe(true);
    expect(matcher(['build/*'])('dist/app.js')).toBe(false);
    expect(matcher(['src/*.js'])('src/app.js')).toBe(true);
    expect(matcher(['src/*.js'])('src/deep/app.js')).toBe(false);
  });

  it('anchors a leading slash to the root', () => {
    const isIgnored = matcher(['/root-only.txt']);
    expect(isIgnored('root-only.txt')).toBe(true);
    expect(isIgnored('nested/root-only.txt')).toBe(false);
  });

  it('treats a trailing slash as directory-only', () => {
    const isIgnored = matcher(['temp/']);
    expect(isIgnored('temp', { directory: true })).toBe(true);
    expect(isIgnored('temp/x.txt')).toBe(true);
    expect(isIgnored('temp.txt')).toBe(false);
  });

  it('applies negation in file order', () => {
    const isIgnored = matcher(['*.log', '!keep.log']);
    expect(isIgnored('debug.log')).toBe(true);
    expect(isIgnored('keep.log')).toBe(false);
  });

  it('scopes rules to the folder that declared them', () => {
    // Paths are always relative to the uploaded folder, so a .gitignore inside
    // src/ is keyed on 'src' and cannot reach outside its own subtree.
    const isIgnored = createIgnoreMatcher({ src: ['draft.js'] });
    expect(isIgnored('src/draft.js')).toBe(true);
    expect(isIgnored('src/nested/draft.js')).toBe(true);
    expect(isIgnored('draft.js')).toBe(false);
    expect(isIgnored('other/draft.js')).toBe(false);
  });
});

describe('deniedFile', () => {
  it('names the reason for a secret-shaped file', () => {
    expect(deniedFile('.env')).toMatch(/environment secrets/);
    expect(deniedFile('signing.key')).toMatch(/private key material/);
    expect(deniedFile('app.js')).toBeNull();
    expect(deniedFile('package.json')).toBeNull();
    expect(deniedFile('index.html')).toBeNull();
  });
});
