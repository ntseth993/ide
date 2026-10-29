'use strict';
/**
 * NovaDB storage service (Stage 2 — persistence).
 *
 * Wraps the in-memory NovaDB engine with a durable JSON snapshot on disk, so
 * databases, tables and records created in the Database workspace survive an
 * app restart. This is deliberately NOT a claim of ACID durability: writes are
 * debounced and best-effort (a crash between flushes can lose the last
 * statements). Journaling and crash recovery belong to a later stage.
 *
 * The engine does all SQL work; this file only decides WHEN to read the file
 * (lazily, on first use) and WHEN to write it (after any statement that could
 * change state, coalesced into one flush). Read-only statements — SELECT and
 * the SHOW/DESCRIBE/USE introspection — never trigger a write.
 */
const fs = require('fs');
const path = require('path');
const { createNovaDB } = require('./index');

// Statement result types that cannot mutate stored data, so they skip the
// (debounced) disk flush. Everything else — DDL, DML, transactions, USE — is
// persisted because it changes the catalog or the current-database pointer.
const READ_ONLY = new Set(['select', 'showDatabases', 'showTables', 'describe']);

/**
 * @param {{ filePath: string, logger?: { warn?: Function, error?: Function } }} options
 */
function createNovaDbService({ filePath, logger = console } = {}) {
  const engine = createNovaDB();
  let loaded = false;
  let saveTimer = null;

  function load() {
    if (loaded) return;
    loaded = true;
    if (!filePath) return;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      engine.load(JSON.parse(raw));
    } catch (error) {
      // A missing file is simply a first run — nothing to restore. Any other
      // failure (corrupt JSON) is logged but leaves the engine empty/usable.
      if (error.code !== 'ENOENT') logger.warn?.('novadb load failed, starting empty', { error: error.message });
    }
  }

  function flush() {
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(engine.serialize(), null, 2), 'utf8');
    } catch (error) {
      logger.error?.('novadb persist failed', { error: error.message });
    }
  }

  // Coalesce a burst of writes into one disk flush ~150ms after the last one.
  function schedulePersist() {
    if (!filePath) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flush();
    }, 150);
  }

  function execute(sql, params = []) {
    load();
    const result = engine.execute(sql, Array.isArray(params) ? params : []);
    if (result && result.ok && !READ_ONLY.has(result.type)) schedulePersist();
    return result;
  }

  function status() {
    load();
    return { ...engine.overview(), storagePath: filePath || null, ready: true };
  }

  // Flush any pending write on shutdown so a quit after a burst is not lost.
  function dispose() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (loaded && filePath) flush();
  }

  return { execute, status, dispose, flush };
}

module.exports = { createNovaDbService };
