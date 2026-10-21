/**
 * Provider registry.
 *
 * One place that knows every AI backend NovaCode can talk to. `kind` selects
 * the wire protocol (a provider module), so OpenAI-compatible gateways (Groq,
 * OpenRouter, local LM Studio) reuse the OpenAI module with different defaults.
 * The renderer only ever sees the trimmed descriptors from `describeProviders`.
 */
const openai = require('./openaiProvider');
const anthropic = require('./anthropicProvider');
const gemini = require('./geminiProvider');
const ollama = require('./ollamaProvider');

const MODULES = { openai, anthropic, gemini, ollama };

const PROVIDERS = [
  {
    id: 'openai', label: 'OpenAI', kind: 'openai',
    baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'o3-mini'], requiresKey: true,
  },
  {
    id: 'anthropic', label: 'Anthropic Claude', kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-3-5-haiku-latest',
    models: ['claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest', 'claude-3-opus-latest'], requiresKey: true,
  },
  {
    id: 'gemini', label: 'Google Gemini', kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-1.5-flash',
    models: ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.0-pro'], requiresKey: true,
  },
  {
    id: 'groq', label: 'Groq', kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'], requiresKey: true,
  },
  {
    id: 'openrouter', label: 'OpenRouter', kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-4o-mini',
    models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'meta-llama/llama-3.3-70b-instruct'], requiresKey: true,
  },
  {
    id: 'ollama', label: 'Ollama (local)', kind: 'ollama',
    baseUrl: 'http://localhost:11434', defaultModel: 'llama3.1',
    models: [], requiresKey: false,
  },
];

const DEFAULT_PROVIDER = 'openai';

function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS.find((p) => p.id === DEFAULT_PROVIDER);
}

function getModule(providerId) {
  const provider = getProvider(providerId);
  return { provider, module: MODULES[provider.kind] };
}

/** Trimmed descriptors safe to expose to the renderer. */
function describeProviders() {
  return PROVIDERS.map(({ id, label, kind, baseUrl, defaultModel, models, requiresKey }) => ({
    id, label, kind, baseUrl, defaultModel, models, requiresKey,
  }));
}

module.exports = { PROVIDERS, MODULES, DEFAULT_PROVIDER, getProvider, getModule, describeProviders };
