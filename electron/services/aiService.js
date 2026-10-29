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

// Free, keyless provider used as a silent safety net when the selected one is
// unreachable, so a chat message still gets an answer without any setup.
const FALLBACK_PROVIDER = 'pollinations';

// Inline completions are latency- and cost-critical: bound the output and the
// wait instead of letting a model ramble.
const COMPLETION_TIMEOUT_MS = 12000;
const COMPLETION_MAX_CHARS = 1200;
const COMPLETION_MESSAGE_CHARS = 9000;

function estimateTokens(chars) {
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}

// Free-tier rate limits and transient faults are worth a short, bounded wait
// and retry so a message still gets an answer instead of erroring out.
const MAX_RETRY_WAITS = 2;
const DEFAULT_RETRY_WAIT_MS = 30000;
const MAX_RETRY_WAIT_MS = 35000;

/** Await `ms`, resolving early if the run is cancelled, so waits stay responsive. */
function delay(ms, signal) {
  return new Promise((resolve) => {
    if (!ms || ms <= 0) resolve();
    else {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    }
  });
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

  function start({ provider, messages, model, baseUrl, temperature } = {}, emit = onEvent) {
    return (async () => {
      const runId = `ai-${nextRunId}`;
      nextRunId += 1;

      const meta = getProvider(provider);

      // Gate on the signed-in account's local token budget, when auth is wired.
      if (auth) {
        const quota = await auth.hasQuota();
        if (!quota.ok) {
          emit({ runId, type: 'error', data: quota.error });
          emit({ runId, type: 'done', data: JSON.stringify({ reason: 'no-quota' }) });
          return { runId };
        }
      }

      // A selected provider without a key (Gemini/Claude/OpenAI) must never
      // dead-end the chat: fall back to the free, keyless provider so the
      // message still gets an answer, and say so honestly in the UI.
      let effectiveMeta = meta;
      let apiKey = null;
      if (meta.requiresKey) {
        const resolved = await resolveApiKey(meta.id);
        apiKey = resolved.key;
        if (!apiKey) {
          const fb = getProvider(FALLBACK_PROVIDER);
          if (meta.id === fb.id) {
            emit({
              runId,
              type: 'error',
              data: `No API key configured for ${meta.label}. Add your ${meta.label} key in the assistant settings to start chatting.`,
            });
            emit({ runId, type: 'done', data: JSON.stringify({ reason: 'no-key' }) });
            return { runId };
          }
          effectiveMeta = fb;
          apiKey = null;
          emit({ runId, type: 'status', data: `${meta.label} needs an API key you have not added yet — answering with the free provider instead.` });
        }
      }

      let cleanedMessages;
      try {
        cleanedMessages = sanitizeMessages(messages);
      } catch (error) {
        emit({ runId, type: 'error', data: error.message });
        emit({ runId, type: 'done', data: JSON.stringify({ reason: 'error' }) });
        return { runId };
      }

      const abortController = new AbortController();
      runs.set(runId, abortController);

      const usedCallerConfig = effectiveMeta.id === meta.id;
      const resolvedBaseUrl = (usedCallerConfig && baseUrl) || effectiveMeta.baseUrl;
      const resolvedModel = (usedCallerConfig && model) || effectiveMeta.defaultModel;
      emit({ runId, type: 'start', data: JSON.stringify({ provider: effectiveMeta.id, model: resolvedModel }) });

      const promptChars = cleanedMessages.reduce((sum, m) => sum + m.content.length, 0);
      // Tracks whether anything reached the UI, so a fallback only restarts a
      // turn that is still blank (never one that already streamed text).
      let emittedDelta = false;

      async function attempt({ id, url, mdl, key, reasoningEffort }) {
        const { module: mod } = getModule(id);
        return mod.streamChat({
          baseUrl: url,
          apiKey: key,
          model: mdl,
          messages: cleanedMessages,
          temperature,
          reasoningEffort,
          signal: abortController.signal,
          onDelta: (delta) => {
            emittedDelta = true;
            emit({ runId, type: 'delta', data: delta });
          },
        });
      }

      // Retry a rate-limited / transient failure up to MAX_RETRY_WAITS times,
      // honoring Retry-After and telling the UI it is waiting. Never retries once
      // text has started streaming (that would duplicate the answer).
      async function attemptWithRetry(cfg) {
        let waits = 0;
        for (;;) {
          try {
            return await attempt(cfg);
          } catch (error) {
            const canRetry = error.retryable && !emittedDelta && waits < MAX_RETRY_WAITS
              && !error.cancelled && !abortController.signal.aborted;
            if (!canRetry) throw error;
            waits += 1;
            const waitMs = Math.min(error.retryAfterMs || DEFAULT_RETRY_WAIT_MS, MAX_RETRY_WAIT_MS);
            emit({ runId, type: 'status', data: `The AI is busy — waiting ${Math.ceil(waitMs / 1000)}s then retrying (${waits}/${MAX_RETRY_WAITS})…` });
            await delay(waitMs, abortController.signal);
            if (abortController.signal.aborted) {
              const cancelled = new Error('Cancelled');
              cancelled.cancelled = true;
              throw cancelled;
            }
          }
        }
      }

      async function settle(result, providerId) {
        logger.info('ai run finished', { runId, provider: providerId, chars: result.text.length });
        if (auth) {
          const used = estimateTokens(promptChars + result.text.length);
          const charged = await auth.consume({ tokens: used });
          if (charged.account) emit({ runId, type: 'account', data: JSON.stringify(charged.account) });
        }
        emit({ runId, type: 'done', data: JSON.stringify({ reason: 'completed', finishReason: result.finishReason }) });
      }

      (async () => {
        try {
          const result = await attemptWithRetry({ id: effectiveMeta.id, url: resolvedBaseUrl, mdl: resolvedModel, key: apiKey, reasoningEffort: effectiveMeta.reasoningEffort });
          await settle(result, effectiveMeta.id);
        } catch (error) {
          if (error.cancelled || abortController.signal.aborted) {
            emit({ runId, type: 'done', data: JSON.stringify({ reason: 'cancelled' }) });
            return;
          }
          logger.error('ai run failed', { runId, provider: effectiveMeta.id, error: error.message });
          // Selected provider is down/unreachable and nothing was shown yet:
          // silently retry on the free, keyless provider so the message still
          // gets an answer. Skipped when the primary already IS the fallback.
          if (effectiveMeta.id !== FALLBACK_PROVIDER && !emittedDelta) {
            const fb = getProvider(FALLBACK_PROVIDER);
            try {
              emit({ runId, type: 'start', data: JSON.stringify({ provider: fb.id, model: fb.defaultModel }) });
              const result = await attemptWithRetry({ id: fb.id, url: fb.baseUrl, mdl: fb.defaultModel, key: null, reasoningEffort: fb.reasoningEffort });
              logger.info('ai run recovered via fallback', { runId, from: meta.id, to: fb.id });
              await settle(result, fb.id);
              return;
            } catch (fallbackError) {
              if (fallbackError.cancelled || abortController.signal.aborted) {
                emit({ runId, type: 'done', data: JSON.stringify({ reason: 'cancelled' }) });
                return;
              }
              logger.error('ai fallback run failed', { runId, error: fallbackError.message });
              emit({ runId, type: 'error', data: `${error.message} The free fallback also failed: ${fallbackError.message}` });
              emit({ runId, type: 'done', data: JSON.stringify({ reason: 'error' }) });
              return;
            }
          }
          emit({ runId, type: 'error', data: error.message });
          emit({ runId, type: 'done', data: JSON.stringify({ reason: 'error' }) });
        } finally {
          runs.delete(runId);
        }
      })();

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
  async function complete({ provider, messages, model, baseUrl, temperature } = {}, emit = onEvent) {
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
      if (charged.account) emit({ runId: completionId, type: 'account', data: JSON.stringify(charged.account) });
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
