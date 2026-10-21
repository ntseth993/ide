/**
 * Minimal, dependency-free ZIP reader for VSIX packages.
 *
 * A .vsix is an ordinary ZIP archive. We only ever need to READ a couple of
 * entries (the extension's package.json and any snippet JSON files), so this
 * implements just enough of the format's central directory to locate and
 * inflate stored (method 0) and deflated (method 8) entries using Node's
 * built-in zlib. It never writes or executes anything from the archive.
 *
 * ZIP64 and encrypted archives are not supported — VSIX packages are small
 * and unencrypted, so this is sufficient and keeps the surface tiny.
 */
const zlib = require('zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** Locate the End Of Central Directory record by scanning backwards. */
function findEndOfCentralDirectory(buffer) {
  const start = buffer.length - 22;
  const floor = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = start; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/**
 * Read the central directory into a list of entries.
 * @returns {{ name: string, method: number, compressedSize: number, localOffset: number }[]}
 */
function readEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('The package is not a readable archive.');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Inflate/copy the bytes of a single entry. */
function readEntry(buffer, entry) {
  const local = entry.localOffset;
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) {
    throw new Error(`Corrupt archive entry: ${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const dataStart = local + 30 + nameLength + extraLength;
  const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`Unsupported compression method ${entry.method} for ${entry.name}`);
}

/**
 * Return the decoded bytes of the first entry whose path ends with `suffix`
 * (case-insensitive), or null when no entry matches.
 */
function findEntryBuffer(buffer, suffix) {
  const target = String(suffix).toLowerCase();
  const entries = readEntries(buffer);
  const match = entries.find((entry) => entry.name.toLowerCase().endsWith(target));
  return match ? readEntry(buffer, match) : null;
}

/** List every entry path (useful for diagnostics/tests). */
function listEntries(buffer) {
  return readEntries(buffer).map((entry) => entry.name);
}

module.exports = { findEntryBuffer, listEntries, readEntries };
