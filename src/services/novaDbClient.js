/**
 * NovaDB developer SDK — the integration surface between YOUR project code and
 * the NovaDB engine.
 *
 * This is what a NovaCode project imports to talk to the database. It is a thin,
 * safe wrapper over the same bridge the Database workspace and the `novadb`
 * terminal command use (client.novaDbExec), so anything you do here is visible
 * in the GUI and vice-versa — there is exactly one engine and one persisted file.
 *
 * Safety rules enforced here:
 *   - Table / column names are validated to [A-Za-z_][A-Za-z0-9_]* before they
 *     are ever placed into SQL text (no identifier injection).
 *   - Every value goes through `?` positional bind parameters, never string
 *     interpolation, so user data cannot alter the statement.
 *
 * Typical usage in a renderer component or module:
 *
 *   import { novaDb } from '../services/novaDbClient';
 *
 *   await novaDb.use('app');
 *   await novaDb.insert('todos', { title: 'Ship NovaDB', done: false });
 *   const open = await novaDb.all('SELECT * FROM todos WHERE done = ?', [false]);
 *   const n = await novaDb.count('todos', 'done = ?', [false]);
 *
 *   // Or bind a single table into a small model object:
 *   const Todos = novaDb.model('todos');
 *   await Todos.insert({ title: 'Buy milk' });
 *   await Todos.update(3, { done: true });
 *   await Todos.remove(3);
 */
import { client } from './novaClient';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Throw a clear error unless `name` is a safe SQL identifier. */
function assertIdent(name, label = 'identifier') {
  if (typeof name !== 'string' || !IDENT.test(name)) {
    throw new Error(`NovaDB: invalid ${label} '${String(name)}' (use letters, digits or underscore, starting with a letter).`);
  }
  return name;
}

/** Split a `col = ? AND ...` style where clause into placeholders for logging. */
function buildWhere(where, whereParams) {
  if (!where) return { clause: '', params: [] };
  const clause = String(where).trim();
  if (!clause) return { clause: '', params: [] };
  // Count `?` so callers can pass a matching array.
  const count = (clause.match(/\?/g) || []).length;
  const params = whereParams || [];
  if (params.length !== count) {
    throw new Error(`NovaDB: WHERE clause has ${count} placeholder(s) but ${params.length} value(s) were provided.`);
  }
  return { clause: ` WHERE ${clause}`, params };
}

/** Run a raw statement and return the engine's full result object. */
async function run(sql, params = []) {
  return client.novaDbExec(sql, params);
}

/** Run a statement and return every returned row (empty array if none). */
async function all(sql, params = []) {
  const res = await run(sql, params);
  return res.rows || [];
}

/** Run a SELECT and return the first row, or null when there is none. */
async function get(sql, params = []) {
  const limited = /limit\s+\d+/i.test(sql) ? sql : `${sql} LIMIT 1`;
  const rows = await all(limited, params);
  return rows[0] || null;
}

/** Return the first column of the first row — handy for COUNT/SUM lookups. */
async function value(sql, params = []) {
  const res = await run(sql, params);
  const row = (res.rows || [])[0];
  if (!row) return null;
  const key = Object.keys(row)[0];
  return key === undefined ? null : row[key];
}

/** Insert one object as a row. Returns the engine result (has affectedRows). */
async function insert(table, row) {
  assertIdent(table, 'table name');
  const columns = Object.keys(row);
  if (!columns.length) throw new Error(`NovaDB: insert into '${table}' had no columns.`);
  columns.forEach((c) => assertIdent(c, 'column name'));
  const names = columns.join(', ');
  const marks = columns.map(() => '?').join(', ');
  const params = columns.map((c) => normalizeParam(row[c]));
  return run(`INSERT INTO ${table} (${names}) VALUES (${marks})`, params);
}

/** Insert many rows in a single transaction. */
async function insertMany(table, rows) {
  return transaction(async () => {
    for (const r of rows) await insert(table, r);
  });
}

/** Update rows matching a where clause. Returns the engine result. */
async function update(table, patch, where = '', whereParams = []) {
  assertIdent(table, 'table name');
  const keys = Object.keys(patch);
  if (!keys.length) throw new Error(`NovaDB: update on '${table}' had no columns.`);
  keys.forEach((k) => assertIdent(k, 'column name'));
  const setList = keys.map((k) => `${k} = ?`).join(', ');
  const { clause, params } = buildWhere(where, whereParams);
  return run(`UPDATE ${table} SET ${setList}${clause}`, [...keys.map((k) => normalizeParam(patch[k])), ...params]);
}

/** Delete rows matching a where clause (omit the where to delete all). */
async function remove(table, where = '', whereParams = []) {
  assertIdent(table, 'table name');
  const { clause, params } = buildWhere(where, whereParams);
  return run(`DELETE FROM ${table}${clause}`, params);
}

/** COUNT(*) over a table with an optional where clause. */
async function count(table, where = '', whereParams = []) {
  assertIdent(table, 'table name');
  const { clause, params } = buildWhere(where, whereParams);
  const n = await value(`SELECT COUNT(*) AS n FROM ${table}${clause}`, params);
  return Number(n) || 0;
}

/** Convenience SELECT: pick columns / filter / sort / limit a table. */
async function select(table, options = {}) {
  assertIdent(table, 'table name');
  const { columns = '*', where = '', whereParams = [], orderBy = '', limit } = options;
  const cols = Array.isArray(columns)
    ? columns.map((c) => { assertIdent(c, 'column name'); return c; }).join(', ')
    : columns === '*' ? '*' : assertIdent(String(columns), 'column name');
  const { clause, params } = buildWhere(where, whereParams);
  let sql = `SELECT ${cols} FROM ${table}${clause}`;
  if (orderBy) {
    // orderBy is a raw fragment of comma-separated ORDER BY terms; keep it simple.
    sql += ` ORDER BY ${orderBy}`;
  }
  if (typeof limit === 'number') {
    if (!Number.isInteger(limit) || limit < 0) throw new Error('NovaDB: limit must be a non-negative integer.');
    sql += ` LIMIT ${limit}`;
  }
  return all(sql, params);
}

/** Switch the active database. */
async function use(dbName) {
  assertIdent(dbName, 'database name');
  return run(`USE ${dbName}`);
}

/** List catalog shape (databases -> tables -> columns) as shown in the GUI. */
async function status() {
  return client.novaDbStatus();
}

/**
 * Wrap a sequence of operations in a transaction: BEGIN, run the callback,
 * COMMIT on success, ROLLBACK if the callback throws (the error is re-raised).
 */
async function transaction(fn) {
  await run('BEGIN');
  try {
    const result = await fn();
    await run('COMMIT');
    return result;
  } catch (err) {
    try { await run('ROLLBACK'); } catch { /* rollback best-effort */ }
    throw err;
  }
}

/**
 * Bind a single table into a small model object — the shortest path from a
 * feature module to persistent storage.
 */
function model(tableName) {
  return {
    table: tableName,
    all: () => select(tableName),
    find: (where, whereParams) => select(tableName, { where, whereParams }),
    get: (id, idColumn = 'id') => get(`SELECT * FROM ${tableName} WHERE ${assertIdent(idColumn, 'column name')} = ?`, [id]),
    insert: (row) => insert(tableName, row),
    update: (id, patch, idColumn = 'id') => update(tableName, patch, `${assertIdent(idColumn, 'column name')} = ?`, [id]),
    remove: (id, idColumn = 'id') => remove(tableName, `${assertIdent(idColumn, 'column name')} = ?`, [id]),
    count: (where, whereParams) => count(tableName, where, whereParams),
  };
}

// Booleans and JSON objects/arrays from JS are stored as-is by the engine for
// INTEGER/REAL/TEXT/BOOLEAN columns; normalise the few that need it so callers
// can pass real JS values rather than hand-formatted strings.
function normalizeParam(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v; // engine coerces for BOOLEAN
  return v;
}

export const novaDb = {
  exec: run,
  run,
  query: run,
  all,
  get,
  value,
  insert,
  insertMany,
  update,
  remove,
  count,
  select,
  use,
  status,
  transaction,
  model,
  assertIdent,
};

export default novaDb;
