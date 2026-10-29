#!/usr/bin/env node
/**
 * NovaCode Gateway — a tiny, self-hostable proxy that lets a NovaCode build
 * offer OpenAI / Anthropic Claude / Google Gemini to its users WITHOUT shipping
 * any API key inside the app.
 *
 * How it fits the security model:
 *   - The three provider keys live ONLY in this server's environment. They are
 *     never bundled with the desktop app, so installing the app cannot leak them.
 *   - NovaCode talks to this server as the "NovaCode Gateway" provider, which is
 *     OpenAI-compatible and keyless on the client. This server translates that
 *     one OpenAI-style request into the native wire format of the chosen backend
 *     and streams the answer back as OpenAI-style SSE chunks.
 *
 * It has ZERO runtime dependencies (Node 18+ built-in http + global fetch).
 *
 * IMPORTANT — read the honesty note in README.md: local NovaCode sign-in is not
 * a server-verifiable credential, so this reference gateway protects itself with
 * per-IP rate limiting, a model allowlist, and an optional shared access code.
 * For production you should ALSO run it behind your own authentication
 * (reverse proxy / Cloudflare Access / your account server).
 *
 * Env vars:
 *   PORT                     listen port (default 8787)
 *   OPENAI_API_KEY           required to route OpenAI models
 *   ANTHROPIC_API_KEY        required to route Claude models
 *   GEMINI_API_KEY           required to route Gemini models
 *   GATEWAY_ACCESS_CODE      optional; if set, clients must send it (see README)
 *   RATE_LIMIT_PER_MIN       requests per IP per minute (default 30)
 *   GATEWAY_ALLOWED_ORIGIN   optional CORS lock (default: allow all — see README)
 */
'use strict';

const http = require('http');

const PORT = Number(process.env.PORT || 8787);
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 30);
const ACCESS_CODE = process.env.GATEWAY_ACCESS_CODE || '';
const ALLOWED_ORIGIN = process.env.GATEWAY_ALLOWED_ORIGIN || '';

const KEYS = {
  openai: process.env.OPENAI_API_KEY || '',
  anthropic: process.env.ANTHROPIC_API_KEY || '',
  gemini: process.env.GEMINI_API_KEY || '',
};

// Which model prefixes this gateway is willing to serve. Extend freely.
const ROUTES = [
  { match: /^(openai:|gpt-|o1|o3|o4)/i, backend: 'openai', strip: /^openai:/i },
  { match: /^(anthropic:|claude)/i, backend: 'anthropic', strip: /^anthropic:/i },
  { match: /^(gemini:|gemini-)/i, backend: 'gemini', strip: /^gemini:/i },
];

const SERVED_MODELS = [
  'gpt-4o-mini', 'gpt-4o', 'o3-mini',
  'claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest',
  'gemini-1.5-flash', 'gemini-1.5-pro',
];

// --- tiny per-IP sliding-window limiter -----------------------------------
const hits = new Map(); // ip -> number[] (timestamps in the current window)
function rateLimited(ip) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const arr = (hits.get(ip) || []).filter((t) => t > windowStart);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_LIMIT_PER_MIN;
}
setInterval(() => {
  const windowStart = Date.now() - 60_000;
  for (const [ip, arr] of hits) {
    const kept = arr.filter((t) => t > windowStart);
    if (kept.length) hits.set(ip, kept); else hits.delete(ip);
  }
}, 60_000).unref();

// --- request helpers -------------------------------------------------------
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-novacode-code');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(res, status, obj) {
  applyCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function openAiError(res, status, message) {
  sendJson(res, status, { error: { message, type: 'gateway_error', code: status } });
}

function routeFor(model) {
  const raw = String(model || '');
  for (const entry of ROUTES) {
    if (entry.match.test(raw)) {
      return { backend: entry.backend, model: raw.replace(entry.strip, '') };
    }
  }
  return null;
}

// Split an OpenAI-style message list into a system prompt and the turn list.
function splitMessages(messages) {
  const system = [];
  const turns = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m.content !== 'string') continue;
    if (m.role === 'system') system.push(m.content);
    else if (m.role === 'user' || m.role === 'assistant') turns.push({ role: m.role, content: m.content });
  }
  return { system: system.join('\n\n'), turns };
}

function startSse(res) {
  applyCors(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function sseChunk(res, text, finishReason) {
  const payload = {
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: finishReason || null }],
  };
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  if (finishReason) res.write('data: [DONE]\n\n');
}

function finalJson(id, model, text) {
  return {
    id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// --- backend: OpenAI (native passthrough) ----------------------------------
async function callOpenAI({ baseUrl, body, signal }) {
  const url = `${(baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`;
  return fetch(url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEYS.openai}` },
    body: JSON.stringify(body),
  });
}

// --- backend: Anthropic (translate to/from OpenAI) -------------------------
async function callAnthropic({ body, stream, signal }) {
  const { system, turns } = splitMessages(body.messages);
  const payload = {
    model: body.model,
    max_tokens: Number(body.max_tokens || 1024),
    messages: turns,
    stream: Boolean(stream),
  };
  if (system) payload.system = system;
  if (typeof body.temperature === 'number') payload.temperature = body.temperature;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': KEYS.anthropic,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });
  return res;
}

// Convert Anthropic SSE -> OpenAI chunk SSE (or accumulate for non-stream).
async function pipeAnthropic(res, res2, { stream }) {
  if (!res.ok) { const t = await res.text(); throw new Error(`anthropic ${res.status}: ${t.slice(0, 400)}`); }
  if (!stream) {
    const json = await res.json();
    const text = (json.content || []).map((b) => b.text || '').join('');
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        const evt = JSON.parse(line.slice(5).trim());
        if (evt.type === 'content_block_delta' && evt.delta?.text) sseChunk(res2, evt.delta.text);
        if (evt.type === 'message_stop') sseChunk(res2, '', 'stop');
      } catch { /* ignore keep-alive frames */ }
    }
  }
  return null;
}

// --- backend: Gemini (translate to/from OpenAI) ----------------------------
async function callGemini({ body, stream, signal }) {
  const { system, turns } = splitMessages(body.messages);
  const contents = turns.map((t) => ({
    role: t.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: t.content }],
  }));
  const payload = { contents };
  if (system) payload.systemInstruction = { parts: [{ text: system }] };
  payload.generationConfig = {};
  if (typeof body.temperature === 'number') payload.generationConfig.temperature = body.temperature;
  if (body.max_tokens) payload.generationConfig.maxOutputTokens = Number(body.max_tokens);
  const method = stream ? 'streamGenerateContent' : 'generateContent';
  const qs = stream ? 'alt=sse' : '';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(body.model)}:${method}?key=${encodeURIComponent(KEYS.gemini)}${qs ? `&${qs}` : ''}`;
  return fetch(url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function pipeGemini(res, res2, { stream }) {
  if (!res.ok) { const t = await res.text(); throw new Error(`gemini ${res.status}: ${t.slice(0, 400)}`); }
  const textOf = (json) => (json.candidates || []).flatMap((c) => (c.content?.parts || []).map((p) => p.text || '')).join('');
  if (!stream) { const json = await res.json(); return textOf(json); }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let emitted = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        const evt = JSON.parse(line.slice(5).trim());
        const text = textOf(evt);
        if (text) { sseChunk(res2, text); emitted = true; }
      } catch { /* ignore */ }
    }
  }
  if (!emitted) sseChunk(res2, '', 'stop'); else sseChunk(res2, '', 'stop');
  return null;
}

// --- main handler ----------------------------------------------------------
async function handleChatCompletions(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  if (rateLimited(ip)) return openAiError(res, 429, 'Rate limit exceeded. Slow down.');

  if (ACCESS_CODE) {
    const provided = (req.headers['x-novacode-code'] || '').trim()
      || (String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')).trim();
    if (provided !== ACCESS_CODE) return openAiError(res, 401, 'Missing or invalid gateway access code.');
  }

  let body;
  try { body = await readJson(req); } catch { return openAiError(res, 400, 'Invalid JSON body.'); }

  const route = routeFor(body.model);
  if (!route) return openAiError(res, 404, `Unsupported model "${body.model}".`);
  if (!KEYS[route.backend]) return openAiError(res, 500, `Gateway has no ${route.backend} key configured.`);

  const stream = Boolean(body.stream);
  const outboundModel = route.model;
  const id = `chatcmpl-gw-${Date.now()}`;

  let upstream;
  try {
    if (route.backend === 'openai') {
      upstream = await callOpenAI({ baseUrl: process.env.OPENAI_BASE_URL, body: { ...body, model: outboundModel } });
    } else if (route.backend === 'anthropic') {
      upstream = await callAnthropic({ body: { ...body, model: outboundModel }, stream });
    } else {
      upstream = await callGemini({ body: { ...body, model: outboundModel }, stream });
    }
  } catch (error) {
    return openAiError(res, 502, `Upstream request failed: ${error.message}`);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    return openAiError(res, upstream.status || 502, `Upstream error: ${detail.slice(0, 500)}`);
  }

  // OpenAI passthrough: forward the exact bytes (already OpenAI SSE/JSON).
  if (route.backend === 'openai') {
    applyCors(res);
    if (stream) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    else res.writeHead(200, { 'Content-Type': 'application/json' });
    try {
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } catch { /* client disconnected */ }
    return res.end();
  }

  // Translated backends: re-emit as OpenAI shape.
  if (stream) startSse(res);
  try {
    if (route.backend === 'anthropic') {
      const text = await pipeAnthropic(upstream, res, { stream });
      if (!stream) return sendJson(res, 200, finalJson(id, outboundModel, text || ''));
    } else {
      const text = await pipeGemini(upstream, res, { stream });
      if (!stream) return sendJson(res, 200, finalJson(id, outboundModel, text || ''));
    }
    return res.end();
  } catch (error) {
    if (stream && res.headersSent) { sseChunk(res, '', 'stop'); return res.end(); }
    return openAiError(res, 502, error.message);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { applyCors(res); res.writeHead(204); return res.end(); }

  const url = (req.url || '').split('?')[0];
  if (url === '/health') return sendJson(res, 200, { ok: true, backends: Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, Boolean(v)])) });
  if (url === '/v1/models' || url === '/models') {
    return sendJson(res, 200, { object: 'list', data: SERVED_MODELS.map((id) => ({ id, object: 'model', owned_by: 'novacode-gateway' })) });
  }
  if ((url === '/v1/chat/completions' || url === '/chat/completions') && req.method === 'POST') {
    return handleChatCompletions(req, res);
  }
  return openAiError(res, 404, `Unknown route ${url}`);
});

const missing = Object.entries(KEYS).filter(([, v]) => !v).map(([k]) => k);
server.listen(PORT, () => {
  console.log(`NovaCode Gateway listening on http://localhost:${PORT}`);
  if (missing.length) console.warn(`WARNING: no key configured for: ${missing.join(', ')} — those models will 500.`);
  if (!ACCESS_CODE) console.warn('WARNING: GATEWAY_ACCESS_CODE is not set. Anyone who can reach this server can use it (subject to the per-IP rate limit). Set the code and/or run behind authentication.');
});
