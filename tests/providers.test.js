import { describe, expect, it } from 'vitest';
import {
  PROVIDERS, DEFAULT_PROVIDER, getProvider, getModule, describeProviders, selectableProviders,
} from '../electron/services/ai/providers';

describe('AI provider registry', () => {
  it('exposes OpenAI, Claude and Gemini as first-class providers', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['openai', 'anthropic', 'gemini']));
  });

  it('ships a keyless NovaCode Gateway that reuses the OpenAI wire protocol', () => {
    const gateway = getProvider('gateway');
    expect(gateway.id).toBe('gateway');
    expect(gateway.kind).toBe('openai');
    expect(gateway.requiresKey).toBe(false);
    // No key on the client: the credentials live on the self-hosted server.
    expect(gateway.baseUrl).toBe('');
    const { module: mod } = getModule('gateway');
    expect(typeof mod.streamChat).toBe('function');
  });

  it('falls back to the default provider for an unknown id', () => {
    expect(getProvider('does-not-exist').id).toBe(DEFAULT_PROVIDER);
  });

  it('offers only Groq in the UI selection while keeping the full registry', () => {
    expect(selectableProviders().map((p) => p.id)).toEqual(['groq']);
    // The rest still resolve internally, so existing config keeps working.
    expect(getProvider('ollama').requiresKey).toBe(false);
    expect(describeProviders().length).toBeGreaterThan(selectableProviders().length);
  });

  it('surfaces the per-mode Groq model config to the renderer', () => {
    const [groq] = selectableProviders();
    expect(groq.modeModels).toEqual({
      agent: 'qwen/qwen3.8-27b',
      ask: 'openai/gpt-oss-20b',
      reasoning: 'openai/gpt-oss-120b',
    });
    // Every mode model must be one the descriptor actually offers.
    for (const model of Object.values(groq.modeModels)) {
      expect(groq.models).toContain(model);
    }
    expect(groq.modelLabels['qwen/qwen3.8-27b']).toBeTruthy();
  });

  it('trims descriptors down to renderer-safe fields', () => {
    for (const entry of describeProviders()) {
      expect(Object.keys(entry).sort()).toEqual(
        ['baseUrl', 'defaultModel', 'id', 'kind', 'label', 'models', 'requiresKey'].sort(),
      );
    }
  });
});
