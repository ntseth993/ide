/**
 * Shared harness for the NovaLink Live server tests.
 *
 * These are real integration tests: a real server object, a real SQLite file in
 * a temp directory, real HTTP over loopback, and the platform WebSocket client
 * (undici) rather than the server's own implementation, so the two sides of the
 * protocol are checked against each other instead of against themselves.
 *
 * Nothing here mocks a successful operation. If the server cannot do it, the
 * test fails.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const quietLogger = {
  info: () => {},
  warn: () => {},
  // A 5xx inside a test is never noise: the response body hides the reason, so the
  // server's own words are the only way to find it. Refusing to print them turned
  // one broken upload into six puzzling assertions.
  error: (...args) => console.error('[link-server]', ...args),
  debug: () => {},
  child() { return this; },
};

/**
 * The server needs `node:sqlite` (Node 22.5+) and the client side of these tests
 * needs the standard `WebSocket` global (Node 21+). CI still runs the IDE suite
 * on Node 20, so the honest answer there is to skip these files and say why,
 * not to fake a pass.
 */
export function linkServerSupport() {
  const missing = [];
  try {
    require('node:sqlite');
  } catch {
    missing.push('node:sqlite');
  }
  if (typeof globalThis.WebSocket !== 'function') missing.push('the global WebSocket client');
  return { supported: missing.length === 0, missing, node: process.version };
}

export const CAPABILITY = linkServerSupport();
export const SKIP = !CAPABILITY.supported;
export const SKIP_REASON = `NovaLink Live needs ${CAPABILITY.missing.join(' and ')}; this runtime is Node ${CAPABILITY.node}`;

/** A minimal valid 1x1 PNG, because content sniffing has to be satisfied. */
export const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Starts with the bytes a double-click runs, but is named like a text file. */
export const PE_HEADERS_IN_A_TXT = Buffer.concat([
  Buffer.from('MZ'),
  Buffer.alloc(64, 0x20),
  Buffer.from('looks like a note'),
]);

const PASSWORD = 'correct-horse-battery';

/**
 * The environment every boot uses unless a test says otherwise.
 *
 * The heartbeat values are the shortest intervals `config.js` allows, so presence
 * and dead-socket tests take seconds rather than the 20s/60s a real deployment
 * uses, while still exercising the same floors an operator gets.
 */
const DEFAULT_ENV = {
  LINK_LOG_LEVEL: 'none',
  LINK_REGISTRATION_OPEN: '1',
  LINK_PRESENCE_PING_MS: '1000',
  LINK_PRESENCE_DEAD_MS: '3000',
  LINK_PRESENCE_AWAY_MINUTES: '1',
  // Headroom for registering several accounts per file; the tests that check a
  // limit set it explicitly.
  LINK_RATE_AUTH_PER_MIN: '120',
  LINK_RATE_GENERAL_PER_MIN: '5000',
  LINK_RATE_MESSAGE_PER_MIN: '600',
  LINK_RATE_UPLOAD_PER_MIN: '300',
  LINK_CALL_TIMEOUT_SECONDS: '5',
};

export async function boot(input = {}) {
  const overrides = { ...input };
  const ownsDir = !overrides.dataDir;
  const dataDir = overrides.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'novalink-live-'));
  delete overrides.dataDir;
  const env = { ...DEFAULT_ENV, ...overrides.env };
  delete overrides.env;

  const { startServer } = require('../../link-server/server');
  const sockets = new Set();
  let instance = null;
  let port = 0;

  async function listen(extraEnv = {}) {
    instance = startServer({
      dataDir,
      host: '127.0.0.1',
      port: 0,
      logger: overrides.logger || quietLogger,
      env: { ...env, ...extraEnv },
      ...overrides,
    });
    await new Promise((resolve, reject) => {
      instance.server.once('error', reject);
      instance.server.listen(0, '127.0.0.1', resolve);
    });
    port = instance.server.address().port;
    return instance;
  }

  await listen();

  // A function, not a string: `restart` gives the same data directory a different
  // ephemeral port, and every credential built earlier has to keep working.
  const origin = () => `http://127.0.0.1:${port}`;

  function client(token) {
    const call = async (method, route, body, { headers = {}, raw = null, query = '' } = {}) => {
      const response = await fetch(`${origin()}${route}${query}`, {
        method,
        headers: {
          ...(raw ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
        duplex: raw ? 'half' : undefined,
      });
      const text = await response.text();
      let json = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { rawText: text };
      }
      json.__status = response.status;
      json.__headers = Object.fromEntries(response.headers.entries());
      return json;
    };
    return {
      token,
      get origin() {
        return origin();
      },
      get: (route, opts) => call('GET', route, undefined, opts),
      post: (route, body, opts) => call('POST', route, body, opts),
      put: (route, body, opts) => call('PUT', route, body, opts),
      patch: (route, body, opts) => call('PATCH', route, body, opts),
      del: (route, opts) => call('DELETE', route, undefined, opts),
      head: (route) => fetch(`${origin()}${route}`, { method: 'HEAD', headers: token ? { authorization: `Bearer ${token}` } : {} }),
      rawBytes: (route, opts = {}) => fetch(`${origin()}${route}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers } }).then(async (response) => ({
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        buffer: Buffer.from(await response.arrayBuffer()),
      })),
      call,
    };
  }

  const anon = client('');

  async function register(username, extra = {}) {
    const result = await anon.post('/api/register', {
      username,
      password: PASSWORD,
      displayName: extra.displayName || username,
      ...extra,
    });
    if (result.__status !== 201) throw new Error(`register ${username} failed: ${JSON.stringify(result)}`);
    return {
      id: result.user.id,
      username: result.user.username,
      token: result.token,
      password: PASSWORD,
      client: client(result.token),
      socket: null,
    };
  }

  async function login(username, { password = PASSWORD, deviceLabel = 'test' } = {}) {
    const result = await anon.post('/api/login', { username, password, deviceLabel });
    if (result.__status !== 200) throw Object.assign(new Error(`login ${username} failed: ${JSON.stringify(result)}`), { response: result });
    return { id: result.user.id, username, token: result.token, password, client: client(result.token), socket: null };
  }

  /** Two real users becoming contacts: request, then accept. */
  async function becomeFriends(a, b) {
    const sent = await a.client.post('/api/requests', { username: b.username, message: 'peer from the test suite' });
    if (sent.__status !== 201) throw new Error(`connection request failed: ${JSON.stringify(sent)}`);
    const accepted = await b.client.post(`/api/requests/${sent.request.id}/accept`, {});
    if (accepted.__status !== 200) throw new Error(`accept failed: ${JSON.stringify(accepted)}`);
    return accepted.request;
  }

  /** Open an authenticated socket and collect everything the server pushes. */
  async function connectSocket(account, { deviceLabel = 'test', autoAuth = true } = {}) {
    const link = new globalThis.WebSocket(`${origin().replace('http', 'ws')}/link`);
    sockets.add(link);
    const log = [];
    const waiters = [];
    let closed = null;

    link.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      log.push(message);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const waiter = waiters[i];
        if (!waiter.matches(message)) continue;
        waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    });
    link.addEventListener('close', (event) => {
      closed = { code: event.code, reason: event.reason };
      sockets.delete(link);
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`socket closed with ${closed.code} ${closed.reason}`));
      }
    });
    link.addEventListener('error', () => { /* always followed by close */ });

    await new Promise((resolve, reject) => {
      link.addEventListener('open', resolve, { once: true });
      setTimeout(() => reject(new Error('the socket did not open')), 4000).unref?.();
    });

    const api = {
      raw: link,
      log: () => [...log],
      get closedInfo() {
        return closed;
      },
      get readyState() {
        return link.readyState;
      },
      send(frame) {
        link.send(JSON.stringify(frame));
      },
      close(code, reason) {
        link.close(code, reason);
      },
      /**
       * Wait for a pushed frame. `want` is either a predicate or an options
       * object, because most callers only care about one message of one type and
       * the rest care which one - and a silently ignored predicate would make
       * those tests pass on the wrong frame.
       */
      waitFor(type, want = {}) {
        const options = typeof want === 'function' ? { matches: want } : want;
        const { matches = null, timeout = 4000 } = options;
        const test = (message) => message.type === type && (!matches || matches(message));
        const found = log.find(test);
        if (found) return Promise.resolve(found);
        if (closed) return Promise.reject(new Error(`socket already closed (${closed.code})`));
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            const index = waiters.findIndex((waiter) => waiter.matches === test);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error(`no "${type}" within ${timeout}ms; saw ${log.map((message) => message.type).join(', ') || 'nothing'}`));
          }, timeout);
          waiters.push({ matches: test, resolve, reject, timer });
        });
      },
      /** Everything of one type that has arrived so far. */
      all(type) {
        return log.filter((message) => message.type === type);
      },
    };

    if (autoAuth) {
      api.send({ type: 'auth', token: account.token, deviceLabel });
      api.ready = await api.waitFor('ready');
      account.socket = api;
    }
    return api;
  }

  async function stopSockets() {
    for (const link of sockets) {
      try { link.close(); } catch { /* already gone */ }
    }
    sockets.clear();
  }

  /**
   * Stop this process and start another one against the same data directory.
   *
   * This is the only way to test what the brief actually claims: that the
   * database - not the socket, not the in-memory presence map - is the truth. The
   * harness object itself survives, so accounts keep their tokens and every client
   * re-points at the new port.
   */
  async function restart(extraEnv = {}) {
    await stopSockets();
    await instance.close();
    await listen(extraEnv);
    return api;
  }

  async function close() {
    await stopSockets();
    await instance.close();
    if (ownsDir) fs.rmSync(dataDir, { recursive: true, force: true });
  }

  const api = {
    get instance() {
      return instance;
    },
    get store() {
      return instance.store;
    },
    get config() {
      return instance.config;
    },
    get filesDir() {
      return instance.config.filesDir;
    },
    get port() {
      return port;
    },
    get origin() {
      return origin();
    },
    dataDir,
    anon,
    client,
    register,
    login,
    becomeFriends,
    connectSocket,
    close,
    restart,
  };
  return api;
}

/** Poll until `fn` returns truthy, so a test never sleeps on a guessed delay. */
export async function until(fn, { timeout = 4000, every = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

/**
 * A WebSocket client on a bare TCP socket, hand-building one masked text frame.
 *
 * This exists for exactly one thing the platform client cannot do: die without
 * sending a close frame, which is what a killed process or a yanked cable looks
 * like to a server. Only the handshake and one outbound frame are implemented; a
 * real client is exercised elsewhere against `link-server/ws.js`.
 */
export function rawClient(port, { route = '/link' } = {}) {
  const socket = net.connect(port, '127.0.0.1');
  const state = { handshake: '', bytes: 0 };

  const done = new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const guard = setTimeout(() => reject(new Error('the server never finished the handshake')), 5000);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      state.bytes += chunk.length;
      state.handshake = buffer.toString('latin1');
      if (state.handshake.includes('\r\n\r\n')) {
        socket.off('data', onData);
        clearTimeout(guard);
        resolve(state.handshake);
      }
    };
    socket.on('data', onData);
    socket.on('error', (error) => { clearTimeout(guard); reject(error); });
  });

  socket.on('connect', () => {
    const key = crypto.randomBytes(16).toString('base64');
    socket.write(
      `GET ${route} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
  });

  return {
    socket,
    done,
    state,
    /** Send one masked text frame; the server requires masking from a client. */
    async sendText(text) {
      await done;
      const payload = Buffer.from(String(text), 'utf8');
      const mask = crypto.randomBytes(4);
      const header = [0x81];
      if (payload.length < 126) header.push(0x80 | payload.length);
      else if (payload.length < 65536) header.push(0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff);
      else header.push(0x80 | 127, 0, 0, 0, 0, ...[payload.length].flatMap((n) => [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]));
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
      socket.write(Buffer.concat([Buffer.from(header), mask, masked]));
    },
    /** No close frame, no goodbye - the connection simply stops existing. */
    vanish() {
      socket.destroy();
    },
  };
}

/** One byte-by-byte stream, so an upload is a real stream and not a Buffer. */
export function streamOf(buffer, chunkSize = 4096) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= buffer.length) {
        controller.close();
        return;
      }
      controller.enqueue(buffer.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}
