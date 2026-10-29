import { describe, expect, it } from 'vitest';
import {
  extractDelta,
  extractFinishReason,
  mapHttpError,
  streamChat,
} from '../electron/services/ai/openaiProvider';

describe('openaiProvider.mapHttpError', () => {
  it('gives actionable messages for common statuses', () => {
    expect(mapHttpError(401, '')).toContain('API key');
    expect(mapHttpError(403, '')).toContain('Access denied');
    expect(mapHttpError(404, '')).toContain('base URL');
    expect(mapHttpError(429, '')).toContain('Rate limit');
    expect(mapHttpError(500, '')).toContain('server error');
    expect(mapHttpError(418, '')).toContain('418');
  });

  it('includes provider detail when present', () => {
    const message = mapHttpError(401, JSON.stringify({ error: { message: 'bad key' } }));
    expect(message).toContain('bad key');
  });
});

describe('openaiProvider chunk extraction', () => {
  it('extracts deltas and finish reasons', () => {
    expect(extractDelta({ choices: [{ delta: { content: 'hi' } }] })).toBe('hi');
    expect(extractDelta({ choices: [{ delta: {} }] })).toBe('');
    expect(extractDelta({})).toBe('');
    expect(extractFinishReason({ choices: [{ finish_reason: 'stop' }] })).toBe('stop');
    expect(extractFinishReason({})).toBeNull();
  });
});

describe('openaiProvider.streamChat', () => {
  function sseResponse(chunks) {
    const encoder = new TextEncoder();
    let index = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            read() {
              if (index < chunks.length) {
                const value = encoder.encode(chunks[index]);
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

  it('streams deltas and returns the full text', async () => {
    const deltas = [];
    const result = await streamChat({
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'k-test',
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      onDelta: (delta) => deltas.push(delta),
    });
    expect(result.text).toBe('Hello');
    expect(result.finishReason).toBe('stop');
    expect(deltas).toEqual(['He', 'llo']);
  });

  it('maps HTTP errors to friendly messages', async () => {
    await expect(
      streamChat({
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'k',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl: async () => ({ ok: false, status: 401, text: async () => '' }),
        onDelta: () => {},
      }),
    ).rejects.toThrow('API key');
  });

  it('never surfaces hidden reasoning as an answer; retries instead', async () => {
    const deltas = [];
    await expect(
      streamChat({
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'k',
        model: 'openai-fast',
        messages: [{ role: 'user', content: 'hard question' }],
        fetchImpl: async () =>
          sseResponse([
            'data: {"choices":[{"delta":{"reasoning":"think "}}]}\n\n',
            'data: {"choices":[{"delta":{"reasoning":"hard"}}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
            'data: [DONE]\n\n',
          ]),
        onDelta: (delta) => deltas.push(delta),
      }),
    ).rejects.toMatchObject({ retryable: true });
    // Chain-of-thought must never leak into the visible answer.
    expect(deltas).toEqual([]);
  });

  it('treats a totally empty stream as a retryable transient', async () => {
    await expect(
      streamChat({
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'k',
        model: 'openai-fast',
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl: async () =>
          sseResponse(['data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n', 'data: [DONE]\n\n']),
        onDelta: () => {},
      }),
    ).rejects.toMatchObject({ retryable: true });
  });

  it('sends max_tokens and forwards reasoning_effort only when provided', async () => {
    let sentBody;
    const capture = async (_url, options) => {
      sentBody = JSON.parse(options.body);
      return sseResponse(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n']);
    };
    await streamChat({
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'k',
      model: 'openai-fast',
      messages: [{ role: 'user', content: 'hi' }],
      reasoningEffort: 'low',
      fetchImpl: capture,
      onDelta: () => {},
    });
    expect(sentBody.max_tokens).toBeGreaterThan(0);
    expect(sentBody.reasoning_effort).toBe('low');

    await streamChat({
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'k',
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: capture,
      onDelta: () => {},
    });
    expect(sentBody).not.toHaveProperty('reasoning_effort');
  });
});
