import { describe, expect, it, vi } from 'vitest';
import { createSseParser } from '../electron/services/ai/sse';

function collect() {
  const events = [];
  const parser = createSseParser((event) => events.push(event));
  return { events, parser };
}

describe('createSseParser', () => {
  it('parses simple data blocks', () => {
    const { events, parser } = collect();
    parser.feed('data: hello\n\ndata: world\n\n');
    expect(events).toEqual([{ event: '', data: 'hello' }, { event: '', data: 'world' }]);
  });

  it('handles events split across chunk boundaries', () => {
    const { events, parser } = collect();
    parser.feed('data: {"a"');
    parser.feed(': 1}\n\n');
    expect(events).toEqual([{ event: '', data: '{"a": 1}' }]);
  });

  it('tolerates CRLF line endings', () => {
    const { events, parser } = collect();
    parser.feed('event: delta\r\ndata: one\r\n\r\ndata: two\r\n\r\n');
    expect(events).toEqual([{ event: 'delta', data: 'one' }, { event: '', data: 'two' }]);
  });

  it('joins multi-line data fields with newlines', () => {
    const { events, parser } = collect();
    parser.feed('data: line1\ndata: line2\n\n');
    expect(events).toEqual([{ event: '', data: 'line1\nline2' }]);
  });

  it('flushes a trailing unterminated block on end()', () => {
    const { events, parser } = collect();
    parser.feed('data: final');
    expect(events).toEqual([]);
    parser.end();
    expect(events).toEqual([{ event: '', data: 'final' }]);
  });

  it('ignores comment and id lines without data', () => {
    const onEvent = vi.fn();
    const parser = createSseParser(onEvent);
    parser.feed(': keep-alive\nid: 7\n\n');
    expect(onEvent).not.toHaveBeenCalled();
  });
});
