'use strict';
/**
 * Shared HTTP plumbing for the hosting-provider adapters.
 *
 * Both Vercel and Netlify are plain REST APIs, so every adapter needs the same
 * things: bearer auth, JSON or binary bodies, a hard timeout, bounded retries
 * for transient/rate-limited responses, and — the part that actually matters
 * for safety — error objects that describe the failure *without* echoing the
 * request headers back to the caller (a 401 body from some proxies includes the
 * Authorization header, and a rejected Error travels all the way to a Toast).
 *
 * Nothing here knows about a specific provider: `describeError` is the hook
 * adapters override to turn a provider's error payload into a message.
 */

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_BACKOFF_MS = 1500;

/** An HTTP failure that is safe to show a user. */
class ProviderApiError extends Error {
  constructor({ provider, status, message, code, detail }) {
    super(message);
    this.name = 'ProviderApiError';
    this.provider = provider;
    this.status = status || 0;
    this.code = code || null;
    this.detail = detail || null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Strip anything that looks like a credential from a server-provided string.
 * Vercel/Netlify echo parts of the request in `error.details` on some failures,
 * and our own `provider:token` secret names should never appear in a UI.
 */
function scrub(text) {
  return String(text || '')
    .replace(/Bearer\s+[A-Za-z0-9._-]{6,}/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9_-]{24,}/g, (m) => (/^[0-9a-f]+$/i.test(m) ? m : '[redacted]'))
    .slice(0, 400);
}

function appendQuery(pathname, query) {
  if (!query || typeof query !== 'object') return pathname;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${pathname}${pathname.includes('?') ? '&' : '?'}${qs}` : pathname;
}

/**
 * @param {{
 *   provider: string,
 *   baseUrl: string,
 *   token: string,
 *   fetchImpl?: Function,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 *   describeError?: (payload: any, status: number) => { message?: string, code?: string, detail?: string },
 *   extraHeaders?: Object,
 *   maxAttempts?: number,
 *   retryBackoffMs?: number,
 * }} options
 */
function createProviderClient({
  provider,
  baseUrl,
  token,
  fetchImpl,
  logger = console,
  describeError,
  extraHeaders = {},
  maxAttempts = MAX_ATTEMPTS,
  retryBackoffMs = RETRY_BACKOFF_MS,
}) {
  const doFetch = fetchImpl || fetch;
  // Provider ids are lowercase ('vercel'), but a message shown to a user should
  // still name the host properly.
  const label = String(provider || 'Provider').replace(/^[a-z]/, (c) => c.toUpperCase());

  async function once(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.__timeoutMs || DEFAULT_TIMEOUT_MS);
    try {
      const { __timeoutMs, ...fetchInit } = init;
      return await doFetch(url, { ...fetchInit, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @returns {Promise<{ status: number, body: any, headers: Headers }>}
   *   `body` is parsed JSON when the response looks like JSON, otherwise text.
   */
  async function request(pathname, {
    method = 'GET',
    query,
    headers = {},
    body,
    rawBody = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    accept = 'application/json',
  } = {}) {
    if (typeof token !== 'string' || !token.trim()) {
      throw new ProviderApiError({ provider, status: 0, message: 'No account token is connected for this provider.' });
    }
    const url = `${baseUrl}${appendQuery(pathname, query)}`;
    const init = {
      method,
      __timeoutMs: timeoutMs,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        ...extraHeaders,
        ...(rawBody ? { 'Content-Type': 'application/octet-stream' } : {}),
        ...headers,
      },
    };
    if (body !== undefined) init.body = rawBody ? body : JSON.stringify(body);
    if (!rawBody && body !== undefined && !headers['Content-Type']) {
      init.headers['Content-Type'] = 'application/json';
    }

    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response = null;
      try {
        response = await once(url, init);
      } catch (networkError) {
        // AbortError means our own timeout fired; either way it is retryable.
        lastError = new ProviderApiError({
          provider,
          status: 0,
          message: networkError && networkError.name === 'AbortError'
            ? `${label} did not respond in time. Check your connection and try again.`
            : `Could not reach ${label}. Check your internet connection.`,
          code: 'network',
          detail: scrub(networkError && networkError.message),
        });
        if (attempt < maxAttempts) { await sleep(retryBackoffMs * attempt); continue; }
        throw lastError;
      }

      const payload = await readPayload(response);

      if (response.ok) return { status: response.status, body: payload, headers: response.headers };

      // 401/403/404/422 are never worth retrying: surface them immediately.
      if (!RETRYABLE_STATUS.has(response.status)) {
        throw toApiError(provider, label, response, payload, describeError);
      }
      const retryAfter = Number(response.headers && response.headers.get('retry-after'));
      lastError = toApiError(provider, label, response, payload, describeError);
      if (attempt < maxAttempts) {
        logger.warn?.(`${label} returned ${response.status}; retrying`, { attempt });
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 20000) : retryBackoffMs * attempt);
      }
    }
    throw lastError;
  }

  return { request, ProviderApiError, scrub };
}

async function readPayload(response) {
  const type = (response.headers && response.headers.get('content-type')) || '';
  try {
    if (type.includes('json')) return await response.json();
    const text = await response.text();
    if (!text) return null;
    if (!type && text.trim().startsWith('{')) {
      try { return JSON.parse(text); } catch { return text; }
    }
    return text;
  } catch {
    return null;
  }
}

/** Turn a non-2xx response into a ProviderApiError with a useful message. */
function toApiError(provider, label, response, payload, describeError) {
  const custom = typeof describeError === 'function' ? describeError(payload, response.status) : null;
  const fallbackFromPayload = (() => {
    if (!payload) return null;
    if (typeof payload === 'string') return payload;
    // Vercel answers `{ error: { code, message } }`; Netlify answers
    // `{ message }`. Read the human reason out of the nested object instead of
    // throwing it away and falling back to the generic status text. A bare
    // `code` like "not_authenticated" is deliberately not used as a message:
    // the status-specific text below explains it far better.
    if (typeof payload.error === 'string') return payload.error;
    if (payload.error && payload.error.message) return payload.error.message;
    return payload.message || payload.msg || null;
  })();
  const status = response.status;
  const defaultMessage = {
    400: `${label} rejected the request.`,
    401: `Your ${label} token is not valid. Reconnect your account.`,
    402: `${label} requires a paid plan or has reached a usage limit for this action.`,
    403: `Your ${label} token is not allowed to do this.`,
    404: `${label} could not find that resource.`,
    409: `${label} reports a conflict with the existing project.`,
    413: `The upload is larger than ${label} accepts.`,
    422: `${label} could not process the deployment.`,
    429: `${label} is rate-limiting this account. Wait a moment and retry.`,
  }[status] || `${label} returned HTTP ${status}.`;

  return new ProviderApiError({
    provider,
    status,
    message: scrub(custom && custom.message ? custom.message : (typeof fallbackFromPayload === 'string' ? fallbackFromPayload : defaultMessage)),
    code: (custom && custom.code) || (payload && payload.error && payload.error.code) || null,
    detail: (custom && custom.detail) || (payload && payload.error ? JSON.stringify(payload.error) : null),
  });
}

module.exports = { createProviderClient, ProviderApiError, scrub, appendQuery, toApiError };
