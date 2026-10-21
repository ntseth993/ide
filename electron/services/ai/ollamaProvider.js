/**
 * Ollama chat provider — local models over the native /api/chat NDJSON stream.
 *
 * No API key: Ollama runs on the user's machine. Each streamed line is a
 * standalone JSON object; the last one carries `done: true`.
 */
const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_TIMEOUT_MS = 300000;

/** Pull the assistant text delta out of one NDJSON object. */
function extractDelta(obj) {
  return obj?.message?.content ?? '';
}

async function streamChat({
  baseUrl = DEFAULT_BASE_URL,
  model,
  messages,
  temperature,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onDelta,
  fetchImpl = fetch,
} = {}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(new Error('Cancelled'));
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);

  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        options: { temperature: typeof temperature === 'number' ? temperature : 0.2 },
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(bodyText ? `Ollama error (${response.status}): ${bodyText.slice(0, 200)}` : `Ollama error (${response.status}).`);
    }
    if (!response.body) throw new Error('Ollama returned an empty response stream.');

    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let finishReason = null;

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return;
      }
      const delta = extractDelta(obj);
      if (delta) {
        fullText += delta;
        onDelta(delta);
      }
      if (obj.done) finishReason = 'stop';
    };

    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        handleLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
      }
    }
    if (buffer.trim()) handleLine(buffer);
    return { text: fullText, finishReason };
  } catch (error) {
    if (error.name === 'AbortError') {
      const reason = controller.signal.reason instanceof Error ? controller.signal.reason.message : '';
      const err = new Error(reason === 'Cancelled' ? 'Cancelled' : `Request aborted. ${reason}`);
      err.cancelled = true;
      throw err;
    }
    if (error.cause?.code === 'ECONNREFUSED' || error.code === 'ECONNREFUSED') {
      throw new Error('Could not reach Ollama. Is it running locally? Start it with `ollama serve`.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function checkConnection({ baseUrl = DEFAULT_BASE_URL, timeoutMs = 8000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/tags`, { method: 'GET', signal: controller.signal });
    if (!response.ok) return { ok: false, error: `Ollama responded with status ${response.status}.` };
    const body = await response.json().catch(() => null);
    const models = Array.isArray(body?.models) ? body.models.map((m) => m?.name).filter(Boolean).slice(0, 100) : [];
    return { ok: true, models };
  } catch (error) {
    if (error.name === 'AbortError') return { ok: false, error: 'Connection check timed out.' };
    return { ok: false, error: `Could not reach Ollama: ${error.message}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { streamChat, checkConnection, extractDelta, DEFAULT_BASE_URL };
