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
    // Free, anonymous, no-key chat over the OpenAI-compatible protocol. This is
    // the out-of-the-box default so a fresh install answers immediately with no
    // setup. Rate-limited per IP (about one request every 30s) and best-effort;
    // switch to Ollama (private/local) or a keyed provider for heavier use.
    // Default to the fast model: the reasoning model ('openai') can stall ~40s
    // before its first token, which reads as "not responding" for longer asks.
    // reasoningEffort 'low' keeps these gpt-oss backends from spending the whole
    // output budget on hidden thinking and returning an empty answer.
    id: 'pollinations', label: 'Pollinations (free, no key)', kind: 'openai',
    baseUrl: 'https://text.pollinations.ai/v1', defaultModel: 'openai-fast',
    models: ['openai-fast', 'openai'], requiresKey: false, reasoningEffort: 'low',
  },
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
    baseUrl: 'http://localhost:11434', defaultModel: 'llama3.2',
    models: [], requiresKey: false,
  },
  {
    // A self-hostable OpenAI-compatible proxy (see /gateway). The user's key
    // lives on that server, never in the app, so this provider needs no per-user
    // API key: pick it, point the Base URL at your gateway, and chat/inline just
    // work over the internet. The server routes `model` to OpenAI/Claude/Gemini.
    id: 'gateway', label: 'NovaCode Gateway', kind: 'openai',
    baseUrl: '', defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'claude-3-5-sonnet-latest', 'gemini-1.5-flash'],
    requiresKey: false,
  },
];

const DEFAULT_PROVIDER = 'pollinations';

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
