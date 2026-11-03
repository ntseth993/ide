/**
 * electron/services/novalink/lanHost.js — the host toggle.
 *
 * We never spawn a real process on CI. A fake spawnFactory captures exactly how
 * the existing `link-server` would be launched, so we can pin the contract that
 * matters: run it as Node with discovery on, bind 0.0.0.0, keep the DB in a
 * writable data dir, allow only one instance, and report failure honestly.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createLanHost } from '../../electron/services/novalink/lanHost.js';

const silentLogger = { info() {}, warn() {}, error() {} };

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn((sig) => { child.killedWith = sig; });
  return child;
}

const ifaces = () => ({
  'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.42', internal: false }],
  'VPN': [{ family: 'IPv4', address: '10.8.0.5', internal: false }],
  'Loopback': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
});

describe('lanHost — launch contract', () => {
  it('spawns the existing server as Node with discovery + LAN bind + writable data dir', () => {
    const child = fakeChild();
    const spawnFactory = vi.fn(() => child);
    const host = createLanHost({ logger: silentLogger, dataDir: 'C:/userData/lan', spawnFactory, execPath: 'NovaCode.exe', serverPath: 'C:/app/link-server/server.js', interfacesProvider: ifaces });

    const status = host.start({ port: 10000, displayName: 'My PC' });

    expect(status.running).toBe(true);
    expect(status.pid).toBe(4242);
    expect(status.ips).toEqual(['192.168.1.42']); // VPN + loopback excluded
    expect(status.urls).toContain('http://192.168.1.42:10000');
    expect(status.urls).toContain('http://127.0.0.1:10000');

    // Verify the spawn used ELECTRON_RUN_AS_NODE with the right env.
    const [exec, args, opts] = spawnFactory.mock.calls[0];
    expect(exec).toBe('NovaCode.exe');
    expect(args).toEqual(['C:/app/link-server/server.js']);
    expect(opts.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(opts.env.LINK_DISCOVERY).toBe('1');
    expect(opts.env.LINK_HOST).toBe('0.0.0.0');
    expect(opts.env.LINK_PORT).toBe('10000');
    expect(opts.env.LINK_ALLOW_PLAINTEXT).toBe('1');
    expect(opts.env.LINK_DATA_DIR).toBe('C:/userData/lan');
    expect(opts.env.LINK_DISCOVERY_NAME).toBe('My PC');
    expect(opts.windowsHide).toBe(true);
  });

  it('is idempotent — a second start returns the running instance, no double spawn', () => {
    const spawnFactory = vi.fn(() => fakeChild());
    const host = createLanHost({ logger: silentLogger, dataDir: 'D:/x', spawnFactory, interfacesProvider: ifaces });
    host.start({});
    const second = host.start({ port: 9999 });
    expect(spawnFactory).toHaveBeenCalledTimes(1);
    expect(second.running).toBe(true);
  });

  it('stop() kills politely and clears running state', () => {
    const child = fakeChild();
    const host = createLanHost({ logger: silentLogger, dataDir: 'D:/x', spawnFactory: () => child, interfacesProvider: ifaces });
    host.start({});
    const after = host.stop();
    expect(after.running).toBe(false);
    expect(after.pid).toBeNull();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    // Idempotent stop when nothing is running.
    expect(() => host.stop()).not.toThrow();
  });

  it('a non-zero exit surfaces an honest lastError and clears running', () => {
    const child = fakeChild();
    const host = createLanHost({ logger: silentLogger, dataDir: 'D:/x', spawnFactory: () => child, interfacesProvider: ifaces });
    host.start({});
    // Feed a fatal stderr line then an exit.
    child.stderr.emit('data', Buffer.from('Error: SQLITE_CANTOPEN db locked\n'));
    child.emit('exit', 1, null);
    const status = host.status();
    expect(status.running).toBe(false);
    expect(status.lastError).toMatch(/exited \(code 1\)/);
    expect(status.lastError).toMatch(/SQLITE_CANTOPEN/);
  });

  it('a spawn that throws is reported, not swallowed', () => {
    const host = createLanHost({
      logger: silentLogger,
      dataDir: 'D:/x',
      spawnFactory: () => { throw new Error('EACCES'); },
      interfacesProvider: ifaces,
    });
    const status = host.start({});
    expect(status.running).toBe(false);
    expect(status.lastError).toMatch(/Could not start/);
  });

  it('requires a writable dataDir (fail fast)', () => {
    expect(() => createLanHost({ logger: silentLogger })).toThrow(/dataDir/);
  });

  it('idle status reports not running with no urls', () => {
    const host = createLanHost({ logger: silentLogger, dataDir: 'D:/x', spawnFactory: () => fakeChild(), interfacesProvider: ifaces });
    const status = host.status();
    expect(status.running).toBe(false);
    expect(status.ips).toEqual([]);
    expect(status.urls).toEqual([]);
  });
});
