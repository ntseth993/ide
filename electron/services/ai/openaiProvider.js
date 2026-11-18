/**
 * OpenAI-compatible chat provider.
 *
 * Speaks the /chat/completions protocol (OpenAI, and any compatible local
 * runtime such as LM Studio or Ollama's OpenAI endpoint). The renderer never
 * talks to the network: this module runs in the main process and receives
 * the API key resolved by aiService.
 */
const { createSseParser } = require('./sse');

const DEFAULT_TIMEOUT_MS = 120000;

// Reasoning models (e.g. the free Pollinations gpt-oss backends) spend output
// budget on hidden "reasoning" tokens before emitting any visible "content".
// The server's small default cap can be consumed entirely by reasoning, which
// yields an empty answer with finish_reason "length". Ask for a generous budget
// so the visible answer always has room. Overridable per call via `maxTokens`.
const DEFAULT_MAX_TOKENS = 4096;

/** Map HTTP failures to honest, actionable messages. */
function mapHttpError(status, bodyText) {
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed?.error?.message || parsed?.message || '';
  } catch {
    detail = bodyText.slice(0, 200);
  }
  switch (status) {
    case 401:
      return `Authentication failed (401). Check that your API key is valid.${detail ? ` Provider said: ${detail}` : ''}`;
    case 403:
      return `Access denied (403). Your key may lack access to this model.${detail ? ` Provider said: ${detail}` : ''}`;
    case 404:
      return `Model or endpoint not found (404). Verify the base URL and model name.${detail ? ` Provider said: ${detail}` : ''}`;
    case 429:
      return `Rate limit or quota exceeded (429). Wait a moment or check your plan/billing.${detail ? ` Provider said: ${detail}` : ''}`;
    case 402:
      return `The free AI endpoint is rate-limited right now (about one request every 30 seconds). Wait a moment and resend, or add your own key in Settings for faster, unlimited use.`;
    default:
      if (status >= 500) return `Provider server error (${status}). Try again shortly.${detail ? ` ${detail}` : ''}`;
      return `Request failed with status ${status}.${detail ? ` ${detail}` : ''}`;
  }
}

/** Extract the assistant text delta from one streaming chunk. */
function extractDelta(chunk) {
  return chunk?.choices?.[0]?.delta?.content ?? '';
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
function parseRetryAfterMs(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

// Node's global fetch reports every transport-level failure as a bare
// `TypeError: fetch failed`; the real reason lives one level down in
// `error.cause` (a DNS / connection / TLS / proxy system error). Recognise that
// shape so we can turn the useless message into something actionable.
const NETWORK_CAUSE_RE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EPIPE|ECANCELED|ENETUNREACH|ENETDOWN|EHOSTUNREACH|ETIMEDOUT|UND_ERR_CONNECT|UND_ERR_HEADERS|UND_ERR_SOCKET|socket hang up|certificate|cert_chain|self[- ]signed|unable_to_verify|ssl|tls|proxy|tunneling/i;

function isFetchTransportError(error) {
  if (!error || typeof error !== 'object') return false;
  const message = String(error.message || '');
  const cause = error.cause || {};
  const causeText = `${cause.code || ''} ${cause.message || cause.syscall || ''}`;
  const looksLikeFetchFailure = error.name === 'TypeError' && /fetch failed|network error|load failed/i.test(message);
  return looksLikeFetchFailure || Boolean(cause.code) || NETWORK_CAUSE_RE.test(causeText);
}

/** Turn an opaque fetch transport error into a specific, helpful message. */
function networkFailureMessage(error) {
  const cause = (error && error.cause) || {};
  const signal = `${cause.code || ''} ${cause.message || ''} ${error && error.message || ''}`.toLowerCase();
  if (/enotfound|eai_again|getaddrinfo/.test(signal)) {
    return 'Could not reach the AI provider: the web address could not be resolved. Check your internet connection or DNS.';
  }
  if (/enetunreach|enetdown|ehostunreach/.test(signal)) {
    return 'Could not reach the AI provider: this machine has no route to it. Check your network connection.';
  }
  if (/econnrefused|connection refused/.test(signal)) {
    return 'Could not connect to the AI provider: the connection was refused, usually by a firewall or proxy. Allow the provider domain and try again.';
  }
  if (/econnreset|epipe|socket hang up|und_err_socket|econnclosed/.test(signal)) {
    return 'The connection to the AI provider dropped mid-request. This is often a flaky network or an interrupting proxy — please retry.';
  }
  if (/etimedout|und_err_connect|und_err_headers|connect timeout|timed out/.test(signal)) {
    return 'Connecting to the AI provider timed out. Check your internet connection or proxy settings, then try again.';
  }
  if (/certificate|self[- ]signed|unable_to_verify|unknown ca|ssl|tls|tunneling/.test(signal)) {
    return 'Your network appears to intercept encrypted traffic (a corporate proxy or firewall), so the AI provider\u2019s security certificate could not be verified. Try another network, or point NovaCode at a local provider such as Ollama.';
  }
  if (/proxy/.test(signal)) {
    return 'A proxy blocked the request to the AI provider. Check your proxy settings or allow the provider domain.';
  }
  return 'Could not reach the AI provider. Check your internet connection (and any firewall or proxy), then try again.';
}

function extractFinishReason(chunk) {
  return chunk?.choices?.[0]?.finish_reason ?? null;
}

/**
 * Stream a chat completion.
 * @param {object} params
 * @param {string} params.baseUrl   e.g. https://api.openai.com/v1
 * @param {string} params.apiKey
 * @param {string} params.model
 * @param {Array<{role:string,content:string}>} params.messages
 * @param {number} [params.temperature]
 * @param {AbortSignal} [params.signal]
 * @param {(delta: string) => void} params.onDelta
 * @returns {Promise<{ text: string, finishReason: string|null }>}
 */
async function streamChat({ baseUrl, apiKey, model, messages, temperature, signal, timeoutMs = DEFAULT_TIMEOUT_MS, maxTokens, reasoningEffort, onDelta, fetchImpl = fetch }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const onAbort = () => controller.abort(new Error('Cancelled'));
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        // Keyless providers (Pollinations free tier, local gateways) reject a
        // `Bearer null` header, so only send Authorization when we have a key.
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: typeof temperature === 'number' ? temperature : 0.2,
        stream: true,
        max_tokens: typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS,
        // Only sent for providers that opt in (see ai/providers.js). Keeps the
        // free gpt-oss backends from starving visible content with hidden
        // reasoning; other providers never receive this field.
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      const err = new Error(mapHttpError(response.status, bodyText));
      err.httpStatus = response.status;
      // Rate limits (free tier) and transient server faults are worth retrying
      // after a short wait so a message still gets an answer.
      err.retryable = response.status === 402 || response.status === 429 || response.status >= 500;
      err.retryAfterMs = parseRetryAfterMs(response.headers?.get?.('retry-after'));
      throw err;
    }
    if (!response.body) {
      throw new Error('The provider returned an empty response stream.');
    }

    const decoder = new TextDecoder();
    let fullText = '';
    let finishReason = null;
    const parser = createSseParser(({ data }) => {
      if (data === '[DONE]') return;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        return; // ignore keep-alive or malformed fragments
      }
      const delta = extractDelta(chunk);
      if (delta) {
        fullText += delta;
        onDelta(delta);
      }
      const finish = extractFinishReason(chunk);
      if (finish) finishReason = finish;
    });

    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.end();

    // No visible answer arrived (the model spent its budget on hidden reasoning
    // or was throttled). Never surface chain-of-thought as an answer — that
    // reads as an unrelated reply. Treat it as a transient miss so the caller
    // retries or falls back to a provider that returns a real answer.
    if (!fullText) {
      const err = new Error('The AI returned no answer. Retrying…');
      err.retryable = true;
      throw err;
    }
    return { text: fullText, finishReason };
  } catch (error) {
    if (error.name === 'AbortError') {
      const reason = controller.signal.reason instanceof Error ? controller.signal.reason.message : '';
      const err = new Error(reason === 'Cancelled' ? 'Cancelled' : `Request aborted. ${reason}`);
      err.cancelled = true;
      throw err;
    }
    if (isFetchTransportError(error)) {
      // Do NOT auto-retry a transport failure with backoff: a down network or a
      // blocked proxy will not recover in a few seconds, and waiting would stall
      // the UI. Flag it so aiService falls back to the other provider at once.
      const err = new Error(networkFailureMessage(error));
      err.retryable = false;
      err.network = true;
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Verify credentials and connectivity by listing models.
 * @returns {Promise<{ ok: boolean, models?: string[], error?: string }>}
 */
async function checkConnection({ baseUrl, apiKey, timeoutMs = 15000, fetchImpl = fetch }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      return { ok: false, error: mapHttpError(response.status, bodyText) };
    }
    const body = await response.json().catch(() => null);
    const models = Array.isArray(body?.data)
      ? body.data.map((m) => m?.id).filter((id) => typeof id === 'string').slice(0, 100)
      : [];
    return { ok: true, models };
  } catch (error) {
    if (error.name === 'AbortError') return { ok: false, error: 'Connection check timed out.' };
    if (isFetchTransportError(error)) return { ok: false, error: networkFailureMessage(error) };
    return { ok: false, error: `Could not reach the provider: ${error.message}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  checkConnection,
  extractDelta,
  extractFinishReason,
  isFetchTransportError,
  mapHttpError,
  networkFailureMessage,
  streamChat,
};
