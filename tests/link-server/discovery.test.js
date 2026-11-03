/**
 * link-server/discovery.js — the responder + packet vocabulary.
 *
 * The pure encode/decode/validate/select layer is fully exercised (multicast
 * itself cannot run on CI, so the socket is a fake EventEmitter that lets us
 * drive 'listening' and 'message' deterministically).
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  MAGIC,
  PROTOCOL_VERSION,
  SERVICE_ID,
  MAX_PACKET_BYTES,
  encodePacket,
  decodePacket,
  validateQuery,
  validateAnnounce,
  buildAnnounce,
  respondToQuery,
  selectLanAddresses,
  isValidIPv4,
  createDiscovery,
} from '../../link-server/discovery.js';

const silentLogger = { info() {}, warn() {}, error() {} };

describe('discovery — IPv4 validation', () => {
  it('accepts real dotted quads, rejects everything else', () => {
    expect(isValidIPv4('192.168.1.42')).toBe(true);
    expect(isValidIPv4('10.0.0.1')).toBe(true);
    expect(isValidIPv4('255.255.255.255')).toBe(true);
    expect(isValidIPv4('256.1.1.1')).toBe(false);
    expect(isValidIPv4('1.1.1')).toBe(false);
    expect(isValidIPv4('a.b.c.d')).toBe(false);
    expect(isValidIPv4('')).toBe(false);
    expect(isValidIPv4(null)).toBe(false);
  });
});

describe('discovery — LAN address selection', () => {
  const ifaces = {
    'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.42', internal: false }],
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    'TAP-Windows Adapter (VPN)': [{ family: 'IPv4', address: '10.8.0.5', internal: false }],
    'Ethernet (APIPA)': [{ family: 'IPv4', address: '169.254.7.7', internal: false }],
    'vEthernet (Default Switch)': [{ family: 'IPv4', address: '172.18.0.1', internal: false }],
    'Wi-Fi IPv6': [{ family: 'IPv6', address: 'fe80::1', internal: false }],
  };

  it('keeps only routable, non-VPN, non-link-local IPv4 addresses', () => {
    const picked = selectLanAddresses(ifaces, { excludeVpn: true }).map((a) => a.address);
    expect(picked).toEqual(['192.168.1.42']);
  });

  it('includes virtual adapters when excludeVpn is off but still drops loopback/APIPA', () => {
    const picked = selectLanAddresses(ifaces, { excludeVpn: false }).map((a) => a.address);
    expect(picked).toContain('10.8.0.5');
    expect(picked).toContain('172.18.0.1');
    expect(picked).not.toContain('127.0.0.1');
    expect(picked).not.toContain('169.254.7.7');
  });

  it('survives a garbage interfaces object', () => {
    expect(selectLanAddresses(null)).toEqual([]);
    expect(selectLanAddresses({ Bad: 'not-an-array' })).toEqual([]);
  });
});

describe('discovery — packet encode/decode', () => {
  it('round-trips a valid packet', () => {
    const pkt = { magic: MAGIC, v: PROTOCOL_VERSION, op: 'query', id: 'c-1' };
    expect(decodePacket(encodePacket(pkt))).toEqual(pkt);
  });

  it('refuses oversized packets on both ends', () => {
    expect(() => encodePacket({ magic: MAGIC, v: 1, blob: 'x'.repeat(MAX_PACKET_BYTES) })).toThrow(/exceeds/);
    expect(decodePacket(Buffer.from('x'.repeat(MAX_PACKET_BYTES + 10)))).toBeNull();
  });

  it('drops malformed / wrong-magic / wrong-version / array / empty buffers', () => {
    expect(decodePacket(Buffer.alloc(0))).toBeNull();
    expect(decodePacket(Buffer.from('not json'))).toBeNull();
    expect(decodePacket(Buffer.from('[1,2,3]'))).toBeNull();
    expect(decodePacket(Buffer.from(JSON.stringify({ magic: 'OTHER', v: 1, op: 'query' })))).toBeNull();
    expect(decodePacket(Buffer.from(JSON.stringify({ magic: MAGIC, v: 999, op: 'query' })))).toBeNull();
    expect(decodePacket('a string, not a buffer')).toBeNull();
  });
});

describe('discovery — query/announce validation', () => {
  it('validateQuery accepts only op:query', () => {
    expect(validateQuery({ op: 'query', id: 'abc' })).toEqual({ id: 'abc' });
    expect(validateQuery({ op: 'announce' })).toBeNull();
    expect(validateQuery(null)).toBeNull();
  });

  it('validateAnnounce normalizes a good announce and rejects bad ones', () => {
    const good = buildAnnounce({ displayName: 'Lab', hostName: 'lab', ips: ['192.168.1.5'], port: 10000, tls: false, serverId: 'id-1' });
    const normalized = validateAnnounce(good);
    expect(normalized).toMatchObject({ op: 'announce', service: SERVICE_ID, name: 'Lab', host: 'lab', port: 10000, tls: false, ips: ['192.168.1.5'], id: 'id-1' });

    expect(validateAnnounce({ ...good, service: 'other' })).toBeNull();
    expect(validateAnnounce({ ...good, port: 70000 })).toBeNull();
    expect(validateAnnounce({ ...good, port: 'nope' })).toBeNull();
    expect(validateAnnounce({ ...good, tls: 'yes' })).toBeNull();
    expect(validateAnnounce({ ...good, ips: [] })).toBeNull();
    expect(validateAnnounce({ ...good, ips: ['999.999.999.999'] })).toBeNull();
    // A control character in the display name is refused (no injection surface).
    expect(validateAnnounce({ ...good, name: 'bad\u0000name' })).toBeNull();
  });

  it('buildAnnounce clips long names and drops invalid IPs', () => {
    const a = buildAnnounce({ displayName: 'x'.repeat(200), hostName: 'h', ips: ['192.168.1.5', 'bad', '10.0.0.2'], port: 10000, tls: true, serverId: 'id' });
    expect(a.name.length).toBeLessThanOrEqual(64);
    expect(a.ips).toEqual(['192.168.1.5', '10.0.0.2']);
    expect(a.tls).toBe(true);
    expect(a.proto).toBe(PROTOCOL_VERSION);
  });
});

describe('discovery — respondToQuery (pure reply decision)', () => {
  const announce = buildAnnounce({ displayName: 'Lab', hostName: 'lab', ips: ['192.168.1.5'], port: 10000, tls: false, serverId: 'srv-1' });

  it('replies to a valid query with the announce, echoing replyTo', () => {
    const reply = respondToQuery(encodePacket({ magic: MAGIC, v: PROTOCOL_VERSION, op: 'query', id: 'peer-9' }), announce);
    const parsed = decodePacket(reply);
    expect(parsed.replyTo).toBe('peer-9');
    expect(parsed.service).toBe(SERVICE_ID);
  });

  it('stays silent to garbage, non-queries, and wrong magic', () => {
    expect(respondToQuery(Buffer.from('junk'), announce)).toBeNull();
    expect(respondToQuery(encodePacket(announce), announce)).toBeNull(); // an announce is not a query
    expect(respondToQuery(Buffer.from(JSON.stringify({ magic: 'X', v: 1, op: 'query' })), announce)).toBeNull();
  });
});

describe('discovery — createDiscovery responder (fake socket)', () => {
  function makeFakeSocket() {
    const sock = new EventEmitter();
    sock.bind = (port, host) => { sock.bound = { port, host }; sock.emit('listening'); return sock; };
    sock.close = () => { sock.closed = true; };
    sock.addMembership = (group, iface) => { (sock.members = sock.members || []).push([group, iface]); };
    sock.setBroadcast = () => {}; sock.setMulticastTTL = () => {}; sock.setMulticastLoopback = () => {};
    sock.send = (buf, off, len, port, addr) => { (sock.sent = sock.sent || []).push({ port, addr, buf }); };
    return sock;
  }

  const baseConfig = {
    host: '0.0.0.0',
    port: 10000,
    hostname: 'labhost',
    tls: null,
    discovery: { enabled: true, group: '239.255.77.77', port: 53531, displayName: 'Lab PC', intervalMs: 60000, ttlMs: 30000, excludeVpn: true },
  };
  const ifaces = () => ({ 'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.42', internal: false }] });

  it('binds, joins the group, and unicasts an announce back to a valid querier', () => {
    const sock = makeFakeSocket();
    const disc = createDiscovery({ config: baseConfig, logger: silentLogger, socketFactory: () => sock, interfacesProvider: ifaces, serverId: 'srv-1' });
    disc.start();
    expect(sock.bound).toEqual({ port: 53531, host: '0.0.0.0' });
    // membership joined on the one LAN interface
    expect((sock.members || []).some((m) => m[0] === '239.255.77.77' && m[1] === '192.168.1.42')).toBe(true);

    // Simulate a query arriving from a client.
    sock.emit('message', encodePacket({ magic: MAGIC, v: PROTOCOL_VERSION, op: 'query', id: 'client-7' }), { address: '192.168.1.99', port: 51000 });
    const reply = (sock.sent || []).find((s) => s.port === 51000 && s.addr === '192.168.1.99');
    expect(reply).toBeTruthy();
    expect(decodePacket(reply.buf).replyTo).toBe('client-7');

    disc.stop();
    expect(sock.closed).toBe(true);
  });

  it('does not reply to a malformed packet', () => {
    const sock = makeFakeSocket();
    const disc = createDiscovery({ config: baseConfig, logger: silentLogger, socketFactory: () => sock, interfacesProvider: ifaces });
    disc.start();
    const before = (sock.sent || []).length;
    sock.emit('message', Buffer.from('totally-broken'), { address: '192.168.1.99', port: 51001 });
    // No NEW unicast reply to 51001 (the periodic multicast to the group may already exist).
    expect((sock.sent || []).filter((s) => s.port === 51001).length).toBe(0);
    expect((sock.sent || []).length).toBe(before);
    disc.stop();
  });

  it('refuses to start with no advertisable LAN address (VPN-only host)', () => {
    let created = false;
    const sock = makeFakeSocket();
    const disc = createDiscovery({
      config: baseConfig,
      logger: silentLogger,
      socketFactory: () => { created = true; return sock; },
      interfacesProvider: () => ({ 'Loopback': [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }),
    });
    const started = disc.start();
    expect(started).toBe(false);
    expect(created).toBe(false); // never even opened a socket
  });

  it('stop() is idempotent and never throws when never started', () => {
    const disc = createDiscovery({ config: baseConfig, logger: silentLogger, socketFactory: makeFakeSocket, interfacesProvider: ifaces });
    expect(() => disc.stop()).not.toThrow();
    disc.stop();
  });
});
