/**
 * NovaDB storage service tests (Stage 2 — persistence).
 *
 * These run the real service against a temp file on disk: statements made
 * through one instance must survive when a fresh instance loads the same file.
 * No mocks — if persistence is broken these tests fail.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createNovaDbService } from '../../electron/services/novadb/novaDbService';

let dir;
let filePath;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novadb-test-'));
  filePath = path.join(dir, 'novacode-novadb.json');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('novadb service — persistence', () => {
  it('creates a database + table + rows and reloads them from disk', () => {
    const svc = createNovaDbService({ filePath });
    svc.execute('CREATE DATABASE appdb');
    svc.execute('USE appdb');
    svc.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE, active BOOLEAN)');
    svc.execute("INSERT INTO users (email, active) VALUES ('a@x.com', 'true')");
    svc.execute("INSERT INTO users (email, active) VALUES ('b@x.com', 'false')");
    svc.flush(); // force synchronous write for the test

    // A brand-new service reading the same file must see the same data.
    const reloaded = createNovaDbService({ filePath });
    const status = reloaded.status();
    expect(status.current).toBe('appdb');
    const db = status.databases.find((d) => d.name === 'appdb');
    expect(db).toBeTruthy();
    const users = db.tables.find((t) => t.name === 'users');
    expect(users.rowCount).toBe(2);

    const rows = reloaded.execute('SELECT email FROM users ORDER BY id').rows;
    expect(rows.map((r) => r.email)).toEqual(['a@x.com', 'b@x.com']);
  });

  it('reports an overview without shipping full rows to the status payload', () => {
    const svc = createNovaDbService({ filePath });
    svc.execute('CREATE DATABASE shop');
    svc.execute('USE shop');
    svc.execute('CREATE TABLE products (sku TEXT PRIMARY KEY, price REAL)');
    svc.execute("INSERT INTO products (sku, price) VALUES ('X1', 9.99)");
    const status = svc.status();
    const table = status.databases[0].tables[0];
    expect(table).toHaveProperty('rowCount', 1);
    expect(table).toHaveProperty('columns');
    expect(table).not.toHaveProperty('rows'); // overview is shape-only
    expect(status.storagePath).toBe(filePath);
  });

  it('survives a missing file (first run) and a corrupt file', () => {
    const fresh = createNovaDbService({ filePath });
    expect(fresh.status().databases).toEqual([]);

    fs.writeFileSync(filePath, '{ this is not valid json', 'utf8');
    const svc = createNovaDbService({ filePath, logger: { warn() {}, error() {} } });
    // Corrupt file is ignored; the engine starts empty and stays usable.
    expect(svc.status().databases).toEqual([]);
    svc.execute('CREATE DATABASE recovered');
    expect(svc.status().databases.map((d) => d.name)).toContain('recovered');
  });

  it('does not write on read-only statements', () => {
    const svc = createNovaDbService({ filePath });
    svc.execute('CREATE DATABASE ro');
    svc.execute('USE ro');
    svc.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT)');
    svc.execute("INSERT INTO t (n) VALUES ('one')");
    svc.flush();
    const before = fs.statSync(filePath).size;

    // A SELECT should not schedule a flush; force the timer window to pass.
    svc.execute('SELECT * FROM t');
    return new Promise((resolve) => setTimeout(resolve, 250)).then(() => {
      expect(fs.statSync(filePath).size).toBe(before);
    });
  });

  it('binds parameters for safe value insertion', () => {
    const svc = createNovaDbService({ filePath });
    svc.execute('CREATE DATABASE p');
    svc.execute('USE p');
    svc.execute('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
    svc.execute('INSERT INTO notes (body) VALUES (?)', ["Robert'); DROP TABLE notes;--"]);
    const rows = svc.execute('SELECT body FROM notes').rows;
    expect(rows[0].body).toBe("Robert'); DROP TABLE notes;--");
    // The table still exists — the value was data, never executed as SQL.
    expect(svc.status().databases[0].tables.map((t) => t.name)).toContain('notes');
  });
});
