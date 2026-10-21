/**
 * Anthropic (Claude) chat provider — Messages API with streaming.
 *
 * Runs in the main process only. Translates the shared {role,content} message
 * list into Anthropic's shape (system prompt pulled out, alternating user /
 * assistant turns) and streams text deltas back through onDelta.
 */
const { createSseParser } = require('./sse');
const { mapHttpError } = require('./openaiProvider');

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 120000;

/** Pull the assistant text delta out of one Anthropic SSE event. */
function extractDelta(event) {
  if (event?.type === 'content_block_delta') return event?.delta?.text ?? '';
  return '';
}

/** Split a NovaCode message list into Anthropic system + conversation turns. */
function toAnthropicPayload(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const turns = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  return { system, turns };
}

async function streamChat({
  baseUrl = DEFAULT_BASE_URL,
  apiKey,
  model,
  messages,
  temperature,
  maxTokens = 2048,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onDelta,
  fetchImpl = fetch,
} = {}) {
  const { system, turns } = toAnthropicPayload(messages);
  const controller = new AbortController();
  const onAbort = () => controller.abort(new Error('Cancelled'));
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);

  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: turns,
        temperature: typeof temperature === 'number' ? temperature : 0.2,
        stream: true,
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(mapHttpError(response.status, bodyText));
    }
    if (!response.body) throw new Error('The provider returned an empty response stream.');

    const decoder = new TextDecoder();
    let fullText = '';
    let finishReason = null;
    const parser = createSseParser(({ data }) => {
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        return;
      }
      const delta = extractDelta(event);
      if (delta) {
        fullText += delta;
        onDelta(delta);
      }
      if (event.type === 'message_stop') finishReason = 'stop';
    });

    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.end();
    return { text: fullText, finishReason };
  } catch (error) {
    if (error.name === 'AbortError') {
      const reason = controller.signal.reason instanceof Error ? controller.signal.reason.message : '';
      const err = new Error(reason === 'Cancelled' ? 'Cancelled' : `Request aborted. ${reason}`);
      err.cancelled = true;
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function checkConnection({ baseUrl = DEFAULT_BASE_URL, apiKey, timeoutMs = 15000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      return { ok: false, error: mapHttpError(response.status, bodyText) };
    }
    const body = await response.json().catch(() => null);
    const models = Array.isArray(body?.data) ? body.data.map((m) => m?.id).filter(Boolean).slice(0, 100) : [];
    return { ok: true, models };
  } catch (error) {
    if (error.name === 'AbortError') return { ok: false, error: 'Connection check timed out.' };
    return { ok: false, error: `Could not reach the provider: ${error.message}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { streamChat, checkConnection, extractDelta, toAnthropicPayload, DEFAULT_BASE_URL };
