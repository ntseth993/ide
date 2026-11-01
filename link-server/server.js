'use strict';
/**
 * NovaLink Live server — the entry point.
 *
 * Zero npm dependencies on purpose: this environment cannot reach the npm
 * registry, and a chat server whose only external requirement is a Node runtime
 * is easier to deploy and easier to audit. Everything it needs (SQLite, crypto,
 * HTTP, WebSocket framing) is either built into Node 22+ or implemented in this
 * directory.
 *
 * Boot order matters, because the modules form one small cycle:
 *
 *   config -> logger -> store -> limiter -> domain modules -> hub -> events
 *
 * `calls.js` needs to push notifications and `events.js` needs `calls`, so the
 * notifier is injected late through a one-line indirection instead of being
 * untangled with a rewrite.
 */
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const { createConfig, auditConfig } = require('./config');
const { createLogger } = require('./logger');
const { openDatabase } = require('./db');
const { createRateLimiter } = require('./rateLimit');
const { createAccounts } = require('./accounts');
const { createConnections } = require('./connections');
const { createPresence } = require('./presence');
const { createChat } = require('./chat');
const { createAttachments } = require('./attachments');
const { createCalls } = require('./calls');
const { createHub } = require('./hub');
const { createEvents } = require('./events');
const { createRoutes } = require('./routes');
const { createAdmin } = require('./admin');
const { createAdminHub } = require('./adminHub');
const { completeUpgrade } = require('./ws');

const SOCKET_PATH = '/link';

/**
 * A deliberately small .env reader: `KEY=value`, `#` comments, optional quotes.
 * Node's `--env-file` also works; this exists so `npm start` behaves the same
 * way on every machine without a flag nobody remembers to pass.
 */
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const loaded = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    loaded[key] = value;
  }
  // Real environment always wins over the file, so CI and systemd can override.
  return Object.fromEntries(Object.entries(loaded).map(([key, value]) => [key, process.env[key] ?? value]));
}

function startServer(overrides = {}) {
  const env = overrides.env || loadEnvFile(path.join(__dirname, '.env'));
  const config = { ...createConfig(env, overrides), ...overrides.config };

  const logger = overrides.logger || createLogger(config.logLevel);
  for (const warning of auditConfig(config)) logger.warn?.('configuration', { warning });

  if (!config.isLoopback && !config.tls && !config.insecurePlaintextAllowed) {
    // Refusing is better than silently shipping chat traffic in the clear.
    throw new Error(`Refusing to bind ${config.host} over plain HTTP without TLS. Set LINK_TLS_CERT/LINK_TLS_KEY, put a reverse proxy in front and set LINK_TRUST_PROXY=1, or set LINK_ALLOW_PLAINTEXT=1 to override.`);
  }

  fs.mkdirSync(config.dataDir, { recursive: true });
  const store = openDatabase({ filePath: config.dbFile, logger });
  logger.info?.('store open', { file: config.dbFile, schemaVersion: store.version, searchMode: store.searchMode });

  const limiter = createRateLimiter({ config, logger });

  const accounts = createAccounts({ store, config, logger, limiter });
  const connections = createConnections({ store, accounts, logger });
  const presence = createPresence({ accounts, connections, config, logger });
  const chat = createChat({ store, accounts, connections, config, logger });

  // Late-bound: calls.notify is the only way this module reaches a socket.
  let notifier = () => 0;
  const calls = createCalls({ store, chat, connections, accounts, presence, config, logger, notifier: (...args) => notifier(...args) });
  const attachments = createAttachments({ store, chat, connections, accounts, config, logger });

  const hub = createHub({
    store,
    accounts,
    presence,
    connections,
    config,
    logger,
    limiter,
    onEvent: (record, message) => events.onEvent(record, message),
    onAuthed: (record) => events.onAuthed(record),
    onClosed: (record, info) => { events.onClosed(record, info); adminHub?.onSocketClosed(record); },
    // A heartbeat can demote someone to "away" without any client asking: the only
    // way a contact's green dot changes on its own is for the server to say so.
    onPresenceDrift: (userId) => events.notifyPresence(userId, events.contactsAudience(userId)),
  });

  const events = createEvents({ accounts, connections, presence, chat, calls, hub, logger });
  notifier = (type, userIds, payload, options) => events.notify(type, userIds, payload, options);

  // Classroom Monitor: admin module + WS fan-out
  const admin = createAdmin({ store, accounts, config, logger });
  const adminHub = createAdminHub({ store, admin, hub, accounts, logger });
  // Merge classroom frame handlers into the events dispatcher
  for (const [frameType, handler] of Object.entries(adminHub.frameHandlers())) {
    events.addEventHandler(frameType, handler);
  }

  const routes = createRoutes({
    store, accounts, connections, presence, chat, attachments, calls, hub, events, config, logger, limiter, admin,
  });
  admin.registerRoutes(routes.router);

  const handler = (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || `${config.host}:${config.port}`}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":{"code":"bad_request","message":"Malformed request URI.","status":400}}');
      return;
    }
    // Serve the admin dashboard HTML at /admin
    if (url.pathname === '/admin' && req.method === 'GET') {
      const htmlPath = path.join(__dirname, 'admin-ui.html');
      try {
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Admin UI not found.');
      }
      return;
    }
    routes.dispatch(req, res, url);
  };

  const tlsOptions = config.tls
    ? { cert: fs.readFileSync(config.tls.cert), key: fs.readFileSync(config.tls.key) }
    : null;
  const server = tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler);

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch { /* refused below */ }
    const ip = (config.trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
    if (pathname !== SOCKET_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!limiter.take('upgrade', ip).allowed) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }
    const link = completeUpgrade(req, socket, {
      maxFrameBytes: config.limits.maxFrameBytes,
      maxMessageBytes: Math.min(config.limits.maxJsonBytes * 4, 4 * 1024 * 1024),
      head,
    });
    if (!link) return;
    hub.attachSocket(link, { ip });
  });

  // Node's own request-level protections. Deliberately NOT a socket idle
  // timeout: a WebSocket is supposed to sit quiet between heartbeats, and an
  // idle timer here would kill connections the hub has only just pinged.
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;

  server.on('clientError', (error, socket) => {
    logger.warn?.('client error', { error: error.message });
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  hub.start();
  const sweeps = setInterval(() => {
    try {
      attachments.sweep();
    } catch (error) {
      logger.error?.('attachment sweep failed', { error: String(error.message || error) });
    }
    try {
      admin.pruneEvents();
    } catch (error) {
      logger.error?.('activity prune failed', { error: String(error.message || error) });
    }
  }, 15 * 60 * 1000);
  sweeps.unref?.();

  let closed = false;
  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    clearInterval(sweeps);
    hub.stop();
    // Not just closeAll(): an `active` row that survives this process would be
    // handed back to a reconnecting client as a live call it is no longer in.
    const shutting = calls.onShutdown();
    if (shutting.closed) logger.info?.('calls closed on shutdown', { calls: shutting.closed });
    return new Promise((resolve) => {
      server.close(() => {
        try { store.close(); } catch { /* already closed */ }
        resolve();
      });
      // Keep-alive HTTP sockets are idle by definition, so release them at once:
      // without this a shutdown waits for Node's keep-alive timeout, and a
      // `systemctl stop` or a restart between two test boots looks like a hang.
      server.closeIdleConnections?.();
      // Never hang a test suite on a keep-alive socket that will not close.
      setTimeout(() => {
        server.closeAllConnections?.();
      }, 500).unref?.();
      setTimeout(() => {
        try { store.close(); } catch { /* already closed */ }
        resolve();
      }, 2000).unref?.();
    });
  }

  return { server, config, store, logger, hub, routes, limiter, close, events, attachments, chat, calls, accounts, connections, presence, admin, adminHub };
}

/** `npm start` entry. Programmatic callers use startServer() and close(). */
async function main() {
  const portArg = process.argv.find((arg) => arg.startsWith('--port='));
  const hostArg = process.argv.find((arg) => arg.startsWith('--host='));
  const instance = startServer({
    port: portArg ? Number(portArg.split('=')[1]) : undefined,
    host: hostArg ? hostArg.split('=')[1] : undefined,
  });
  await new Promise((resolve, reject) => {
    instance.server.once('error', reject);
    instance.server.listen(instance.config.port, instance.config.host, resolve);
  });
  const scheme = instance.config.tls ? 'https' : 'http';
  instance.logger.info?.('NovaLink Live listening', {
    url: `${scheme}://${instance.config.host}:${instance.config.port}`,
    socket: `${instance.config.tls ? 'wss' : 'ws'}://${instance.config.host}:${instance.config.port}${SOCKET_PATH}`,
    routes: instance.routes.routeCount(),
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      instance.logger.info?.('shutting down', { signal });
      await instance.close();
      process.exit(0);
    });
  }
  process.on('unhandledRejection', (reason) => instance.logger.error?.('unhandled rejection', { reason: String(reason) }));
  return instance;
}

module.exports = { startServer, main, SOCKET_PATH, loadEnvFile };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`NovaLink Live failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
}
