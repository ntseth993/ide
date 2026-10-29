import { describe, expect, it } from 'vitest';
import {
  PROVIDERS, DEFAULT_PROVIDER, getProvider, getModule, describeProviders,
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

  it('trims descriptors down to renderer-safe fields', () => {
    for (const entry of describeProviders()) {
      expect(Object.keys(entry).sort()).toEqual(
        ['baseUrl', 'defaultModel', 'id', 'kind', 'label', 'models', 'requiresKey'].sort(),
      );
    }
  });
});
