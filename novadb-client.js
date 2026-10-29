/**
 * NovaDB client — a dependency-free Node connector you can copy into YOUR OWN
 * project (Express server, script, etc.). It talks to the NovaDB external
 * connector running inside the NovaCode desktop app over loopback TCP.
 *
 * No Electron, no imports from the IDE — pure `node:net`. Uses the same NDJSON
 * wire protocol and shared token as electron/services/novadb/novaDbServer.js.
 *
 * Usage:
 *   import { createNovaDb } from './novadb-client.js';
 *   const novaDb = await createNovaDb({ host: '127.0.0.1', port: 33607, token: '<from NovaCode>' });
 *   await novaDb.use('seth');
 *   await novaDb.insert('teachers', { name: 'Seth', subject: 'Math' });
 *   const rows = await novaDb.all('SELECT * FROM teachers');
 *   await novaDb.close();
 *
 * Safety mirrors the in-app SDK: identifiers are validated to
 * [A-Za-z_][A-Za-z0-9_]* and all VALUES are sent as bind parameters, never
 * concatenated into SQL text.
 */
/* global setTimeout, clearTimeout */
import net from 'node:net';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function assertIdent(name, label = 'identifier') {
  if (typeof name !== 'string' || !IDENT.test(name)) {
    throw new Error(`NovaDB: invalid ${label} '${String(name)}' (use letters, digits or underscore, starting with a letter).`);
  }
  return name;
}

function buildWhere(where, whereParams) {
  if (!where) return { clause: '', params: [] };
  const clause = String(where).trim();
  if (!clause) return { clause: '', params: [] };
  const count = (clause.match(/\?/g) || []).length;
  const params = whereParams || [];
  if (params.length !== count) {
    throw new Error(`NovaDB: WHERE clause has ${count} placeholder(s) but ${params.length} value(s) were provided.`);
  }
  return { clause: ` WHERE ${clause}`, params };
}

function normalizeParam(v) {
  return v === undefined ? null : v;
}

/**
 * @param {{ host?: string, port?: number, token?: string, connectTimeoutMs?: number }} options
 * @returns {Promise<Object>} a connected NovaDB client (connects eagerly so a
 *   bad token/port fails fast).
 */
export async function createNovaDb(options = {}) {
  const client = new NovaDbClient(options);
  await client.connect();
  return client;
}

class NovaDbClient {
  constructor({ host = '127.0.0.1', port = 33607, token, connectTimeoutMs = 5000 } = {}) {
    if (!LOOPBACK.has(host)) throw new Error(`NovaDB client: refusing non-loopback host '${host}'.`);
    this.host = host;
    this.port = port;
    this.token = token;
    this.connectTimeoutMs = connectTimeoutMs;
    this.socket = null;
    this._buffer = '';
    this._id = 0;
    this._pending = new Map();
    this._helloWaiters = null;
  }

  connect() {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      socket.setEncoding('utf8');
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('NovaDB: connection timed out (is the NovaCode app running with the connector enabled?)'));
      }, this.connectTimeoutMs);

      socket.once('error', (err) => { clearTimeout(timer); reject(err); });

      socket.on('data', (chunk) => {
        this._buffer += chunk;
        let nl;
        while ((nl = this._buffer.indexOf('\n')) !== -1) {
          const line = this._buffer.slice(0, nl).trim();
          this._buffer = this._buffer.slice(nl + 1);
          if (line) this._onLine(line);
        }
      });
      socket.on('close', () => {
        this.socket = null;
        // Fail any in-flight requests so callers don't hang forever.
        for (const { reject } of this._pending.values()) reject(new Error('NovaDB: connection closed'));
        this._pending.clear();
      });

      socket.once('connect', () => {
        this.socket = socket;
        clearTimeout(timer);
        // From here on, socket errors are surfaced by the 'close' handler (which
        // rejects in-flight requests); the connect-time 'once' error handler has
        // already done its job and will not refire after a successful connect.
        this._helloWaiters = { resolve, reject };
        this._send({ type: 'hello', token: this.token });
      });
    });
  }

  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    // Handshake acknowledgement.
    if (msg.type === 'hello' && this._helloWaiters) {
      const w = this._helloWaiters; this._helloWaiters = null;
      if (msg.ok) w.resolve(); else w.reject(new Error(msg.error || 'NovaDB handshake failed'));
      return;
    }
    const entry = this._pending.get(msg.id);
    if (!entry) return;
    this._pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result); else entry.reject(new Error(msg.error || 'NovaDB request failed'));
  }

  _send(obj) {
    if (!this.socket || this.socket.destroyed) throw new Error('NovaDB: not connected');
    this.socket.write(JSON.stringify(obj) + '\n');
  }

  /** Send one statement and await the engine result. */
  async run(sql, params = []) {
    await this.connect();
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      try { this._send({ id, sql, params }); }
      catch (err) { this._pending.delete(id); reject(err); }
    });
  }

  async all(sql, params = []) {
    const res = await this.run(sql, params);
    return res.rows || [];
  }

  async get(sql, params = []) {
    const limited = /limit\s+\d+/i.test(sql) ? sql : `${sql} LIMIT 1`;
    const rows = await this.all(limited, params);
    return rows[0] || null;
  }

  async value(sql, params = []) {
    const res = await this.run(sql, params);
    const row = (res.rows || [])[0];
    if (!row) return null;
    const key = Object.keys(row)[0];
    return key === undefined ? null : row[key];
  }

  async insert(table, row) {
    assertIdent(table, 'table name');
    const columns = Object.keys(row);
    if (!columns.length) throw new Error(`NovaDB: insert into '${table}' had no columns.`);
    columns.forEach((c) => assertIdent(c, 'column name'));
    const names = columns.join(', ');
    const marks = columns.map(() => '?').join(', ');
    const params = columns.map((c) => normalizeParam(row[c]));
    return this.run(`INSERT INTO ${table} (${names}) VALUES (${marks})`, params);
  }

  async update(table, patch, where = '', whereParams = []) {
    assertIdent(table, 'table name');
    const keys = Object.keys(patch);
    if (!keys.length) throw new Error(`NovaDB: update on '${table}' had no columns.`);
    keys.forEach((k) => assertIdent(k, 'column name'));
    const setList = keys.map((k) => `${k} = ?`).join(', ');
    const { clause, params } = buildWhere(where, whereParams);
    return this.run(`UPDATE ${table} SET ${setList}${clause}`, [...keys.map((k) => normalizeParam(patch[k])), ...params]);
  }

  async remove(table, where = '', whereParams = []) {
    assertIdent(table, 'table name');
    const { clause, params } = buildWhere(where, whereParams);
    return this.run(`DELETE FROM ${table}${clause}`, params);
  }

  async count(table, where = '', whereParams = []) {
    assertIdent(table, 'table name');
    const { clause, params } = buildWhere(where, whereParams);
    const n = await this.value(`SELECT COUNT(*) AS n FROM ${table}${clause}`, params);
    return Number(n) || 0;
  }

  async select(table, options = {}) {
    assertIdent(table, 'table name');
    const { columns = '*', where = '', whereParams = [], orderBy = '', limit } = options;
    const cols = Array.isArray(columns)
      ? columns.map((c) => { assertIdent(c, 'column name'); return c; }).join(', ')
      : columns === '*' ? '*' : assertIdent(String(columns), 'column name');
    const { clause, params } = buildWhere(where, whereParams);
    let sql = `SELECT ${cols} FROM ${table}${clause}`;
    if (orderBy) sql += ` ORDER BY ${orderBy}`;
    if (typeof limit === 'number') sql += ` LIMIT ${limit}`;
    return this.all(sql, params);
  }

  async use(dbName) {
    assertIdent(dbName, 'database name');
    return this.run(`USE ${dbName}`);
  }

  async status() {
    await this.connect();
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      try { this._send({ id, type: 'status' }); }
      catch (err) { this._pending.delete(id); reject(err); }
    });
  }

  async transaction(fn) {
    await this.run('BEGIN');
    try {
      const result = await fn();
      await this.run('COMMIT');
      return result;
    } catch (err) {
      try { await this.run('ROLLBACK'); } catch { /* best-effort */ }
      throw err;
    }
  }

  model(tableName) {
    return {
      table: tableName,
      all: () => this.select(tableName),
      find: (where, whereParams) => this.select(tableName, { where, whereParams }),
      get: (id, idColumn = 'id') => this.get(`SELECT * FROM ${tableName} WHERE ${assertIdent(idColumn, 'column name')} = ?`, [id]),
      insert: (row) => this.insert(tableName, row),
      update: (id, patch, idColumn = 'id') => this.update(tableName, patch, `${assertIdent(idColumn, 'column name')} = ?`, [id]),
      remove: (id, idColumn = 'id') => this.remove(tableName, `${assertIdent(idColumn, 'column name')} = ?`, [id]),
      count: (where, whereParams) => this.count(tableName, where, whereParams),
    };
  }

  close() {
    if (this.socket) { try { this.socket.end(); this.socket.destroy(); } catch { /* ignore */ } this.socket = null; }
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export default createNovaDb;
