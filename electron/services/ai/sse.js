/**
 * Minimal Server-Sent-Events parser for streaming chat completions.
 *
 * Pure string processing with no I/O so it can be unit tested directly,
 * including the awkward cases: events split across network chunks,
 * multi-line data fields, and the terminating [DONE] sentinel.
 */

/**
 * Create an SSE parser.
 * @param {(event: { event: string, data: string }) => void} onEvent
 * @returns {{ feed: (text: string) => void, end: () => void }}
 */
function createSseParser(onEvent) {
  let buffer = '';

  function dispatch(block) {
    const lines = block.split('\n');
    let eventName = '';
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length > 0) {
      onEvent({ event: eventName, data: dataLines.join('\n') });
    }
  }

  return {
    feed(text) {
      buffer += text;
      let separatorIndex;
      // SSE blocks are separated by a blank line; tolerate \r\n and \n\n.
      while ((separatorIndex = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const match = buffer.slice(separatorIndex).match(/^\r?\n\r?\n/);
        const block = buffer.slice(0, separatorIndex).replace(/\r\n/g, '\n');
        buffer = buffer.slice(separatorIndex + (match ? match[0].length : 2));
        dispatch(block);
      }
    },
    end() {
      const tail = buffer.replace(/\r\n/g, '\n').trim();
      if (tail) dispatch(tail);
      buffer = '';
    },
  };
}

module.exports = { createSseParser };
