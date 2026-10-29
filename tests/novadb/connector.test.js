/**
 * NovaDB external connector tests (Stage 4).
 *
 * These start a REAL loopback TCP server (electron/services/novadb/novaDbServer.js)
 * backed by a real NovaDB service on a temp file, then drive it with the
 * standalone copy-in client (novadb-client.js) over an actual socket. Nothing is
 * mocked: if the wire protocol, the token handshake, or the bind-parameter
 * round-trip breaks, these tests fail.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createNovaDbService } from '../../electron/services/novadb/novaDbService';
import { createNovaDbServer } from '../../electron/services/novadb/novaDbServer';
import { createNovaDb } from '../../novadb-client.js';

const quiet = { info() {}, warn() {}, error() {} };

let dir;
let dbFile;
let cfgFile;
let service;
let server;
const clients = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novadb-conn-'));
  dbFile = path.join(dir, 'novacode-novadb.json');
  cfgFile = path.join(dir, 'novacode-novadb-connector.json');
  service = createNovaDbService({ filePath: dbFile, logger: quiet });
  server = createNovaDbServer({ db: service, configPath: cfgFile, logger: quiet });
  clients.length = 0;
});

afterEach(async () => {
  for (const c of clients) { try { c.close(); } catch { /* ignore */ } }
  await server.stop();
  service.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Enable the connector on an ephemeral port and connect a client with its token. */
async function connect(overrides = {}) {
  const st = await server.configure({ enabled: true, port: 0 });
  const client = await createNovaDb({ host: '127.0.0.1', port: st.port, token: st.token, ...overrides });
  clients.push(client);
  return { client, serverStatus: st };
}

describe('novadb external connector — server + client over loopback', () => {
  it('completes the handshake and answers a status request', async () => {
    const { client, serverStatus } = await connect();
    expect(serverStatus.running).toBe(true);
    expect(serverStatus.host).toBe('127.0.0.1');
    const status = await client.status();
    expect(status).toHaveProperty('ready', true);
    expect(status).toHaveProperty('databases');
  });

  it('runs real DDL/DML through the socket, including bind params', async () => {
    const { client } = await connect();
    await client.run('CREATE DATABASE seth');
    await client.use('seth');
    await client.run('CREATE TABLE teachers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, subject TEXT)');

    const ins = await client.insert('teachers', { name: 'Seth', subject: 'Math' });
    expect(ins.affectedRows).toBe(1);
    // A quote-heavy value is bound, never concatenated: it stays data.
    await client.insert('teachers', { name: "O'Brien", subject: "Art; DROP TABLE teachers;--" });

    const rows = await client.all('SELECT name FROM teachers ORDER BY id');
    expect(rows.map((r) => r.name)).toEqual(['Seth', "O'Brien"]);
    expect(await client.count('teachers')).toBe(2);

    const one = await client.get('SELECT name FROM teachers WHERE name = ?', ["O'Brien"]);
    expect(one.name).toBe("O'Brien");
    // The injected DDL did not execute — the table still exists.
    expect((await client.all('SELECT * FROM teachers')).length).toBe(2);
  });

  it('enforces a foreign key across the socket and surfaces the error', async () => {
    const { client } = await connect();
    await client.run('CREATE DATABASE seth');
    await client.use('seth');
    await client.run('CREATE TABLE teachers (id INTEGER PRIMARY KEY, name TEXT)');
    await client.run('CREATE TABLE classes (id INTEGER PRIMARY KEY, title TEXT, teacher_id INTEGER REFERENCES teachers(id))');

    await client.insert('teachers', { name: 'Seth' });
    await client.insert('classes', { title: 'Algebra', teacher_id: 1 });
    const joined = await client.all('SELECT c.title, t.name FROM classes c JOIN teachers t ON c.teacher_id = t.id');
    expect(joined).toEqual([{ title: 'Algebra', name: 'Seth' }]);

    // A dangling FK must reject with a clean (non-stack) message over the wire.
    await expect(client.insert('classes', { title: 'Ghost', teacher_id: 999 })).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('rejects a wrong token during the handshake', async () => {
    const st = await server.configure({ enabled: true, port: 0 });
    await expect(
      createNovaDb({ host: '127.0.0.1', port: st.port, token: 'not-the-real-token', connectTimeoutMs: 3000 }),
    ).rejects.toThrow(/Authentication failed/i);
  });

  it('fails fast when nothing is listening (the "not connected" path)', async () => {
    await server.configure({ enabled: true, port: 0 });
    const st = server.status();
    await server.stop();
    await expect(
      createNovaDb({ host: '127.0.0.1', port: st.port, token: st.token, connectTimeoutMs: 3000 }),
    ).rejects.toThrow();
  });

  it('refuses a non-loopback host on the client', async () => {
    await expect(createNovaDb({ host: '8.8.8.8', port: 33607, token: 'x' })).rejects.toThrow(/loopback/i);
  });
});
