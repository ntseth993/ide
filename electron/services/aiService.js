/**
 * AI service orchestrator.
 *
 * Manages streaming chat runs across many providers: resolves the API key per
 * provider (secret store, then environment variable), gates runs against the
 * signed-in account's local token budget, tracks active runs for cancellation,
 * and forwards provider events to the renderer. Adding a backend is just a new
 * entry in ai/providers.js.
 */
const { getProvider, getModule, describeProviders } = require('./ai/providers');

const MAX_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 24000;
const VALID_ROLES = new Set(['system', 'user', 'assistant']);
const CHARS_PER_TOKEN = 4; // rough heuristic for local budget metering

// Inline completions are latency- and cost-critical: bound the output and the
// wait instead of letting a model ramble.
const COMPLETION_TIMEOUT_MS = 12000;
const COMPLETION_MAX_CHARS = 1200;
const COMPLETION_MESSAGE_CHARS = 9000;

function estimateTokens(chars) {
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) {
    throw new Error('messages must be an array.');
  }
  const cleaned = [];
  for (const message of messages.slice(-MAX_MESSAGES)) {
    if (!message || typeof message !== 'object') continue;
    const role = String(message.role || '').toLowerCase();
    if (!VALID_ROLES.has(role)) continue;
    const content = typeof message.content === 'string' ? message.content : '';
    if (!content.trim()) continue;
    cleaned.push({ role, content: content.slice(0, MAX_MESSAGE_CHARS) });
  }
  if (cleaned.length === 0) {
    throw new Error('A message is required.');
  }
  return cleaned;
}

function envKeyName(providerId) {
  return `NOVACODE_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '')}_API_KEY`;
}

function createAiService({ onEvent, secretStore, logger, auth }) {
  const runs = new Map();
  let nextRunId = 1;

  async function resolveApiKey(providerId) {
    const stored = await secretStore.getSecret(providerId);
    if (stored) return { key: stored, source: 'stored' };
    const fromEnv = process.env[envKeyName(providerId)];
    // Back-compat: the original single-key env var still satisfies OpenAI.
    if (fromEnv || (providerId === 'openai' && process.env.NOVACODE_OPENAI_API_KEY)) {
      return { key: fromEnv || process.env.NOVACODE_OPENAI_API_KEY, source: 'env' };
    }
    return { key: null, source: null };
  }

  function start({ provider, messages, model, baseUrl, temperature } = {}) {
    return (async () => {
      const runId = `ai-${nextRunId}`;
      nextRunId += 1;

      const meta = getProvider(provider);
      const { module: providerModule } = getModule(meta.id);

      // Gate on the signed-in account's local token budget, when auth is wired.
      if (auth) {
        const quota = await auth.hasQuota();
        if (!quota.ok) {
          onEvent({ runId, type: 'error', data: quota.error });
          onEvent({ runId, type: 'done', data: JSON.stringify({ reason: 'no-quota' }) });
          return { runId };
        }
      }

      let apiKey = null;
      if (meta.requiresKey) {
        const resolved = await resolveApiKey(meta.id);
        apiKey = resolved.key;
        if (!apiKey) {
          onEvent({
            runId,
            type: 'error',
            data: `No API key configured for ${meta.label}. Add your ${meta.label} key in the assistant settings to start chatting.`,
          });
          onEvent({ runId, type: 'done', data: JSON.stringify({ reason: 'no-key' }) });
          return { runId };
        }
      }

      let cleanedMessages;
      try {
        cleanedMessages = sanitizeMessages(messages);
      } catch (error) {
        onEvent({ runId, type: 'error', data: error.message });
        onEvent({ runId, type: 'done', data: JSON.stringify({ reason: 'error' }) });
        return { runId };
      }

      const abortController = new AbortController();
      runs.set(runId, abortController);

      const resolvedBaseUrl = baseUrl || meta.baseUrl;
      const resolvedModel = model || meta.defaultModel;
      onEvent({ runId, type: 'start', data: JSON.stringify({ provider: meta.id, model: resolvedModel }) });

      const promptChars = cleanedMessages.reduce((sum, m) => sum + m.content.length, 0);

      providerModule
        .streamChat({
          baseUrl: resolvedBaseUrl,
          apiKey,
          model: resolvedModel,
          messages: cleanedMessages,
          temperature,
          signal: abortController.signal,
          onDelta: (delta) => onEvent({ runId, type: 'delta', data: delta }),
        })
        .then(async (result) => {
          logger.info('ai run finished', { runId, provider: meta.id, chars: result.text.length });
          if (auth) {
            const used = estimateTokens(promptChars + result.text.length);
            const charged = await auth.consume({ tokens: used });
            if (charged.account) onEvent({ runId, type: 'account', data: JSON.stringify(charged.account) });
          }
          onEvent({ runId, type: 'done', data: JSON.stringify({ reason: 'completed', finishReason: result.finishReason }) });
        })
        .catch((error) => {
          if (error.cancelled || abortController.signal.aborted) {
            onEvent({ runId, type: 'done', data: JSON.stringify({ reason: 'cancelled' }) });
          } else {
            logger.error('ai run failed', { runId, error: error.message });
            onEvent({ runId, type: 'error', data: error.message });
            onEvent({ runId, type: 'done', data: JSON.stringify({ reason: 'error' }) });
          }
        })
        .finally(() => runs.delete(runId));

      return { runId };
    })();
  }

  function cancel(runId) {
    const controller = runs.get(runId);
    if (!controller) return { ok: false };
    controller.abort(new Error('Cancelled'));
    return { ok: true };
  }

  /**
   * One-shot, non-streaming completion for inline (ghost text) suggestions.
   * Reuses the streaming transport so every provider works, then aborts once
   * enough text has arrived. Never throws at the caller: a failure simply
   * means "no suggestion", which the editor renders silently.
   * @returns {Promise<{ text: string, reason?: string, error?: string }>}
   */
  async function complete({ provider, messages, model, baseUrl, temperature } = {}) {
    const meta = getProvider(provider);
    const { module: providerModule } = getModule(meta.id);

    // AI is a member feature: the same gate as chat, minus the error toast.
    if (auth) {
      const quota = await auth.hasQuota();
      if (!quota.ok) return { text: '', reason: quota.error };
    }

    let apiKey = null;
    if (meta.requiresKey) {
      const resolved = await resolveApiKey(meta.id);
      apiKey = resolved.key;
      if (!apiKey) return { text: '', reason: 'no-key' };
    }

    let cleaned;
    try {
      cleaned = sanitizeMessages(messages).map((message) => ({
        ...message,
        content: message.content.slice(0, COMPLETION_MESSAGE_CHARS),
      }));
    } catch {
      return { text: '', reason: 'invalid' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Timed out')), COMPLETION_TIMEOUT_MS);
    // Unique key per request so overlapping completions never evict each other.
    const completionId = `complete-${nextRunId}`;
    nextRunId += 1;
    runs.set(completionId, controller);
    let text = '';
    let failed = null;

    try {
      await providerModule.streamChat({
        baseUrl: baseUrl || meta.baseUrl,
        apiKey,
        model: model || meta.defaultModel,
        messages: cleaned,
        temperature: typeof temperature === 'number' ? temperature : 0,
        signal: controller.signal,
        onDelta: (delta) => {
          text += delta;
          // Enough is enough: stop the stream, keep what we have.
          if (text.length > COMPLETION_MAX_CHARS) controller.abort(new Error('Truncated'));
        },
      });
    } catch (error) {
      const aborted = error.cancelled || controller.signal.aborted;
      if (!aborted) failed = error.message;
    } finally {
      clearTimeout(timer);
      runs.delete(completionId);
    }

    if (failed) {
      logger.warn?.('ai completion failed', { provider: meta.id, error: failed });
      return { text: '', reason: 'error', error: failed };
    }

    const trimmed = text.trim();
    if (!trimmed) return { text: '', reason: 'empty' };

    if (auth) {
      const used = estimateTokens(cleaned.reduce((sum, m) => sum + m.content.length, 0) + trimmed.length);
      const charged = await auth.consume({ tokens: used });
      if (charged.account) onEvent({ runId: completionId, type: 'account', data: JSON.stringify(charged.account) });
    }
    return { text: trimmed, provider: meta.id, model: model || meta.defaultModel };
  }

  function dispose() {
    for (const controller of runs.values()) controller.abort(new Error('Cancelled'));
    runs.clear();
  }

  async function checkConnection({ provider, baseUrl } = {}) {
    const meta = getProvider(provider);
    const { module: providerModule } = getModule(meta.id);
    let apiKey = null;
    if (meta.requiresKey) {
      const resolved = await resolveApiKey(meta.id);
      apiKey = resolved.key;
      if (!apiKey) {
        return { ok: false, error: `No API key configured for ${meta.label} yet.` };
      }
    }
    return providerModule.checkConnection({ baseUrl: baseUrl || meta.baseUrl, apiKey });
  }

  async function keyStatus({ provider } = {}) {
    const meta = getProvider(provider);
    const stored = await secretStore.getSecretSource(meta.id);
    const fromEnv = Boolean(process.env[envKeyName(meta.id)] || (meta.id === 'openai' && process.env.NOVACODE_OPENAI_API_KEY));
    return { provider: meta.id, hasKey: Boolean(stored) || fromEnv || !meta.requiresKey, source: stored, requiresKey: meta.requiresKey };
  }

  return { start, complete, cancel, dispose, checkConnection, keyStatus, providers: describeProviders };
}

module.exports = { createAiService, sanitizeMessages, estimateTokens };
