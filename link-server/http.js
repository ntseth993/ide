'use strict';
/**
 * The HTTP layer: routing, request bodies, responses and the security headers.
 *
 * Deliberately boring, because this is the part a stranger talks to:
 *   - a route table with typed parameters, no regex soup per call site
 *   - JSON bodies capped in bytes *while streaming* (a declared Content-Length
 *     is never trusted as the truth)
 *   - uploads are streamed by `attachments.js`, which counts bytes as they arrive
 *   - one place that turns an ApiError into a status + safe message
 *   - the client IP taken from the socket unless the operator explicitly says a
 *     reverse proxy is in front, because trusting X-Forwarded-For by default is
 *     how rate limits become decorative
 */
const { ApiError } = require('./validate');

const JSON_TYPES = new Set(['application/json', 'text/json']);

function securityHeaders(res, { nonce } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', `default-src 'none'; frame-ancestors 'none'; base-uri 'none'${nonce ? `; script-src 'nonce-${nonce}'` : ''}`);
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function sendJson(res, status, payload, { corsOrigin } = {}) {
  if (corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Vary', 'Origin');
  }
  const body = status === 204 ? null : JSON.stringify(payload ?? {});
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  if (body) res.end(body); else res.end();
}

function sendError(res, error, { corsOrigin } = {}) {
  const known = error instanceof ApiError;
  const status = known ? error.status : 500;
  const payload = known
    ? error.toJSON().error
    : { code: 'internal_error', message: 'The server failed to handle this request.', status: 500 };
  sendJson(res, status, { error: payload }, { corsOrigin });
  return { known, error };
}

/**
 * Answer a request we refuse to keep reading, then close the connection.
 *
 * Two things here are load-bearing, and both were wrong in the first version:
 *
 *   - the answer has to be *delivered*. `socket.destroy()` right after `res.end()`
 *     sends an RST, and an RST discards bytes the peer has not read yet - including
 *     the 413 we just wrote. The client then reports a network failure instead of
 *     the refusal, which is precisely the distinction a file-upload UI has to show.
 *     So the socket is drained and closed cleanly instead.
 *   - the error is marked `answered` so the dispatcher logs it and does not write a
 *     second response onto the same socket.
 *
 * Draining the remainder costs bandwidth, not memory: nothing is buffered, and a
 * client that never finishes is cut off by the timer.
 */
function refuseBody({ req, res }, error, { corsOrigin } = {}) {
  req.pause?.();
  if (!res.headersSent) {
    res.writeHead(error.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Connection': 'close',
      ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin, 'Vary': 'Origin' } : {}),
    });
    res.end(JSON.stringify({ error: error.toJSON().error }));
  }
  const socket = req.socket;
  const giveUp = () => { try { socket.destroy(); } catch { /* already gone */ } };
  const timer = setTimeout(giveUp, 5000);
  timer.unref?.();
  const close = () => {
    clearTimeout(timer);
    try { socket.end(); } catch { /* already gone */ }
  };
  res.on('finish', () => {
    req.resume();
    req.on('end', close);
    req.on('close', close);
  });
  error.answered = true;
  return error;
}

/** Read a capped JSON body. Never trusts Content-Length: it counts real bytes. */
function readJsonBody(req, res, { maxBytes, corsOrigin } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        chunks.length = 0;
        finish(refuseBody({ req, res }, new ApiError(413, 'payload_too_large', `Request body exceeds ${maxBytes} bytes.`), { corsOrigin }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (received === 0) return finish(null, {});
      try {
        finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        finish(new ApiError(400, 'invalid_json', `Request body is not valid JSON: ${error.message}`));
      }
    });
    req.on('error', (error) => finish(new ApiError(400, 'request_failed', error.message)));
  });
}

/** Minimal `:param` router. Order matters: literal segments beat wildcards. */
function createRouter() {
  const routes = [];

  function add(method, pattern, handler, options = {}) {
    const segments = pattern.split('/').filter(Boolean);
    routes.push({ method: method.toUpperCase(), segments, handler, options, pattern });
  }

  function match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    let methodMismatch = false;
    for (const route of routes) {
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i += 1) {
        const seg = route.segments[i];
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) { ok = false; break; }
      }
      if (!ok) continue;
      if (route.method !== method.toUpperCase()) { methodMismatch = true; continue; }
      return { route, params };
    }
    if (methodMismatch) throw new ApiError(405, 'method_not_allowed', `${method} is not allowed on ${pathname}.`);
    return null;
  }

  return { add, match, routes };
}

/**
 * Build the request context shared by every handler.
 * @returns {{ ctx: object, done: Promise<object> }}
 */
function createContext({ req, res, url, config, accounts, logger }) {
  const forwarded = config.trustProxy
    ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    : '';
  const ip = forwarded || req.socket.remoteAddress || 'unknown';
  const ctx = {
    req,
    res,
    url,
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    ip,
    config,
    logger,
    params: {},
    body: null,
    session: null,
    user: null,
    /** Bearer token, or the `link_session` cookie for browser-based clients. */
    credential: (() => {
      const header = String(req.headers.authorization || '');
      if (/^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();
      const cookie = String(req.headers.cookie || '');
      const found = cookie.match(/(?:^|;\s*)link_session=([^;]+)/);
      return found ? decodeURIComponent(found[1]) : '';
    })(),
    /**
     * Identity comes from the credential and nowhere else. A body that claims a
     * `userId` is treated as data to authorise against, never as who is asking.
     */
    async requireUser() {
      if (ctx.user) return ctx.user;
      if (!ctx.credential) throw new ApiError(401, 'unauthorized', 'Sign in to NovaLink Live first.');
      const resolved = accounts.resolve(ctx.credential);
      if (!resolved) throw new ApiError(401, 'session_expired', 'Your session is no longer valid. Sign in again.');
      ctx.session = resolved.session;
      ctx.privacy = resolved.privacy;
      ctx.user = accounts.rowToUser(resolved.user);
      return ctx.user;
    },
  };
  return ctx;
}

module.exports = {
  securityHeaders,
  sendJson,
  sendError,
  readJsonBody,
  refuseBody,
  createRouter,
  createContext,
  JSON_TYPES,
};
