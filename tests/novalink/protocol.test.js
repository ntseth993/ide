/**
 * NovaLink wire-protocol unit tests: framing, streaming reassembly, duplicate
 * suppression, size caps, and envelope construction.
 */
import { describe, it, expect } from 'vitest';
import {
  MESSAGE_TYPES,
  LIMITS,
  PROTOCOL_VERSION,
  encodeFrame,
  createFrameReader,
  makeMessage,
  sha256,
  MessageDeduper,
  readMessageType,
} from '../../electron/services/novalink/protocol';

describe('novalink protocol — framing', () => {
  it('round-trips a single frame', () => {
    const message = { v: PROTOCOL_VERSION, id: 'a', type: 'text', from: 'me', fp: 'X' };
    const frames = [];
    const reader = createFrameReader((m) => frames.push(m));
    reader.push(encodeFrame(message));
    expect(frames).toEqual([message]);
  });

  it('reassembles frames split across many chunks', () => {
    const a = makeMessage('me', 'FP', MESSAGE_TYPES.TEXT, { text: 'hello' });
    const b = makeMessage('me', 'FP', MESSAGE_TYPES.CODE, { text: 'x', language: 'js' });
    const wire = Buffer.concat([encodeFrame(a), encodeFrame(b)]);
    const got = [];
    const reader = createFrameReader((m) => got.push(m));
    // Feed one byte at a time to prove partial-frame handling.
    for (let i = 0; i < wire.length; i += 1) reader.push(wire.subarray(i, i + 1));
    expect(got.map((m) => m.type)).toEqual(['text', 'code']);
    expect(got[0].text).toBe('hello');
  });

  it('coalesces multiple frames delivered in one chunk', () => {
    const got = [];
    const reader = createFrameReader((m) => got.push(m));
    reader.push(Buffer.concat([
      encodeFrame(makeMessage('me', 'F', MESSAGE_TYPES.TEXT, { text: '1' })),
      encodeFrame(makeMessage('me', 'F', MESSAGE_TYPES.TEXT, { text: '2' })),
      encodeFrame(makeMessage('me', 'F', MESSAGE_TYPES.TEXT, { text: '3' })),
    ]));
    expect(got.map((m) => m.text)).toEqual(['1', '2', '3']);
  });

  it('reports malformed frames without throwing to the caller', () => {
    const errors = [];
    const reader = createFrameReader(() => {}, { onError: (e) => errors.push(e.message) });
    const bad = Buffer.alloc(4);
    bad.writeUInt32BE(5, 0); // claims 5 bytes of JSON that are not valid JSON
    reader.push(Buffer.concat([bad, Buffer.from('notjs', 'utf8')]));
    expect(errors.join(' ')).toMatch(/malformed/i);
  });

  it('rejects a frame claiming to exceed the size cap', () => {
    const errors = [];
    const reader = createFrameReader(() => {}, { onError: (e) => errors.push(e.message) });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(LIMITS.MAX_FRAME_BYTES + 1, 0);
    reader.push(header);
    expect(errors.join(' ')).toMatch(/too large/i);
  });

  it('refuses to encode an oversized message', () => {
    const big = { v: PROTOCOL_VERSION, id: 'x', type: 'text', from: 'me', fp: 'F', text: 'a'.repeat(LIMITS.MAX_FRAME_BYTES + 10) };
    expect(() => encodeFrame(big)).toThrow(/exceeds/i);
  });
});

describe('novalink protocol — messages', () => {
  it('makeMessage fills version, id, fingerprint and timestamp', () => {
    const m = makeMessage('peer-1', 'FP', MESSAGE_TYPES.TEXT, { text: 'hi' });
    expect(m).toMatchObject({ v: PROTOCOL_VERSION, from: 'peer-1', fp: 'FP', type: 'text', text: 'hi' });
    expect(typeof m.id).toBe('string');
    expect(typeof m.ts).toBe('number');
  });

  it('readMessageType validates the envelope shape', () => {
    expect(readMessageType({ v: PROTOCOL_VERSION, id: 'a', type: 'text' })).toBe('text');
    expect(readMessageType({ v: 99, id: 'a', type: 'text' })).toBeNull();
    expect(readMessageType({ v: PROTOCOL_VERSION, type: 'text' })).toBeNull(); // no id
    expect(readMessageType(null)).toBeNull();
  });

  it('sha256 is a stable 64-char hex digest', () => {
    const digest = sha256(Buffer.from('novacode', 'utf8'));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(sha256('novacode'));
  });
});

describe('novalink protocol — dedupe', () => {
  it('accepts an id once and rejects repeats', () => {
    const d = new MessageDeduper();
    expect(d.accept('x')).toBe(true);
    expect(d.accept('x')).toBe(false);
    expect(d.accept('')).toBe(false);
  });

  it('stays bounded by capacity', () => {
    const d = new MessageDeduper(3);
    d.accept('1'); d.accept('2'); d.accept('3'); d.accept('4');
    expect(d.seen.size).toBeLessThanOrEqual(3);
  });
});
