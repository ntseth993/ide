/**
 * Google Gemini chat provider — generateContent with SSE streaming.
 *
 * Uses the `?alt=sse` variant so we can reuse the shared SSE parser. The API
 * key travels as a query parameter (Google's documented REST auth), and the
 * conversation is expressed as `contents` with `user` / `model` roles.
 */
const { createSseParser } = require('./sse');
const { mapHttpError } = require('./openaiProvider');

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TIMEOUT_MS = 120000;

/** Concatenate every text part of one streaming candidate chunk. */
function extractDelta(chunk) {
  const parts = chunk?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
}

/** Map NovaCode messages onto Gemini contents + systemInstruction. */
function toGeminiPayload(messages) {
  const systemInstruction = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  return { systemInstruction, contents };
}

async function streamChat({
  baseUrl = DEFAULT_BASE_URL,
  apiKey,
  model,
  messages,
  temperature,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onDelta,
  fetchImpl = fetch,
} = {}) {
  const { systemInstruction, contents } = toGeminiPayload(messages);
  const url = `${baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey || '')}`;
  const controller = new AbortController();
  const onAbort = () => controller.abort(new Error('Cancelled'));
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
        generationConfig: { temperature: typeof temperature === 'number' ? temperature : 0.2 },
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
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        return;
      }
      const delta = extractDelta(chunk);
      if (delta) {
        fullText += delta;
        onDelta(delta);
      }
      const finish = chunk?.candidates?.[0]?.finishReason;
      if (finish) finishReason = String(finish).toLowerCase();
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
  const url = `${baseUrl.replace(/\/+$/, '')}/models?key=${encodeURIComponent(apiKey || '')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', signal: controller.signal });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      return { ok: false, error: mapHttpError(response.status, bodyText) };
    }
    const body = await response.json().catch(() => null);
    const models = Array.isArray(body?.models)
      ? body.models.map((m) => (typeof m?.name === 'string' ? m.name.replace(/^models\//, '') : null)).filter(Boolean).slice(0, 100)
      : [];
    return { ok: true, models };
  } catch (error) {
    if (error.name === 'AbortError') return { ok: false, error: 'Connection check timed out.' };
    return { ok: false, error: `Could not reach the provider: ${error.message}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { streamChat, checkConnection, extractDelta, toGeminiPayload, DEFAULT_BASE_URL };
