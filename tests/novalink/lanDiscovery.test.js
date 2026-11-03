/**
 * electron/services/novalink/lanDiscovery.js — the LAN *finder*.
 *
 * Real multicast can't run on CI, so we drive it through the injected seams:
 * a fake socket + a fake clock + the `__ingestForTests` entry point that runs
 * exactly the datagram path a live reply would. This pins the security-relevant
 * behavior: only validated announces become connectable hosts, everything else
 * is dropped, hosts expire, and a discovered host maps to a well-formed URL.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createLanDiscovery, announceToBaseUrl, manualBaseUrl } from '../../electron/services/novalink/lanDiscovery.js';
import { MAGIC, PROTOCOL_VERSION, SERVICE_ID, encodePacket, buildAnnounce } from '../../link-server/discovery.js';

function announceBuf(overrides = {}) {
  const a = buildAnnounce({
    displayName: 'Lab-PC',
    hostName: 'lab',
    ips: ['192.168.1.42'],
    port: 10000,
    tls: false,
    serverId: 'srv-1',
    ...overrides,
  });
  return { packet: a, buf: encodePacket(a) };
}

function fakeSocket() {
  const sock = new EventEmitter();
  sock.bind = () => { sock.emit('listening'); };
  sock.close = () => { sock.closed = true; };
  sock.addMembership = () => {}; sock.setBroadcast = () => {}; sock.setMulticastTTL = () => {}; sock.setMulticastLoopback = () => {};
  sock.send = (buf, off, len, port, addr) => { (sock.sent = sock.sent || []).push({ port, addr }); };
  return sock;
}

describe('lanDiscovery — announce → base URL', () => {
  it('uses http for plain hosts and https for tls, picking a valid ip', () => {
    expect(announceToBaseUrl({ ips: ['192.168.1.42'], port: 10000, tls: false })).toBe('http://192.168.1.42:10000');
    expect(announceToBaseUrl({ ips: ['bad', '10.0.0.3'], port: 8443, tls: true })).toBe('https://10.0.0.3:8443');
    expect(announceToBaseUrl({ ips: [], port: 10000, tls: false })).toBeNull();
    expect(announceToBaseUrl(null)).toBeNull();
  });
});

describe('lanDiscovery — manualBaseUrl', () => {
  it('accepts a valid IPv4 + port', () => {
    expect(manualBaseUrl({ address: '192.168.1.7', port: 10000 })).toBe('http://192.168.1.7:10000');
    expect(manualBaseUrl({ address: '10.0.0.9', port: 8443, tls: true })).toBe('https://10.0.0.9:8443');
    expect(manualBaseUrl({ address: 'localhost', port: 10000 })).toBe('http://localhost:10000');
  });
  it('rejects hostnames, malformed IPs, and bad ports', () => {
    expect(() => manualBaseUrl({ address: 'evil.example.com', port: 10000 })).toThrow(/IPv4/);
    expect(() => manualBaseUrl({ address: '999.1.1.1', port: 10000 })).toThrow(/IPv4/);
    expect(() => manualBaseUrl({ address: '', port: 10000 })).toThrow(/IP address/);
    expect(() => manualBaseUrl({ address: '192.168.1.7', port: 99999 })).toThrow(/Port/);
    expect(() => manualBaseUrl({ address: '192.168.1.7' })).toThrow(/Port/);
  });
});

describe('lanDiscovery — ingest, dedupe, TTL, select', () => {
  it('turns a valid announce into a listed host and fires onHosts', () => {
    const onHosts = vi.fn();
    let clock = 1000;
    const disc = createLanDiscovery({ onHosts, logger: { warn() {}, info() {} }, now: () => clock });
    const { buf } = announceBuf();
    disc.__ingestForTests(buf);
    const list = disc.listHosts();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'srv-1', name: 'Lab-PC', baseUrl: 'http://192.168.1.42:10000', port: 10000, tls: false });
    expect(onHosts).toHaveBeenCalled();

    const sel = disc.selectHost('srv-1');
    expect(sel.baseUrl).toBe('http://192.168.1.42:10000');
  });

  it('drops garbage, wrong-magic, and announces that fail validation', () => {
    const disc = createLanDiscovery({ logger: { warn() {}, info() {} } });
    disc.__ingestForTests(Buffer.from('not json'));
    disc.__ingestForTests(Buffer.from(JSON.stringify({ magic: 'OTHER', v: PROTOCOL_VERSION, op: 'announce' })));
    disc.__ingestForTests(encodePacket({ magic: MAGIC, v: PROTOCOL_VERSION, op: 'announce', service: 'not-ours' }));
    // A query (not an announce) must not be mistaken for a host.
    disc.__ingestForTests(encodePacket({ magic: MAGIC, v: PROTOCOL_VERSION, op: 'query', id: 'x' }));
    expect(disc.listHosts()).toHaveLength(0);
  });

  it('de-duplicates by host id (one entry per server, refreshed seen-time)', () => {
    const disc = createLanDiscovery({ logger: { warn() {}, info() {} }, now: () => 5000 });
    const { buf } = announceBuf();
    disc.__ingestForTests(buf);
    disc.__ingestForTests(buf);
    disc.__ingestForTests(buf);
    expect(disc.listHosts()).toHaveLength(1);
  });

  it('expires a host we stop hearing from (TTL), and selectHost returns null after', () => {
    let clock = 1000;
    const disc = createLanDiscovery({ logger: { warn() {}, info() {} }, now: () => clock, ttlMs: 1000 });
    const { buf } = announceBuf();
    disc.__ingestForTests(buf);
    expect(disc.listHosts()).toHaveLength(1);
    clock = 5000; // well past ttl
    expect(disc.listHosts()).toHaveLength(0);
    expect(disc.selectHost('srv-1')).toBeNull();
  });

  it('caps the advertised IPs it stores to a sane number', () => {
    const many = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5', '10.0.0.6'];
    const { buf } = announceBuf({ ips: many });
    const disc = createLanDiscovery({ logger: { warn() {}, info() {} } });
    disc.__ingestForTests(buf);
    const host = disc.listHosts()[0];
    // validateAnnounce slices to 4, so the finder never stores an unbounded list.
    expect(host.ips.length).toBeLessThanOrEqual(4);
  });
});

describe('lanDiscovery — scanner lifecycle (fake socket)', () => {
  it('starts, joins, sends periodic queries, and reports scanning status', () => {
    const sock = fakeSocket();
    const disc = createLanDiscovery({
      logger: { warn() {}, info() {} },
      socketFactory: () => sock,
      interfacesProvider: () => ({ 'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.42', internal: false }] }),
    });
    const ok = disc.start();
    expect(ok).toBe(true);
    // Flush any pending timers/ticks before asserting the scanning state.
    return new Promise((resolve) => setImmediate(() => {
      expect(disc.status().scanning).toBe(true);
      // At least one query went to the multicast group port.
      expect((sock.sent || []).some((s) => s.port === 53531)).toBe(true);
      disc.stop();
      expect(disc.status().scanning).toBe(false);
      expect(sock.closed).toBe(true);
      resolve();
    }));
  });

  it('start() is idempotent and stop() before start never throws', () => {
    const sock = fakeSocket();
    const disc = createLanDiscovery({ logger: { warn() {}, info() {} }, socketFactory: () => sock });
    expect(() => disc.stop()).not.toThrow();
    expect(disc.start()).toBe(true);
    expect(disc.start()).toBe(false); // already scanning
    disc.stop();
  });

  it('a socket-factory failure degrades to start()=false, not a crash', () => {
    const disc = createLanDiscovery({
      logger: { warn() {}, info() {} },
      socketFactory: () => { throw new Error('no udp here'); },
    });
    expect(disc.start()).toBe(false);
  });

  it('a discovered host flows straight into a URL the existing client accepts', () => {
    const sock = fakeSocket();
    const disc = createLanDiscovery({ logger: { warn() {}, info() {} }, socketFactory: () => sock, SERVICE_ID_CHECK: SERVICE_ID });
    const { buf } = announceBuf();
    disc.__ingestForTests(buf);
    const chosen = disc.selectHost('srv-1');
    // The whole point: the discovered host yields exactly an http://ip:port that
    // liveClient.configure({ baseUrl }) already understands — no new protocol.
    expect(chosen.baseUrl).toMatch(/^http:\/\/192\.168\.1\.42:10000$/);
  });
});
