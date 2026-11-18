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
    // Groq retired the free llama-3.3-70b-versatile / llama-3.1-8b-instant to
    // Enterprise-only, so a standard key now gets a 404 on them. These are the
    // chat models a normal Groq key can actually list (verified against
    // /openai/v1/models); gpt-oss-120b is the flagship reasoning default.
    baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'openai/gpt-oss-120b',
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'], requiresKey: true,
    // Single source of truth for which model powers each assistant mode (the
    // renderer reads this via the ai:providers IPC). Verified live against a
    // standard Groq key: all three return real content, not empty reasoning.
    modeModels: {
      agent: 'qwen/qwen3.8-27b',       // tool-heavy coding agent
      ask: 'openai/gpt-oss-20b',       // fast conversational answers
      reasoning: 'openai/gpt-oss-120b',// advanced reasoning (manual pick)
    },
    modelLabels: {
      'openai/gpt-oss-120b': 'GPT-OSS 120B · advanced reasoning',
      'openai/gpt-oss-20b': 'GPT-OSS 20B · fast',
      'qwen/qwen3.8-27b': 'Qwen3.8 27B · agent',
    },
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

// The AI is Groq-only for this build: every other backend stays in the registry
// (so existing sessions/config and the provider modules keep working), but only
// this id list is surfaced to the composer and Settings dropdowns. Expand it to
// re-enable another provider without touching the wire-protocol code.
const SELECTABLE_PROVIDER_IDS = ['groq'];

/** Provider descriptors offered in the UI, in list order, filtered to selectable ids. */
function selectableProviders() {
  return SELECTABLE_PROVIDER_IDS.map((id) => getProvider(id))
    .map(({ id, label, kind, baseUrl, defaultModel, models, requiresKey, modeModels, modelLabels }) => ({
      id, label, kind, baseUrl, defaultModel, models, requiresKey, modeModels, modelLabels,
    }));
}

module.exports = { PROVIDERS, MODULES, DEFAULT_PROVIDER, SELECTABLE_PROVIDER_IDS, getProvider, getModule, describeProviders, selectableProviders };
