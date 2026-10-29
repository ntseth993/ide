/**
 * Provider registry + Anthropic / Gemini / Ollama providers: payload mapping,
 * delta extraction, and end-to-end streaming against a fake fetch.
 */
import { describe, it, expect } from 'vitest';
import { describeProviders, getProvider, getModule } from '../electron/services/ai/providers';
import { extractDelta as anthropicDelta, toAnthropicPayload, streamChat as anthropicStream } from '../electron/services/ai/anthropicProvider';
import { extractDelta as geminiDelta, toGeminiPayload, streamChat as geminiStream } from '../electron/services/ai/geminiProvider';
import { extractDelta as ollamaDelta, streamChat as ollamaStream } from '../electron/services/ai/ollamaProvider';

/** A Response-like object whose body streams the given text parts. */
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

describe('provider registry', () => {
  it('describes every backend and defaults unknown ids to the free provider', () => {
    const ids = describeProviders().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['pollinations', 'openai', 'anthropic', 'gemini', 'groq', 'openrouter', 'ollama']));
    expect(getProvider('nope').id).toBe('pollinations');
    expect(getProvider('ollama').requiresKey).toBe(false);
    expect(getModule('anthropic').module).toHaveProperty('streamChat');
  });
});

describe('anthropicProvider', () => {
  it('pulls system out and maps roles', () => {
    const { system, turns } = toAnthropicPayload([
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ]);
    expect(system).toBe('be nice');
    expect(turns).toEqual([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }]);
  });

  it('extracts content_block_delta text', () => {
    expect(anthropicDelta({ type: 'content_block_delta', delta: { text: 'He' } })).toBe('He');
    expect(anthropicDelta({ type: 'message_start' })).toBe('');
  });

  it('streams a full answer', async () => {
    const deltas = [];
    const result = await anthropicStream({
      apiKey: 'k',
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: async () => streamResponse([
        'data: {"type":"content_block_delta","delta":{"text":"Hel"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"text":"lo"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
      onDelta: (d) => deltas.push(d),
    });
    expect(result.text).toBe('Hello');
    expect(result.finishReason).toBe('stop');
    expect(deltas).toEqual(['Hel', 'lo']);
  });
});

describe('geminiProvider', () => {
  it('maps contents and roles', () => {
    const { systemInstruction, contents } = toGeminiPayload([
      { role: 'system', content: 'ctx' },
      { role: 'assistant', content: 'ok' },
    ]);
    expect(systemInstruction).toBe('ctx');
    expect(contents).toEqual([{ role: 'model', parts: [{ text: 'ok' }] }]);
  });

  it('concatenates part deltas and streams', async () => {
    expect(geminiDelta({ candidates: [{ content: { parts: [{ text: 'A' }, { text: 'B' }] } }] })).toBe('AB');
    const result = await geminiStream({
      apiKey: 'k',
      model: 'gemini-test',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: async () => streamResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":" there"}]},"finishReason":"STOP"}]}\n\n',
      ]),
      onDelta: () => {},
    });
    expect(result.text).toBe('Hi there');
    expect(result.finishReason).toBe('stop');
  });
});

describe('ollamaProvider', () => {
  it('reads NDJSON lines', async () => {
    expect(ollamaDelta({ message: { content: 'x' } })).toBe('x');
    expect(ollamaDelta({ done: true })).toBe('');
    const result = await ollamaStream({
      model: 'llama3.1',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: async () => streamResponse([
        '{"message":{"content":"Hello"}}\n',
        '{"message":{"content":" world"}}\n',
        '{"done":true}\n',
      ]),
      onDelta: () => {},
    });
    expect(result.text).toBe('Hello world');
    expect(result.finishReason).toBe('stop');
  });
});
