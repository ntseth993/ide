'use strict';
/**
 * NovaDB external connector (Stage 4) — a loopback TCP server that lets a
 * SEPARATE Node/Express program talk to the same NovaDB engine the Database
 * workspace and the `novadb` terminal command use.
 *
 * Design & security boundaries (deliberate, no mocks):
 *   - Binds loopback ONLY (127.0.0.1 / ::1). Any non-loopback host is rejected;
 *     this never opens the database to the network.
 *   - Requires a shared secret `token` per connection. The token is generated
 *     once and stored in a small config file under userData; the client must
 *     present it in a `hello` handshake before any statement runs.
 *   - Uses a simple newline-delimited JSON (NDJSON) protocol and delegates every
 *     statement to the existing db service (engine.js), which already refuses to
 *     evaluate input — no eval, values are bind parameters.
 *
 * Protocol (one JSON object per line):
 *   client -> server: { "type": "hello", "token": "<secret>" }   (must be first)
 *                     { "id": <n>, "sql": "<stmt>", "params": [] }
 *                     { "id": <n>, "type": "status" }
 *   server -> client: { "type": "hello", "ok": true }            (handshake ack)
 *                     { "id": <n>, "ok": true,  "result": {...} }
 *                     { "id": <n>, "ok": false, "error": "<msg>" }
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PORT = 33607;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const MAX_LINE_BYTES = 1024 * 1024; // 1 MiB per request line — a cheap DoS guard.

/** Generate a URL-safe random token. */
function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * @param {{
 *   db: { execute: Function, status: Function },
 *   configPath: string,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 * }} options
 */
function createNovaDbServer({ db, configPath, logger = console } = {}) {
  if (!db || typeof db.execute !== 'function' || typeof db.status !== 'function') {
    throw new Error('novaDbServer requires a db service with execute() and status().');
  }

  let config = loadConfig();
  let server = null;
  const sockets = new Set();

  // --- config persistence ----------------------------------------------------
  function loadConfig() {
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      saved = {}; // first run — no file yet
    }
    const host = LOOPBACK.has(saved.host) ? saved.host : '127.0.0.1';
    return {
      enabled: Boolean(saved.enabled),
      host,
      port: Number.isInteger(saved.port) && saved.port >= 0 && saved.port <= 65535 ? saved.port : DEFAULT_PORT,
      token: typeof saved.token === 'string' && saved.token ? saved.token : newToken(),
    };
  }

  function saveConfig() {
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    } catch (error) {
      logger.error?.('novadb server config persist failed', { error: error.message });
    }
  }

  // --- connection handling ---------------------------------------------------
  function send(socket, obj) {
    try { socket.write(JSON.stringify(obj) + '\n'); } catch { /* socket already gone */ }
  }

  function handleMessage(socket, msg) {
    const id = msg && msg.id !== undefined ? msg.id : null;
    try {
      if (msg && msg.type === 'status') {
        send(socket, { id, ok: true, result: db.status() });
        return;
      }
      if (typeof msg.sql !== 'string' || !msg.sql.trim()) {
        send(socket, { id, ok: false, error: 'A SQL statement is required.' });
        return;
      }
      const params = Array.isArray(msg.params) ? msg.params : [];
      const result = db.execute(msg.sql, params);
      send(socket, { id, ok: true, result });
    } catch (error) {
      // Engine errors (parse/constraint/etc.) are returned as clean messages,
      // exactly like the in-app IPC path — never a stack trace.
      send(socket, { id, ok: false, error: error.message || String(error) });
    }
  }

  function onConnection(socket) {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let authed = false;

    socket.on('data', (chunk) => {
      buffer += chunk;
      // Guard against an unbounded buffer from a misbehaving client.
      if (buffer.length > MAX_LINE_BYTES * 8) { socket.destroy(); return; }
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          if (line.length > MAX_LINE_BYTES) { socket.destroy(); return; }
          msg = JSON.parse(line);
        } catch {
          if (authed) send(socket, { id: null, ok: false, error: 'Malformed request line.' });
          continue;
        }
        if (!authed) {
          if (msg && msg.type === 'hello' && typeof msg.token === 'string' && timingSafeEqual(msg.token, config.token)) {
            authed = true;
            send(socket, { type: 'hello', ok: true });
          } else {
            send(socket, { type: 'hello', ok: false, error: 'Authentication failed.' });
            socket.destroy();
          }
          continue;
        }
        handleMessage(socket, msg);
      }
    });

    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  }

  // --- lifecycle -------------------------------------------------------------
  function start() {
    return new Promise((resolve, reject) => {
      if (server) { resolve(status()); return; }
      if (!LOOPBACK.has(config.host)) { reject(new Error('NovaDB server may only bind loopback.')); return; }
      const srv = net.createServer(onConnection);
      srv.once('error', (error) => {
        logger.error?.('novadb server failed to listen', { error: error.message });
        reject(error);
      });
      srv.listen(config.port, config.host, () => {
        server = srv;
        const addr = srv.address();
        if (addr) config.port = addr.port; // resolve ephemeral (0) to the real port
        saveConfig();
        logger.info?.('novadb server listening', { host: config.host, port: config.port });
        resolve(status());
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      if (!server) { resolve(status()); return; }
      for (const s of sockets) { try { s.destroy(); } catch { /* ignore */ } }
      sockets.clear();
      const srv = server;
      server = null;
      srv.close(() => {
        logger.info?.('novadb server stopped');
        resolve(status());
      });
    });
  }

  function status() {
    return {
      running: Boolean(server),
      enabled: config.enabled,
      host: config.host,
      port: config.port,
      token: config.token, // shared secret the user copies into their program
    };
  }

  /** Enable/disable + optional port change; persists config and (re)starts. */
  async function configure({ enabled, port, regenerateToken } = {}) {
    if (typeof enabled === 'boolean') config.enabled = enabled;
    if (Number.isInteger(port) && port >= 0 && port <= 65535) config.port = port;
    if (regenerateToken) config.token = newToken();
    saveConfig();
    // Reflect the new enabled state on the wire.
    if (config.enabled) await start();
    else await stop();
    return status();
  }

  function dispose() {
    for (const s of sockets) { try { s.destroy(); } catch { /* ignore */ } }
    sockets.clear();
    if (server) { try { server.close(); } catch { /* ignore */ } server = null; }
  }

  return { start, stop, status, configure, dispose };
}

/** Constant-time string compare to avoid leaking the token via timing. */
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { createNovaDbServer, DEFAULT_PORT, LOOPBACK };
