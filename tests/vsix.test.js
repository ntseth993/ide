/**
 * VSIX / ZIP reader tests.
 *
 * Builds real (tiny) ZIP archives in memory — both stored and deflated
 * entries — and asserts the reader locates and inflates the right bytes.
 * This is the parser used to read a marketplace extension's package.json
 * and snippet files, so correctness here is what keeps installs safe.
 */
import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { findEntryBuffer, listEntries } from '../electron/services/vsix';

/** Build a minimal valid ZIP from [{ name, data, method? }]. */
function makeZip(files) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const uncompressed = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const method = file.method || 0;
    const data = method === 8 ? zlib.deflateRawSync(uncompressed) : uncompressed;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14); // crc (not verified by the reader)
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(uncompressed.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(uncompressed.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const body = Buffer.concat(localChunks);
  const cd = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cd, eocd]);
}

describe('vsix reader', () => {
  it('reads a stored (method 0) entry', () => {
    const zip = makeZip([{ name: 'hello.txt', data: 'world' }]);
    expect(findEntryBuffer(zip, 'hello.txt').toString('utf8')).toBe('world');
  });

  it('inflates a deflated (method 8) entry', () => {
    const long = 'console.log("x");'.repeat(200);
    const zip = makeZip([{ name: 'extension/package.json', data: long, method: 8 }]);
    expect(findEntryBuffer(zip, 'extension/package.json').toString('utf8')).toBe(long);
  });

  it('matches by path suffix and lists every entry', () => {
    const zip = makeZip([
      { name: '[Content_Types].xml', data: '<xml/>' },
      { name: 'extension/package.json', data: '{"name":"demo"}', method: 8 },
      { name: 'extension/snippets/js.json', data: '{"log":{"prefix":"log","body":["console.log()"]}}' },
    ]);
    expect(JSON.parse(findEntryBuffer(zip, 'extension/package.json').toString()).name).toBe('demo');
    expect(listEntries(zip)).toEqual([
      '[Content_Types].xml',
      'extension/package.json',
      'extension/snippets/js.json',
    ]);
  });

  it('returns null for a missing entry', () => {
    const zip = makeZip([{ name: 'a.txt', data: 'a' }]);
    expect(findEntryBuffer(zip, 'nope/package.json')).toBeNull();
  });

  it('throws a friendly error for a non-archive buffer', () => {
    expect(() => findEntryBuffer(Buffer.from('not a zip at all'), 'x')).toThrow(/not a readable archive/);
  });
});
