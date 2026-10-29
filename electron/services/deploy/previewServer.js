'use strict';
/**
 * Preview server — serve a project's build output over LOOPBACK only.
 *
 * Lets the Deploy workspace open the freshly-built site in a real browser
 * (http://127.0.0.1:<ephemeral port>) without any third-party tool. It is a
 * tiny static file server, deliberately narrow:
 *   - Binds 127.0.0.1 only and an ephemeral port, so nothing is exposed on the
 *     network and it never collides with a fixed port.
 *   - Serves only files under the one directory chosen at start(), resolved
 *     through pathGuard.resolveWithin; path traversal and dotfiles are refused.
 *   - SPA fallback: a request that looks like a route (no file extension, not a
 *     dotfile) resolves to index.html when present, mirroring how hosts like
 *     Netlify/Vercel serve client-routed apps.
 */
const http = require('http');
const fsp = require('fs').promises;
const path = require('path');
const { resolveWithin } = require('../pathGuard');

const HOST = '127.0.0.1';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function typeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function createPreviewServer({ logger = console } = {}) {
  let server = null;
  let info = null; // { url, port, rootDir }
  const sockets = new Set();

  async function sendFile(res, filePath) {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, { 'content-type': typeFor(filePath), 'content-length': data.length, 'cache-control': 'no-cache' });
    res.end(data);
  }

  async function handle(req, res) {
    if (!info) { res.writeHead(503); res.end('Preview is not running.'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end('Method not allowed.'); return; }

    let rel;
    try {
      const url = new URL(req.url, `http://${HOST}`);
      rel = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400); res.end('Bad request path.'); return;
    }
    if (rel.includes('\u0000')) { res.writeHead(400); res.end('Bad request path.'); return; }
    if (rel === '/' || rel === '') rel = '/index.html';
    const candidate = rel.replace(/^\/+/, '');

    let target;
    try {
      target = resolveWithin(info.rootDir, candidate); // throws if it escapes rootDir
    } catch {
      res.writeHead(403); res.end('Forbidden.'); return;
    }

    // Refuse dotfiles / dot-directories (e.g. .git, .novacode) from the web.
    const within = path.relative(info.rootDir, target);
    if (within.split(path.sep).some((seg) => seg.startsWith('.') && seg !== '.')) {
      res.writeHead(404); res.end('Not found.'); return;
    }

    try {
      let stat = await fsp.stat(target);
      if (stat.isDirectory()) {
        target = path.join(target, 'index.html');
        stat = await fsp.stat(target);
      }
      await sendFile(res, target);
      return;
    } catch {
      /* fall through to SPA fallback / 404 */
    }

    // SPA fallback for extension-less routes.
    if (!path.extname(candidate)) {
      try {
        const index = path.join(info.rootDir, 'index.html');
        await fsp.access(index);
        await sendFile(res, index);
        return;
      } catch { /* no index — 404 */ }
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found.');
  }

  function publicStatus() {
    return { running: Boolean(server), url: info ? info.url : null, port: info ? info.port : null };
  }

  /** Stop any running preview, then serve `dir` (confined to `root`). */
  async function start({ root, dir } = {}) {
    await stop();
    const target = resolveWithin(root, dir || root);
    let stat;
    try { stat = await fsp.stat(target); } catch { throw new Error('That folder does not exist yet. Build the project first.'); }
    if (!stat.isDirectory()) throw new Error('Preview needs a folder, not a file.');

    return new Promise((resolve, reject) => {
      const srv = http.createServer(handle);
      srv.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => sockets.delete(socket)); });
      srv.once('error', (error) => { logger.error?.('preview server error', { error: error.message }); reject(error); });
      srv.listen(0, HOST, () => {
        server = srv;
        const port = srv.address().port;
        info = { url: `http://${HOST}:${port}/`, port, rootDir: target };
        logger.info?.('preview server listening', { url: info.url, rootDir: target });
        resolve(publicStatus());
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      if (!server) { resolve(publicStatus()); return; }
      const srv = server;
      server = null;
      info = null;
      for (const s of sockets) { try { s.destroy(); } catch { /* ignore */ } }
      sockets.clear();
      srv.close(() => { logger.info?.('preview server stopped'); resolve(publicStatus()); });
    });
  }

  function dispose() {
    for (const s of sockets) { try { s.destroy(); } catch { /* ignore */ } }
    sockets.clear();
    if (server) { try { server.close(); } catch { /* ignore */ } }
    server = null;
    info = null;
  }

  return { start, stop, status: publicStatus, dispose };
}

module.exports = { createPreviewServer, HOST, MIME };
