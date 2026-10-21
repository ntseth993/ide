/**
 * Safe change history — the journal behind "restore any AI edit".
 *
 * Every accepted AI edit is recorded BEFORE/AFTER content is swapped through
 * the fs:apply-ai-edit channel: the renderer cannot write an AI edit without
 * a journal entry existing for it. Restores are journal entries too, so
 * "undo of the undo" works. Entries live in a JSONL file under userData;
 * one JSON object per line, newest last.
 *
 * File access is injected (readFile/writeFile/remove bound to the workspace
 * fsService) so the journaling logic stays unit-testable without Electron.
 */
const nodeFs = require('fs');

const MAX_ENTRY_BYTES = 512 * 1024; // refuse to journal huge files; content beyond this is truncated to a marker
const DEFAULT_MAX_ENTRIES = 200;

function makeId() {
  return `ch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function readAllLines(filePath) {
  let raw = '';
  try {
    raw = nodeFs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A torn final line (crash mid-append) must not break the journal.
    }
  }
  return entries;
}

/** Public shape for list views: no content bodies. */
function summarize(entry) {
  return {
    id: entry.id,
    ts: entry.ts,
    kind: entry.kind,
    root: entry.root,
    filePath: entry.path,
    created: entry.previous === null,
    previousBytes: entry.previous === null ? 0 : entry.previous.length,
    contentBytes: entry.content === null ? 0 : entry.content.length,
    refId: entry.refId || null,
  };
}

function capContent(text) {
  if (typeof text !== 'string') return null;
  if (text.length <= MAX_ENTRY_BYTES) return text;
  return `${text.slice(0, MAX_ENTRY_BYTES)}\n/* [NovaCode] change history: content truncated at ${MAX_ENTRY_BYTES} bytes */`;
}

function createChangeHistory({ filePath, readFile, writeFile, remove, logger, maxEntries = DEFAULT_MAX_ENTRIES }) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Change history requires a storage file path.');
  }

  function append(entry) {
    // Guard against torn final lines (crash mid-append): a fragment without a
    // trailing newline would fuse with the next entry and corrupt both.
    let separator = '';
    try {
      const stat = nodeFs.statSync(filePath);
      if (stat.size > 0) {
        const fd = nodeFs.openSync(filePath, 'r');
        const tail = Buffer.alloc(1);
        nodeFs.readSync(fd, tail, 0, 1, stat.size - 1);
        nodeFs.closeSync(fd);
        if (tail[0] !== 0x0a) separator = '\n';
      }
    } catch {
      // File does not exist yet.
    }
    nodeFs.appendFileSync(filePath, `${separator}${JSON.stringify(entry)}\n`, 'utf8');
    const lines = readAllLines(filePath);
    if (lines.length > maxEntries) {
      const kept = lines.slice(lines.length - maxEntries);
      nodeFs.writeFileSync(filePath, kept.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
    }
    return entry;
  }

  function record({ root, filePath: target, previous, content, kind = 'ai-edit', refId = null }) {
    if (!root || typeof root !== 'string') throw new Error('Change history entries need a workspace root.');
    if (!target || typeof target !== 'string') throw new Error('Change history entries need a file path.');
    if (kind !== 'ai-edit' && kind !== 'restore') throw new Error('Unknown change history kind.');
    const entry = {
      id: makeId(),
      ts: new Date().toISOString(),
      kind,
      root,
      path: target,
      previous: capContent(previous),
      content: capContent(content),
      refId,
    };
    try {
      return append(entry);
    } catch (error) {
      logger?.error?.('change history append failed', { error: error.message });
      return entry; // the edit itself still happened; journaling is best-effort
    }
  }

  function list({ root, limit = 50 } = {}) {
    if (!root || typeof root !== 'string') throw new Error('Open a folder first.');
    return readAllLines(filePath)
      .filter((entry) => entry.root === root)
      .slice(-limit)
      .reverse()
      .map(summarize);
  }

  async function restore({ root, id }) {
    if (!root || typeof root !== 'string') throw new Error('Open a folder first.');
    if (typeof id !== 'string' || !id.trim()) throw new Error('A history entry id is required.');
    const entry = readAllLines(filePath).find((item) => item.id === id);
    if (!entry) throw new Error('That history entry no longer exists.');
    if (entry.root !== root) throw new Error('That history entry belongs to a different folder.');

    const current = await readFile(root, entry.path).catch(() => null);
    if (current !== null && entry.previous !== null && current === entry.previous) {
      throw new Error('The file already matches the state before that edit.');
    }

    if (entry.previous === null) {
      // The edit created this file; restoring removes it.
      await remove(root, entry.path);
    } else {
      await writeFile(root, entry.path, entry.previous);
    }

    append({
      id: makeId(),
      ts: new Date().toISOString(),
      kind: 'restore',
      root,
      path: entry.path,
      previous: capContent(current),
      content: entry.previous,
      refId: entry.id,
    });

    return { filePath: entry.path, content: entry.previous, restoredId: entry.id };
  }

  return { record, list, restore };
}

module.exports = { createChangeHistory, summarize, capContent, DEFAULT_MAX_ENTRIES, MAX_ENTRY_BYTES, _internal: { readAllLines, makeId } };
