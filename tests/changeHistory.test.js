/**
 * Change history service tests.
 *
 * Uses a real temp directory so record/restore exercise actual file I/O,
 * with readFile/writeFile/remove bound the same way main.js binds them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createChangeHistory, capContent, MAX_ENTRY_BYTES } = await import('../electron/services/changeHistory');

let tmpRoot;
let journalPath;
let calls;

function makeHistory(overrides = {}) {
  return createChangeHistory({
    filePath: journalPath,
    readFile: async (root, target) => {
      calls.read.push(target);
      return fs.readFileSync(path.join(root, target), 'utf8');
    },
    writeFile: async (root, target, content) => {
      calls.write.push([target, content]);
      fs.writeFileSync(path.join(root, target), content, 'utf8');
    },
    remove: async (root, target) => {
      calls.remove.push(target);
      fs.rmSync(path.join(root, target));
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  });
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-history-'));
  journalPath = path.join(tmpRoot, 'novacode-history.jsonl');
  calls = { read: [], write: [], remove: [] };
  fs.writeFileSync(path.join(tmpRoot, 'a.js'), 'original\n');
});

describe('change history', () => {
  it('records an ai-edit entry and list() returns summaries without bodies', () => {
    const history = makeHistory();
    history.record({ root: tmpRoot, filePath: 'a.js', previous: 'original\n', content: 'edited\n' });

    const entries = history.list({ root: tmpRoot });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'ai-edit', filePath: 'a.js', previousBytes: 9, contentBytes: 7 });
    expect(entries[0].content).toBeUndefined();
    expect(entries[0].previous).toBeUndefined();
  });

  it('filters by workspace root and lists newest first', () => {
    const history = makeHistory();
    history.record({ root: tmpRoot, filePath: 'a.js', previous: 'original\n', content: 'one\n' });
    history.record({ root: 'C:\\somewhere-else', filePath: 'b.js', previous: null, content: 'x' });
    history.record({ root: tmpRoot, filePath: 'a.js', previous: 'one\n', content: 'two\n' });

    const entries = history.list({ root: tmpRoot });
    expect(entries).toHaveLength(2);
    expect(entries[0].contentBytes).toBe(4); // 'two\n' newest first
    expect(entries[1].contentBytes).toBe(4); // 'one\n'
  });

  it('restore writes the previous content back and journals the restore', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'a.js'), 'edited\n');
    const history = makeHistory();
    const recorded = history.record({ root: tmpRoot, filePath: 'a.js', previous: 'original\n', content: 'edited\n' });

    const result = await history.restore({ root: tmpRoot, id: recorded.id });

    expect(result).toMatchObject({ filePath: 'a.js', content: 'original\n' });
    expect(fs.readFileSync(path.join(tmpRoot, 'a.js'), 'utf8')).toBe('original\n');
    const entries = history.list({ root: tmpRoot });
    expect(entries[0]).toMatchObject({ kind: 'restore', refId: recorded.id, filePath: 'a.js' });
  });

  it('restore of a file the edit created removes the file', async () => {
    const history = makeHistory();
    history.record({ root: tmpRoot, filePath: 'new.js', previous: null, content: 'brand new\n' });
    fs.writeFileSync(path.join(tmpRoot, 'new.js'), 'brand new\n');
    const [entry] = history.list({ root: tmpRoot });
    expect(entry.created).toBe(true);

    const result = await history.restore({ root: tmpRoot, id: entry.id });

    expect(result.content).toBeNull();
    expect(fs.existsSync(path.join(tmpRoot, 'new.js'))).toBe(false);
  });

  it('restore refuses entries from another folder or unknown ids', async () => {
    const history = makeHistory();
    history.record({ root: tmpRoot, filePath: 'a.js', previous: 'original\n', content: 'edited\n' });
    const [entry] = history.list({ root: tmpRoot });

    await expect(history.restore({ root: 'C:\\other', id: entry.id })).rejects.toThrow(/different folder/);
    await expect(history.restore({ root: tmpRoot, id: 'ch-missing' })).rejects.toThrow(/no longer exists/);
    await expect(history.restore({ root: tmpRoot, id: '' })).rejects.toThrow(/id is required/);
  });

  it('keeps the journal usable when the file has a torn last line', () => {
    fs.writeFileSync(journalPath, '{"id":"ch-old","kind":"ai-edit","root":"x"}\n{"id":"ch-torn","kin', 'utf8');
    const history = makeHistory();
    history.record({ root: tmpRoot, filePath: 'a.js', previous: 'original\n', content: 'edited\n' });
    expect(history.list({ root: tmpRoot })).toHaveLength(1);
  });

  it('compacts the journal down to maxEntries', () => {
    const history = makeHistory({ maxEntries: 3 });
    for (let i = 0; i < 6; i += 1) {
      history.record({ root: tmpRoot, filePath: 'a.js', previous: `p${i}\n`, content: `c${i}\n` });
    }
    const raw = fs.readFileSync(journalPath, 'utf8').trim().split('\n');
    expect(raw).toHaveLength(3);
    expect(history.list({ root: tmpRoot })).toHaveLength(3);
  });

  it('caps oversized content with a truncation marker', () => {
    const huge = 'x'.repeat(MAX_ENTRY_BYTES + 10);
    const capped = capContent(huge);
    expect(capped.length).toBeLessThan(huge.length + 200);
    expect(capped).toContain('truncated');
    expect(capContent(null)).toBeNull();
  });
});
