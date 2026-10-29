/**
 * NovaDB + Express — a STANDALONE integration example (no `src` folder needed).
 *
 * This file lives in YOUR project, next to a single copied-in dependency:
 *     novadb-client.js   (pure Node, no Electron — copy it next to this file)
 *
 * WHAT IT DOES
 *   1. Connects to NovaDB over the External Connector and prints either
 *      `connected` or `not connected`.
 *   2. Ensures the database `seth` and its tables exist (idempotent).
 *   3. Serves REST CRUD routes that read/write NovaDB directly — NOT an
 *      in-memory array — for `teachers` and a related `classes` table.
 *   4. Demonstrates a foreign-key relationship, a JOIN query and a transaction.
 *
 * HOW TO MAKE IT SAY `connected`
 *   NovaDB's engine runs inside the NovaCode desktop app. This program reaches
 *   it through the app's External Connector (a loopback-only TCP server), so:
 *     1. Open NovaCode, go to the Database workspace.
 *     2. Expand "Integrate with your project" and enable the External Connector.
 *     3. Copy the HOST / PORT / TOKEN it shows and paste them below (or export
 *        them as NOVADB_HOST / NOVADB_PORT / NOVADB_TOKEN environment variables).
 *     4. Keep NovaCode running, then: `node novadb-express-example.js`
 *   If NovaCode is closed, the connector is off, or the token is wrong, this
 *   correctly prints `not connected` — that is the whole point of the check.
 *
 * NOTE: this is an ES module. Add `"type": "module"` to your package.json or
 * rename the file to `.mjs`.
 */

/* global console, process */

import express from 'express';
// The only dependency: a copy of the standalone NovaDB client (see novadb-client.js).
import { createNovaDb } from './novadb-client.js';

// ── Connection settings — copy these from NovaCode (see header above) ────────
const HOST = process.env.NOVADB_HOST || '127.0.0.1';
const PORT = Number(process.env.NOVADB_PORT || 33607);
const TOKEN = process.env.NOVADB_TOKEN || 'PASTE_TOKEN_FROM_NOVACODE_HERE';

const DB = 'seth';
const TEACHERS = 'teachers';
const CLASSES = 'classes';

/** The connected NovaDB client (set by connect()); null until it succeeds. */
let novaDb = null;

/** Connect over the External Connector and create the schema if missing. */
async function connect() {
  try {
    if (!TOKEN || TOKEN === 'PASTE_TOKEN_FROM_NOVACODE_HERE') {
      throw new Error('no token set — copy it from NovaCode > Database > Integrate > External Connector');
    }
    // createNovaDb connects eagerly: a closed app / wrong port / bad token all
    // reject here, so we never end up "connected" against nothing.
    novaDb = await createNovaDb({ host: HOST, port: PORT, token: TOKEN });
    await novaDb.status(); // round-trips the authenticated handshake

    // Make sure the database exists, then switch into it.
    await novaDb.run(`CREATE DATABASE IF NOT EXISTS ${DB}`);
    await novaDb.use(DB);

    // Idempotent schema: teachers, and classes with a FK to teachers(id).
    await novaDb.run(
      `CREATE TABLE IF NOT EXISTS ${TEACHERS} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, subject TEXT)`,
    );
    await novaDb.run(
      `CREATE TABLE IF NOT EXISTS ${CLASSES} (id INTEGER PRIMARY KEY, title TEXT NOT NULL, teacher_id INTEGER REFERENCES ${TEACHERS}(id))`,
    );

    console.log('connected');
    return true;
  } catch (err) {
    console.log('not connected:', err.message || err);
    return false;
  }
}

async function main() {
  const connected = await connect();
  const app = express();
  app.use(express.json());

  // A tiny status endpoint so you can see the connection result from a browser.
  app.get('/', (req, res) => res.json({ connected, database: DB, tables: [TEACHERS, CLASSES] }));

  if (connected) {
    // ---- teachers: CREATE ----------------------------------------------------
    app.post('/teachers', async (req, res) => {
      try {
        const r = await novaDb.insert(TEACHERS, { name: req.body.name, subject: req.body.subject ?? null });
        res.status(201).json({ created: r.affectedRows, teacher: { name: req.body.name, subject: req.body.subject ?? null } });
      } catch (e) {
        res.status(400).json({ error: e.message || String(e) });
      }
    });

    // ---- teachers: READ all --------------------------------------------------
    app.get('/teachers', async (req, res) => {
      res.json(await novaDb.all(`SELECT * FROM ${TEACHERS}`));
    });

    // ---- teachers: READ one --------------------------------------------------
    app.get('/teachers/:id', async (req, res) => {
      const row = await novaDb.get(`SELECT * FROM ${TEACHERS} WHERE id = ?`, [Number(req.params.id)]);
      if (!row) return res.status(404).json({ message: 'teacher not found' });
      res.json(row);
    });

    // ---- teachers: UPDATE ----------------------------------------------------
    app.put('/teachers/:id', async (req, res) => {
      const r = await novaDb.update(
        TEACHERS,
        { name: req.body.name, subject: req.body.subject },
        'id = ?',
        [Number(req.params.id)],
      );
      res.json({ updated: r.affectedRows });
    });

    // ---- teachers: DELETE (blocked by FK if classes still reference them) ----
    app.delete('/teachers/:id', async (req, res) => {
      try {
        const r = await novaDb.remove(TEACHERS, 'id = ?', [Number(req.params.id)]);
        res.json({ deleted: r.affectedRows });
      } catch (e) {
        res.status(409).json({ error: e.message || String(e) });
      }
    });

    // ---- classes: CREATE (proves the foreign key is enforced) ----------------
    app.post('/classes', async (req, res) => {
      try {
        const r = await novaDb.insert(CLASSES, { title: req.body.title, teacher_id: Number(req.body.teacher_id) });
        res.status(201).json({ created: r.affectedRows });
      } catch (e) {
        // A teacher_id with no matching teacher throws a FOREIGN KEY error here.
        res.status(400).json({ error: e.message || String(e) });
      }
    });

    // ---- classes: READ across the relationship with a JOIN -------------------
    app.get('/classes/with-teacher', async (req, res) => {
      const rows = await novaDb.all(
        `SELECT c.id, c.title, t.name AS teacher FROM ${CLASSES} c JOIN ${TEACHERS} t ON c.teacher_id = t.id`,
      );
      res.json(rows);
    });

    // ---- a transaction: insert a teacher AND its first class atomically ------
    app.post('/teachers/with-class', async (req, res) => {
      try {
        await novaDb.transaction(async () => {
          await novaDb.insert(TEACHERS, { name: req.body.name, subject: req.body.subject ?? null });
          const teacher = await novaDb.get(
            `SELECT id FROM ${TEACHERS} WHERE name = ? ORDER BY id DESC LIMIT 1`,
            [req.body.name],
          );
          await novaDb.insert(CLASSES, { title: req.body.classTitle || 'Untitled class', teacher_id: teacher.id });
        });
        res.status(201).json({ ok: true });
      } catch (e) {
        res.status(400).json({ error: e.message || String(e) });
      }
    });
  }

  const server = app.listen(5000, () => console.log('Server running at http://localhost:5000'));

  // Close the NovaDB socket and the HTTP server cleanly on Ctrl+C.
  function shutdown() {
    console.log('\nshutting down');
    try { novaDb?.close?.(); } catch { /* ignore */ }
    server.close(() => process.exit(0));
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
