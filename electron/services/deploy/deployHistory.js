'use strict';
/**
 * Deployment history — "what did I publish, where, and did it work?"
 *
 * Stored as one JSON file under userData (never inside the user's project, so it
 * can never be committed or uploaded). Rows are kept per workspace root and
 * capped, because the panel only ever needs the recent ones.
 *
 * The only secret-shaped value that could end up here is the provider's own
 * dashboard URL, which contains a deployment id — that is not a credential and
 * is required to open the deploy later. Tokens are never written.
 */
const fsp = require('fs').promises;
const path = require('path');

const MAX_ENTRIES_PER_ROOT = 50;

/**
 * Codes that mean “some other process is holding this file right now”: an
 * indexer, an antivirus scan, a saturated file-descriptor table. They say
 * nothing about the stored data, so the answer is to try again. Treating one of
 * them as “no history” would let the next write destroy rows that are still on
 * disk, which is far worse than a missing entry.
 */
const TRANSIENT_FS_CODES = new Set(['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'EPERM', 'ENOTEMPTY']);

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Run `action` until it succeeds or the failure turns out to be permanent. */
async function withRetries(attempts, backoffMs, action) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_FS_CODES.has(error && error.code) || attempt === attempts) throw error;
      await sleep(backoffMs * attempt);
    }
  }
  throw lastError;
}

/** Stable, human-readable id: `dp-<base36 time>-<random>`. */
function makeId() {
  return `dp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeRoot(root) {
  return String(root || '').replace(/[\\/]+$/, '');
}

/** Rows are trimmed to what the dashboard lists; full detail stays in the run. */
function toRow(entry) {
  return {
    id: entry.id,
    root: entry.root,
    provider: entry.provider,
    teamId: entry.teamId || null,
    projectName: entry.projectName || null,
    deploymentId: entry.deploymentId || null,
    publicUrl: entry.publicUrl || null,
    dashboardUrl: entry.dashboardUrl || null,
    target: entry.target || 'production',
    state: entry.state || 'unknown',
    message: entry.message || null,
    framework: entry.framework || null,
    deployMode: entry.deployMode || null,
    fileCount: Number(entry.fileCount) || 0,
    totalBytes: Number(entry.totalBytes) || 0,
    startedAt: entry.startedAt || null,
    finishedAt: entry.finishedAt || null,
    createdAt: entry.createdAt || null,
  };
}

function createDeployHistory({
  filePath,
  logger = console,
  now = () => new Date().toISOString(),
  fsImpl = fsp,
  attempts = 3,
  retryBackoffMs = 25,
} = {}) {
  if (!filePath) throw new Error('deployHistory requires a filePath.');
  let cache = null;
  // History is read-modify-write, so two runs finishing at the same moment would
  // otherwise each write a snapshot taken before the other landed and lose a row.
  // One operation at a time per file makes that impossible.
  let queued = Promise.resolve();

  function enqueue(task) {
    const run = queued.then(task, task);
    // A failed write must not wedge the queue for good.
    queued = run.then(() => {}, () => {});
    return run;
  }

  async function readAll() {
    if (cache) return cache;
    let parsed;
    try {
      const text = await withRetries(attempts, retryBackoffMs, () => fsImpl.readFile(filePath, 'utf8'));
      try {
        const candidate = JSON.parse(text);
        // Not an object means unusable, not malicious: recover with an empty set.
        parsed = (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) ? candidate : {};
      } catch {
        logger.warn?.('deploy history unreadable; starting empty', { filePath });
        parsed = {};
      }
    } catch (error) {
      const code = error && error.code;
      // No readable history file lives at this path: missing (ENOENT), or a path
      // segment is a file / a directory rather than a file (ENOTDIR / EISDIR).
      // POSIX reports ENOTDIR where Windows reports ENOENT, so forgiving all three
      // keeps behaviour identical across platforms. This is NOT a transient-busy
      // signal (those are retried above and re-thrown) so treating it as empty
      // cannot clobber rows that are actually on disk; the write path owns the
      // real failure and logs it.
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') parsed = {};
      else throw error;
    }
    cache = parsed;
    return cache;
  }

  async function writeAll(data) {
    cache = data;
    try {
      await withRetries(attempts, retryBackoffMs, async () => {
        await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
        await fsImpl.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
      });
    } catch (error) {
      // Losing history must never fail a deployment that already succeeded.
      logger.error('deploy history write failed', { error: error.message });
    }
  }

  /** Newest-first rows for one workspace (or every workspace when root is absent). */
  async function list({ root, limit = MAX_ENTRIES_PER_ROOT } = {}) {
    const data = await readAll();
    if (root) {
      return (data[normalizeRoot(root)] || []).slice(0, limit).map(toRow);
    }
    const all = Object.values(data).flat().map(toRow);
    return all
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, limit);
  }

  /** Insert or update the row for a run. Same id replaces, so live state persists. */
  function record(entry) {
    if (!entry || !entry.root) return Promise.resolve(null);
    return enqueue(async () => {
      const key = normalizeRoot(entry.root);
      const data = await readAll();
      const rows = Array.isArray(data[key]) ? data[key] : [];
      const id = entry.id || makeId();
      const createdAt = entry.createdAt || now();
      const index = rows.findIndex((row) => row.id === id);
      const previous = index >= 0 ? rows[index] : null;
      // Trim through toRow BEFORE serialising: the file on disk must never hold a
      // field outside the whitelist, even if a caller passes one by mistake.
      // Merging the previous row keeps a partial update from resetting columns.
      const row = toRow({ ...(previous || {}), ...entry, id, createdAt });
      if (index >= 0) rows[index] = row;
      else rows.unshift(row);
      rows.length = Math.min(rows.length, MAX_ENTRIES_PER_ROOT);
      await writeAll({ ...data, [key]: rows });
      // Return the row this entry owns, never simply the newest one: the caller
      // feeds `id` back in on the next phase, and a wrong id would duplicate runs.
      return row;
    });
  }

  function clear({ root } = {}) {
    return enqueue(async () => {
      const data = await readAll();
      if (root) {
        const key = normalizeRoot(root);
        if (!(key in data)) return { ok: true, removed: 0 };
        const removed = (data[key] || []).length;
        const next = { ...data };
        delete next[key];
        await writeAll(next);
        return { ok: true, removed };
      }
      const removed = Object.values(data).flat().length;
      await writeAll({});
      return { ok: true, removed };
    });
  }

  return { list, record, clear, MAX_ENTRIES_PER_ROOT };
}

module.exports = { createDeployHistory, toRow, normalizeRoot, MAX_ENTRIES_PER_ROOT };
