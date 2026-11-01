/**
 * aiService chat orchestration: the silent fallback that retries an
 * unreachable provider on the free, keyless one so a message still gets an
 * answer — and the guard that avoids a double-fallback when the free provider
 * itself is the one that fails.
 *
 * Also covers the one-shot `complete()` budget: ghost text must stay cheap and
 * fast, while a caller that is not typing mid-keystroke (a deploy diagnosis) may
 * widen both — without changing what the editor's completion path costs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAiService } from '../electron/services/aiService';

/** A Response-like object whose body streams the given SSE parts. */
function streamResponse(parts) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read() {
            if (index < parts.length) {
              const value = encoder.encode(parts[index]);
              index += 1;
              return Promise.resolve({ done: false, value });
            }
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    },
  };
}

const secretStore = { getSecret: async () => null, getSecretSource: async () => null };
const logger = { info() {}, error() {}, warn() {} };

describe('aiService fallback', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('retries an unreachable provider on the free fallback and streams the answer', async () => {
    const urls = [];
    global.fetch = async (url) => {
      urls.push(url);
      if (url.includes('localhost:11434')) {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      }
      return streamResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    };

    const events = [];
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const service = createAiService({
      onEvent: (e) => { events.push(e); if (e.type === 'done') resolveDone(e); },
      secretStore,
      logger,
    });

    await service.start({ provider: 'ollama', messages: [{ role: 'user', content: 'hi' }] });
    const doneEvent = await done;

    expect(JSON.parse(doneEvent.data).reason).toBe('completed');
    const text = events.filter((e) => e.type === 'delta').map((e) => e.data).join('');
    expect(text).toBe('Hello');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    // Primary was attempted, then the free fallback was reached.
    expect(urls.some((u) => u.includes('localhost:11434'))).toBe(true);
    expect(urls.some((u) => u.includes('pollinations'))).toBe(true);
  });

  it('does not double-fallback when the free provider itself fails', async () => {
    let freeCalls = 0;
    global.fetch = async (url) => {
      if (url.includes('pollinations')) {
        freeCalls += 1;
        throw new Error('The free AI endpoint is rate-limited right now.');
      }
      return streamResponse(['data: [DONE]\n\n']);
    };

    const events = [];
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const service = createAiService({
      onEvent: (e) => { events.push(e); if (e.type === 'done') resolveDone(e); },
      secretStore,
      logger,
    });

    await service.start({ provider: 'pollinations', messages: [{ role: 'user', content: 'hi' }] });
    const doneEvent = await done;

    expect(JSON.parse(doneEvent.data).reason).toBe('error');
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(freeCalls).toBe(1); // no second attempt against the same provider
  });

  it('waits and retries when the free provider is rate-limited (402), then answers', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        // Free tier: 402 with a tiny Retry-After so the test stays fast.
        return {
          ok: false,
          status: 402,
          headers: { get: () => '1' },
          text: async () => '{"error":{"message":"slow down"}}',
        };
      }
      return streamResponse([
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    };

    const events = [];
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const service = createAiService({
      onEvent: (e) => { events.push(e); if (e.type === 'done') resolveDone(e); },
      secretStore,
      logger,
    });

    await service.start({ provider: 'pollinations', messages: [{ role: 'user', content: 'hi' }] });
    const doneEvent = await done;

    expect(JSON.parse(doneEvent.data).reason).toBe('completed');
    const text = events.filter((e) => e.type === 'delta').map((e) => e.data).join('');
    expect(text).toBe('Hi');
    expect(events.some((e) => e.type === 'status')).toBe(true); // told the UI it was waiting
    expect(calls).toBe(2); // first attempt rate-limited, retry succeeded
  });
});

/**
 * An SSE body that produces `count` deltas and then hangs: the stream only ends
 * when the caller aborts it, which is what a budget is for. Like a real fetch, an
 * aborted caller stops receiving — the point of these tests is that the answer is
 * cut short, not merely that the request eventually finishes.
 */
function endlessResponse(delta, count, signal) {
  const encoder = new TextEncoder();
  const parts = Array.from({ length: count }, () => `data: {"choices":[{"delta":{"content":"${delta}"}}]}\n\n`);
  let index = 0;
  const halted = () => Promise.reject(new Error('stream halted'));
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read() {
            if (signal?.aborted) return halted();
            if (index < parts.length) {
              const value = encoder.encode(parts[index]);
              index += 1;
              return Promise.resolve({ done: false, value });
            }
            return new Promise((_, reject) => {
              const halt = () => reject(new Error('stream halted'));
              if (!signal) return;
              if (signal.aborted) halt();
              else signal.addEventListener('abort', halt, { once: true });
            });
          },
        };
      },
    },
  };
}

describe('aiService complete budget', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  const messages = [{ role: 'user', content: 'explain the failure' }];

  it('caps a one-shot answer at the ghost-text budget when nothing wider is asked for', async () => {
    global.fetch = async (url, init) => endlessResponse('0123456789'.repeat(5), 400, init.signal);
    const service = createAiService({ onEvent: () => {}, secretStore, logger });

    const result = await service.complete({ provider: 'pollinations', messages });
    expect(result.text.length).toBeGreaterThanOrEqual(1200);
    // A whole ten-thousand-character answer would mean the budget was ignored.
    expect(result.text.length).toBeLessThan(1500);
  });

  it('honours a wider answer budget for a caller that needs the whole paragraph', async () => {
    global.fetch = async (url, init) => endlessResponse('0123456789'.repeat(5), 400, init.signal);
    const service = createAiService({ onEvent: () => {}, secretStore, logger });

    const result = await service.complete({ provider: 'pollinations', messages, maxChars: 2000 });
    expect(result.text.length).toBeGreaterThanOrEqual(2000);
    expect(result.text.length).toBeLessThan(2300);
    expect(result.provider).toBe('pollinations');
    expect(result.model).toBeTruthy();
  });

  it('applies the caller\'s timeout instead of the inline one', async () => {
    let started = 0;
    global.fetch = async (url, init) => {
      started += 1;
      // Never delivers a single byte: only the caller's deadline can end this.
      return endlessResponse('', 0, init.signal);
    };
    const service = createAiService({ onEvent: () => {}, secretStore, logger });

    const began = Date.now();
    const result = await service.complete({ provider: 'pollinations', messages, timeoutMs: 50 });
    const waited = Date.now() - began;

    expect(started).toBe(1);
    expect(waited).toBeLessThan(5000); // not the ghost-text default, and not forever
    expect(result.text).toBe('');
    expect(result.reason).toBeTruthy(); // says why there is no answer
  });

  it('reports that a key is needed rather than throwing at the caller', async () => {
    global.fetch = async () => { throw new Error('should not be reached'); };
    const service = createAiService({ onEvent: () => {}, secretStore, logger });

    const result = await service.complete({ provider: 'openai', messages });
    expect(result.text).toBe('');
    expect(result.reason).toBeTruthy();
  });
});
