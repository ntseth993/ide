/**
 * Deployment history tests.
 *
 * History is the only deploy state that outlives a run, so two properties matter:
 * a row must be updated in place (never duplicated as the run progresses), and no
 * credential can ever be written to the file — it lives on the user's disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDeployHistory, toRow, normalizeRoot, MAX_ENTRIES_PER_ROOT,
} from '../electron/services/deploy/deployHistory';

const quiet = { info() {}, warn() {}, error() {} };
let dir;
let file;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-history-'));
  file = path.join(dir, 'deploy-history.json');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

let tick = 0;
function history(extra = {}) {
  return createDeployHistory({
    filePath: file,
    logger: quiet,
    now: () => new Date(Date.UTC(2026, 0, tick += 1)).toISOString(),
    ...extra,
  });
}

function entry(overrides = {}) {
  return { root: 'C:/projects/site', provider: 'vercel', state: 'building', ...overrides };
}

describe('createDeployHistory', () => {
  it('needs a file path or it would write history nowhere', () => {
    expect(() => createDeployHistory({ logger: quiet })).toThrow(/filePath/);
  });

  it('starts empty when the file does not exist yet', async () => {
    expect(await history().list({ root: 'C:/projects/site' })).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('survives a corrupt history file instead of failing the panel', async () => {
    fs.writeFileSync(file, '{ this is not json', 'utf8');
    let warned = null;
    const h = createDeployHistory({ filePath: file, logger: { ...quiet, warn: (m) => { warned = m; } } });
    expect(await h.list({})).toEqual([]);
    expect(warned).toMatch(/unreadable/);
  });

  it('treats a JSON array file as no history at all', async () => {
    fs.writeFileSync(file, '[1,2,3]', 'utf8');
    expect(await history().list({})).toEqual([]);
  });
});

describe('record', () => {
  it('returns the row it wrote, including a fresh id', async () => {
    const row = await history().record(entry({ publicUrl: 'https://demo.vercel.app' }));
    expect(row.id).toMatch(/^dp-/);
    expect(row.provider).toBe('vercel');
    expect(row.publicUrl).toBe('https://demo.vercel.app');
    expect(row.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('ignores an entry with no workspace root', async () => {
    expect(await history().record({ provider: 'vercel' })).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('updates the same run in place instead of appending a duplicate', async () => {
    const h = history();
    const first = await h.record(entry({ state: 'building', message: 'Uploading.' }));
    const second = await h.record(entry({ id: first.id, state: 'ready', publicUrl: 'https://demo.vercel.app' }));
    const rows = await h.list({ root: 'C:/projects/site' });

    // Regression: returning the newest row here made the controller adopt a
    // foreign id, so every phase wrote a brand-new history row.
    expect(second.id).toBe(first.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('ready');
    expect(rows[0].message).toBe('Uploading.'); // merged, not replaced wholesale
  });

  it('keeps the newest deploy at the front', async () => {
    const h = history();
    await h.record(entry({ provider: 'netlify', state: 'ready' }));
    await h.record(entry({ provider: 'vercel', state: 'ready' }));
    const rows = await h.list({ root: 'C:/projects/site' });
    expect(rows.map((r) => r.provider)).toEqual(['vercel', 'netlify']);
  });

  it('separates workspaces but lists everything when no root is given', async () => {
    const h = history();
    await h.record(entry({ root: 'C:/projects/one', provider: 'vercel' }));
    await h.record(entry({ root: 'C:/projects/two', provider: 'netlify' }));
    expect((await h.list({ root: 'C:/projects/one' })).map((r) => r.provider)).toEqual(['vercel']);
    expect((await h.list({ root: 'C:/projects/two' })).map((r) => r.provider)).toEqual(['netlify']);
    expect(await h.list({})).toHaveLength(2);
  });

  it('unifies trailing separators, but the separator style stays part of the key', async () => {
    // Roots arrive from Electron in one platform style, so only the trailing
    // slash is normalised; asserting the rest keeps that contract visible.
    const h = history();
    await h.record(entry({ root: 'C:/projects/site/' }));
    await h.record(entry({ root: 'C:/projects/site' }));
    expect(await h.list({ root: 'C:/projects/site' })).toHaveLength(2);
    await h.record(entry({ root: 'C:\\projects\\site' }));
    expect(await h.list({ root: 'C:\\projects\\site' })).toHaveLength(1);
  });

  it('caps the stored rows per workspace', async () => {
    const h = history();
    for (let i = 0; i < MAX_ENTRIES_PER_ROOT + 10; i += 1) await h.record(entry({ projectName: `p${i}` }));
    const rows = await h.list({ root: 'C:/projects/site', limit: 500 });
    expect(rows).toHaveLength(MAX_ENTRIES_PER_ROOT);
    expect(rows[0].projectName).toBe('p59'); // newest kept
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(persisted['C:/projects/site']).toHaveLength(MAX_ENTRIES_PER_ROOT);
  });

  it('honours a smaller display limit without rewriting the file', async () => {
    const h = history();
    for (let i = 0; i < 3; i += 1) await h.record(entry({ projectName: `p${i}` }));
    expect(await h.list({ root: 'C:/projects/site', limit: 2 })).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))['C:/projects/site']).toHaveLength(3);
  });

  it('re-reads from disk so a second window sees the first one deploys', async () => {
    await history().record(entry({ provider: 'vercel' }));
    const rows = await history().list({ root: 'C:/projects/site' });
    expect(rows.map((r) => r.provider)).toEqual(['vercel']);
  });
});

describe('what may be written to disk', () => {
  it('keeps only the whitelisted columns, even if a caller passes secrets', async () => {
    const h = history();
    await h.record(entry({
      token: 'vercel_odq_abcdef1234567890',
      envVars: [{ key: 'API_KEY', value: 'secret-value' }],
      bundle: { files: [{ path: '.env' }] },
      deploymentId: 'dpl_1',
      fileCount: 7,
      totalBytes: 4096,
    }));
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain('vercel_odq');
    expect(raw).not.toContain('secret-value');
    expect(raw).not.toContain('.env');
    const [row] = await h.list({ root: 'C:/projects/site' });
    expect(row.fileCount).toBe(7);
    expect(row.totalBytes).toBe(4096);
    expect(Object.keys(row).sort()).toEqual([
      'createdAt', 'dashboardUrl', 'deployMode', 'deploymentId', 'fileCount', 'finishedAt', 'framework',
      'id', 'message', 'projectName', 'provider', 'publicUrl', 'root', 'startedAt', 'state', 'target', 'teamId', 'totalBytes',
    ]);
  });

  it('never rewrites a column an update did not mention', async () => {
    const h = history();
    const first = await h.record(entry({
      target: 'preview', framework: 'vite', deployMode: 'prebuilt', fileCount: 3, totalBytes: 99,
    }));
    const second = await h.record(entry({ id: first.id, state: 'ready' }));
    expect(second).toMatchObject({
      target: 'preview', framework: 'vite', deployMode: 'prebuilt', fileCount: 3, totalBytes: 99, state: 'ready',
    });
  });

  it('defaults target to production and counts a missing size as zero', () => {
    const row = toRow({ id: 'dp_1', root: 'x', provider: 'vercel' });
    expect(row.target).toBe('production');
    expect(row.state).toBe('unknown');
    expect(row.fileCount).toBe(0);
    expect(row.totalBytes).toBe(0);
    expect(row.publicUrl).toBeNull();
  });

  it('drops a non-numeric size instead of writing NaN', () => {
    expect(toRow({ fileCount: 'lots', totalBytes: undefined }).fileCount).toBe(0);
    expect(toRow({ fileCount: '12' }).fileCount).toBe(12);
  });

  it('refuses to crash the deploy when the disk is unwritable', async () => {
    const errors = [];
    const h = createDeployHistory({
      filePath: path.join(dir, 'no-such-parent', 'deep', 'history.json'),
      logger: { ...quiet, error: (m) => errors.push(m) },
    });
    // mkdir -p means this actually succeeds on the temp dir; force a failure by
    // pointing at a path whose parent is a file.
    const blocker = path.join(dir, 'afile');
    fs.writeFileSync(blocker, 'not a folder', 'utf8');
    const blocked = createDeployHistory({
      filePath: path.join(blocker, 'history.json'),
      logger: { ...quiet, error: (m) => errors.push(m) },
    });
    const row = await blocked.record(entry());
    expect(row).not.toBeNull(); // the run still gets its id back
    expect(errors.join(' ')).toMatch(/history write failed/);
    expect(fs.existsSync(file)).toBe(false); // h never wrote
    await h.list({});
  });
});

describe('a busy or broken disk', () => {
  /** Wrap the real fs so a call can fail with a chosen code a fixed number of times. */
  function flakyFs({ readFailures = 0, writeFailures = 0, code = 'EBUSY' } = {}) {
    const real = fs.promises;
    const calls = { reads: 0, writes: 0 };
    function busy() { const error = new Error(`file is busy (${code})`); error.code = code; return error; }
    return {
      calls,
      async readFile(p, enc) { calls.reads += 1; if (calls.reads <= readFailures) throw busy(); return real.readFile(p, enc); },
      async mkdir(p, options) { return real.mkdir(p, options); },
      async writeFile(p, data, enc) { calls.writes += 1; if (calls.writes <= writeFailures) throw busy(); return real.writeFile(p, data, enc); },
    };
  }

  function flaky(extra = {}) {
    const fsImpl = flakyFs(extra.fs || {});
    const errors = [];
    const h = createDeployHistory({
      filePath: file,
      logger: { ...quiet, error: (m) => errors.push(m) },
      fsImpl,
      retryBackoffMs: 0,
      ...extra.options,
    });
    return { h, fsImpl, errors };
  }

  it('retries a file another process is holding instead of losing the row', async () => {
    const { h, fsImpl } = flaky({ fs: { readFailures: 1, writeFailures: 2 } });
    const row = await h.record(entry({ projectName: 'site' }));
    expect(row.projectName).toBe('site');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))['C:/projects/site']).toHaveLength(1);
    expect(fsImpl.calls.reads).toBe(2);
    expect(fsImpl.calls.writes).toBe(3);
  });

  it('refuses to overwrite stored rows it could not read', async () => {
    await history().record(entry({ projectName: 'kept' }));
    const writes = [];
    const alwaysBusy = {
      async readFile() { const error = new Error('no descriptors left'); error.code = 'EMFILE'; throw error; },
      async mkdir() {},
      async writeFile(p, data) { writes.push(data); },
    };
    const h = createDeployHistory({ filePath: file, logger: quiet, fsImpl: alwaysBusy, retryBackoffMs: 0 });
    await expect(h.record(entry({ projectName: 'new' }))).rejects.toThrow(/no descriptors left/);
    // Nothing was written, so the one row that is really on disk is still there.
    expect(writes).toEqual([]);
    expect((await history().list({ root: 'C:/projects/site' })).map((r) => r.projectName)).toEqual(['kept']);
  });

  it('does not retry a failure that will never fix itself', async () => {
    const { h, fsImpl, errors } = flaky({ fs: { writeFailures: 5, code: 'EBADF' } });
    await h.record(entry());
    expect(fsImpl.calls.writes).toBe(1);
    expect(errors.join(' ')).toMatch(/history write failed/);
  });

  it('keeps both rows when two runs finish at the same moment', async () => {
    // Without a write queue both records read an empty file, each build their own
    // one-row list, and the second write silently drops the first deploy.
    const h = history();
    await Promise.all([
      h.record(entry({ projectName: 'first' })),
      h.record(entry({ projectName: 'second' })),
    ]);
    expect((await h.list({ root: 'C:/projects/site' })).map((r) => r.projectName).sort())
      .toEqual(['first', 'second']);
  });
});

describe('clear', () => {
  it('removes one workspace and reports how many rows went', async () => {
    const h = history();
    await h.record(entry({ root: 'C:/projects/one' }));
    await h.record(entry({ root: 'C:/projects/one' }));
    await h.record(entry({ root: 'C:/projects/two' }));
    expect(await h.clear({ root: 'C:/projects/one' })).toEqual({ ok: true, removed: 2 });
    expect(await h.list({ root: 'C:/projects/one' })).toEqual([]);
    expect(await h.list({ root: 'C:/projects/two' })).toHaveLength(1);
  });

  it('says removed 0 for an unknown workspace rather than failing', async () => {
    expect(await history().clear({ root: 'C:/projects/ghost' })).toEqual({ ok: true, removed: 0 });
  });

  it('clears every workspace when no root is given', async () => {
    const h = history();
    await h.record(entry({ root: 'C:/projects/one' }));
    await h.record(entry({ root: 'C:/projects/two' }));
    expect(await h.clear({})).toEqual({ ok: true, removed: 2 });
    expect(fs.readFileSync(file, 'utf8')).toBe('{}');
  });

  it('normalizes the root for clearing too', () => {
    expect(normalizeRoot('C:/projects/site///')).toBe('C:/projects/site');
    expect(normalizeRoot(null)).toBe('');
  });
});
