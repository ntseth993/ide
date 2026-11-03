'use strict';
/**
 * LAN host manager — starts/stops the *existing* NovaLink Live server so a
 * Windows PC can become the host other NovaCode installs discover.
 *
 * This does NOT reimplement or replace the server. It shells out to
 * `link-server/server.js` — literally the same entry `npm run link:dev` runs —
 * with discovery switched on. The server keeps owning accounts, chat, presence,
 * the SQLite database, the `/link` WebSocket, and the UDP discovery responder.
 *
 * How we run Node without asking users to install it:
 *   Electron ships a full Node runtime. Setting `ELECTRON_RUN_AS_NODE=1` and
 *   re-launching our own executable (`process.execPath`) turns the app binary
 *   into a `node` process. That bundled Node (v24 in Electron 44) has
 *   `node:sqlite`, so the server boots with zero external prerequisites — on a
 *   packaged install and in dev alike.
 *
 * We write the database under `userData`, never inside the (read-only, in
 * asar) install directory. A single host child is allowed at a time: a second
 * `start()` while one is running is a no-op that reports the live instance, so
 * reloading the window can never spawn duplicate servers or double-bind ports.
 *
 * Every failure path is surfaced honestly in `status().lastError` — we never
 * pretend a host is up when the child exited or could not be spawned.
 */
const path = require('path');
const { spawn } = require('child_process');

const { selectLanAddresses } = require('../../../link-server/discovery.js');

const DEFAULT_PORT = 10000;
const DEFAULT_HOST = '0.0.0.0';
const STDERR_TAIL_LINES = 8;

function defaultServerPath() {
  // electron/services/novalink -> repo root -> link-server/server.js
  return path.join(__dirname, '..', '..', '..', 'link-server', 'server.js');
}

/**
 * @param {object} deps
 * @param {object} [deps.logger]
 * @param {string} deps.dataDir                writable directory for link.sqlite
 * @param {(file: string, args: string[], opts: object) => object} [deps.spawnFactory]
 * @param {string} [deps.execPath]             binary to run as node (default: ours)
 * @param {string} [deps.serverPath]
 * @param {() => object} [deps.interfacesProvider]
 * @param {object} [deps.baseEnv]              environment to inherit (default: process.env)
 */
function createLanHost({
  logger = console,
  dataDir,
  spawnFactory = spawn,
  execPath = process.execPath,
  serverPath = defaultServerPath(),
  interfacesProvider = () => require('os').networkInterfaces(),
  baseEnv = process.env,
} = {}) {
  if (!dataDir) throw new Error('createLanHost requires a writable dataDir.');

  let child = null;
  let started = false;
  let lastError = null;
  let stderrTail = '';
  let current = { port: DEFAULT_PORT, host: DEFAULT_HOST, displayName: '' };

  function noteStderr(chunk) {
    const text = String(chunk || '');
    stderrTail = (stderrTail + text).split(/\r?\n/).filter(Boolean).slice(-STDERR_TAIL_LINES).join('\n');
  }

  function lanUrls() {
    const scheme = 'http'; // no TLS by default on a trusted LAN (documented risk)
    const addrs = selectLanAddresses(safeInterfaces(), { excludeVpn: true });
    const urls = addrs.map((a) => `${scheme}://${a.address}:${current.port}`);
    urls.push(`${scheme}://127.0.0.1:${current.port}`);
    return { ips: addrs.map((a) => a.address), urls };
  }

  function safeInterfaces() {
    try { return interfacesProvider() || {}; } catch { return {}; }
  }

  function buildEnv() {
    return {
      ...baseEnv,
      ELECTRON_RUN_AS_NODE: '1',
      // Reachable from other machines on the Wi-Fi, not just this one.
      LINK_HOST: current.host,
      LINK_PORT: String(current.port),
      // Allow plain ws:// on an isolated LAN for first-run; the risk and the
      // TLS path are documented in NOVALINK_LAN.md.
      LINK_ALLOW_PLAINTEXT: '1',
      // Turn the UDP advertiser on so clients can find this host automatically.
      LINK_DISCOVERY: '1',
      LINK_DISCOVERY_NAME: current.displayName || undefined,
      // Keep all durable state inside the app's own writable area.
      LINK_DATA_DIR: dataDir,
    };
  }

  function start(options = {}) {
    current = {
      port: Number.isInteger(options.port) ? options.port : DEFAULT_PORT,
      host: typeof options.host === 'string' && options.host.trim() ? options.host.trim() : DEFAULT_HOST,
      displayName: typeof options.displayName === 'string' ? options.displayName.slice(0, 64) : '',
    };

    if (started && child) {
      // Already hosting — idempotent, never a second process or a port clash.
      return status();
    }

    lastError = null;
    stderrTail = '';
    try {
      child = spawnFactory(execPath, [serverPath], {
        env: buildEnv(),
        cwd: path.dirname(serverPath),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      child = null;
      started = false;
      lastError = `Could not start the NovaLink host: ${error.message}`;
      logger.error?.('lan host spawn failed', { error: error.message });
      return status();
    }

    started = true;

    child.stdout?.on?.('data', (chunk) => logger.info?.('lan host', { line: String(chunk).trim() }));
    child.stderr?.on?.('data', (chunk) => { noteStderr(chunk); logger.warn?.('lan host stderr', { line: String(chunk).trim() }); });

    child.on('error', (error) => {
      started = false;
      lastError = `NovaLink host process error: ${error.message}`;
      logger.error?.('lan host error', { error: error.message });
    });

    child.on('exit', (code, signal) => {
      started = false;
      child = null;
      if (code !== 0 && code !== null) {
        lastError = `NovaLink host exited (code ${code}). ${stderrTail ? stderrTail.split('\n').slice(-1)[0] : ''}`.trim();
        logger.error?.('lan host exited', { code, signal });
      } else if (signal) {
        logger.info?.('lan host stopped', { signal });
      }
    });

    logger.info?.('lan host started', { port: current.port, host: current.host });
    return status();
  }

  function stop() {
    if (!child) {
      started = false;
      return status();
    }
    const target = child;
    child = null;
    started = false;
    try {
      // On Windows a SIGTERM to a child may not flush SQLite; close politely.
      target.kill('SIGTERM');
    } catch { /* already dead */ }
    // Safety net: if it lingers, force it so we never leak a bound port.
    const force = setTimeout(() => {
      try { target.kill('SIGKILL'); } catch { /* gone */ }
    }, 4000);
    if (force.unref) force.unref();
    logger.info?.('lan host stop requested');
    return status();
  }

  function status() {
    const { ips, urls } = started ? lanUrls() : { ips: [], urls: [] };
    return {
      running: started,
      pid: child && child.pid ? child.pid : null,
      host: current.host,
      port: current.port,
      displayName: current.displayName,
      ips,
      urls,
      lastError,
    };
  }

  return { start, stop, status };
}

module.exports = { createLanHost, DEFAULT_PORT, DEFAULT_HOST };
