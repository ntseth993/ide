/**
 * Browser-based sign-in flow (OAuth "loopback" pattern, run locally).
 *
 * Clicking "Sign in" opens the user's DEFAULT BROWSER at a sign-in page served
 * by a short-lived HTTP server bound to 127.0.0.1 on an ephemeral port. The
 * user enters their email there; the page posts back to the loopback server,
 * which mints the per-account token + starter budget via authService and pushes
 * the session to the renderer. No account server is contacted — the browser is
 * simply a nicer place to type than a modal.
 *
 * Safety: loopback-only bind, a random one-time `state` token that must match on
 * submit, one-shot (the server closes on the first success), and an auto-close
 * timeout so a stray listener never lingers.
 */
const http = require('http');
const crypto = require('crypto');

const {
  providerList,
  getOAuthConfig,
  createPkce,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserInfo,
} = require('./oauthProviders');

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PAGE_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.5rem;
    font-family: Inter, 'Segoe UI', system-ui, sans-serif; color: #e6ebf4;
    background: radial-gradient(1200px 600px at 50% -10%, #16203a 0%, #080c16 60%); }
  .card { width: min(420px, 94vw); background: #121a2e; border: 1px solid rgba(148,163,184,0.16);
    border-radius: 16px; padding: 1.6rem 1.5rem; box-shadow: 0 24px 60px rgba(0,0,0,0.45); }
  .logo { width: 46px; height: 46px; border-radius: 14px; display: grid; place-items: center;
    background: linear-gradient(135deg, #7c5cff, #22d3ee); color: #fff; font-weight: 800; font-size: 1.3rem; }
  h1 { font-size: 1.15rem; margin: 0.7rem 0 0.15rem; }
  p.sub { margin: 0 0 1.1rem; color: #94a1b8; font-size: 0.86rem; }
  label { display: block; font-size: 0.78rem; color: #94a1b8; margin: 0.5rem 0 0.25rem; }
  input { width: 100%; padding: 0.6rem 0.7rem; font-size: 0.9rem; color: #e6ebf4;
    background: #0d1424; border: 1px solid rgba(148,163,184,0.2); border-radius: 9px; }
  input:focus { outline: none; border-color: #7c5cff; box-shadow: 0 0 0 3px rgba(124,92,255,0.25); }
  button { margin-top: 1.1rem; width: 100%; padding: 0.65rem; font-size: 0.92rem; font-weight: 600;
    color: #fff; border: none; border-radius: 10px; cursor: pointer; background: linear-gradient(135deg, #7c5cff, #22d3ee); }
  .err { margin: 0 0 0.9rem; padding: 0.55rem 0.7rem; border-radius: 8px; font-size: 0.8rem;
    color: #fca5a5; background: rgba(248,113,113,0.12); border: 1px solid rgba(248,113,113,0.35); }
  .foot { margin-top: 1.1rem; text-align: center; font-size: 0.72rem; color: #6b7688; }
  .ok { text-align: center; }
  .ok .check { width: 54px; height: 54px; margin: 0.3rem auto 0.6rem; border-radius: 50%;
    display: grid; place-items: center; font-size: 1.7rem; color: #fff; background: linear-gradient(135deg, #34d399, #22d3ee); }
  .who { margin-top: 0.2rem; font-size: 0.9rem; color: #cbd5e1; }
  .to { margin: 0 0 1rem; font-size: 0.9rem; color: #cbd5e1; }
  .to strong { color: #e6ebf4; }
  .acct-list { display: flex; flex-direction: column; gap: 0.15rem; margin: 0 -0.4rem; }
  .acct-form { margin: 0; }
  .acct {
    width: 100%; display: flex; align-items: center; gap: 0.7rem; text-align: left;
    padding: 0.6rem 0.7rem; margin: 0; border: 1px solid transparent; border-radius: 12px;
    background: transparent; color: #e6ebf4; cursor: pointer; font-size: 0.9rem;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .acct:hover { background: rgba(124,92,255,0.10); border-color: rgba(124,92,255,0.4); }
  .avatar {
    flex: none; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center;
    font-weight: 700; font-size: 0.95rem; color: #fff; background: linear-gradient(135deg, #7c5cff, #22d3ee);
  }
  .acct-text { display: flex; flex-direction: column; min-width: 0; }
  .acct-name { font-weight: 600; }
  .acct-email { font-size: 0.8rem; color: #94a1b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .divider { display: flex; align-items: center; gap: 0.6rem; margin: 0.9rem 0 0.4rem; color: #6b7688; font-size: 0.74rem; }
  .divider::before, .divider::after { content: ''; height: 1px; flex: 1; background: rgba(148,163,184,0.16); }
  .providers { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 0.3rem; }
  .provider-btn {
    display: flex; align-items: center; gap: 0.6rem; width: 100%; box-sizing: border-box;
    padding: 0.6rem 0.8rem; border: 1px solid rgba(148,163,184,0.28); border-radius: 10px;
    background: #1a2130; color: #e6ebf4; text-decoration: none; font-size: 0.9rem; font-weight: 500;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .provider-btn:hover { background: #212a3b; border-color: rgba(124,92,255,0.5); }
  .provider-btn .pf { width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font-size: 0.8rem; font-weight: 700; color: #fff; }
  .pf-google { background: #4285f4; } .pf-github { background: #24292e; } .pf-microsoft { background: #f25022; }
  .provider-off { font-size: 0.72rem; color: #6b7688; margin-left: auto; }
`;

function wrap(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark"><title>${escapeHtml(title)}</title>
    <style>${PAGE_CSS}</style></head><body><main class="card">${body}
    <div class="foot">NovaCode IDE · local sign-in · nothing leaves this device</div></main></body></html>`;
}

function initialOf(value) {
  const s = String(value || '').trim();
  return s ? s[0].toUpperCase() : '?';
}

function renderSignInPage({ state, error, accounts = [], providers = [] }) {
  const safeState = escapeHtml(state);
  const list = Array.isArray(accounts) ? accounts : [];
  const accountRows = list.map((account) => `
    <form method="POST" action="/signin" class="acct-form">
      <input type="hidden" name="state" value="${safeState}">
      <input type="hidden" name="email" value="${escapeHtml(account.email)}">
      <input type="hidden" name="name" value="${escapeHtml(account.name || '')}">
      <button type="submit" class="acct">
        <span class="avatar">${escapeHtml(initialOf(account.name || account.email))}</span>
        <span class="acct-text">
          <span class="acct-name">${escapeHtml(account.name || account.email)}</span>
          <span class="acct-email">${escapeHtml(account.email)}</span>
        </span>
      </button>
    </form>`).join('');

  const chooser = list.length
    ? `<div class="acct-list">${accountRows}</div>`
    : '';

  const providerButtons = providers.length
    ? `<div class="divider">or continue with</div>
       <div class="providers">${providers.map((p) => `<a class="provider-btn" href="/authorize?provider=${encodeURIComponent(p.id)}&state=${safeState}"><span class="pf pf-${escapeHtml(p.id)}">${escapeHtml(String(p.label || p.id)[0].toUpperCase())}</span><span>${escapeHtml(p.label)}</span>${p.live ? '' : '<span class="provider-off">not set up</span>'}</a>`).join('')}</div>`
    : '';

  const body = `${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
    <div class="logo">N</div><h1>Choose an account</h1>
    <p class="to">to continue to <strong>NovaCode</strong></p>
    ${chooser}
    ${providerButtons}
    <div class="divider">${list.length || providers.length ? 'or use your email' : 'Sign in with your email'}</div>
    <form method="POST" action="/signin" autocomplete="on">
      <input type="hidden" name="state" value="${safeState}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required ${list.length ? '' : 'autofocus'} placeholder="you@example.com">
      <label for="name">Display name <span style="color:#6b7688">(optional)</span></label>
      <input id="name" name="name" type="text" maxlength="80" placeholder="Ada Lovelace">
      <button type="submit">Continue</button>
    </form>`;
  return wrap('Sign in to NovaCode', body);
}

function renderSuccessPage(account) {
  const body = `<div class="ok"><div class="check">&#10003;</div>
    <h1>You're signed in</h1>
    <p class="who">${escapeHtml(account.email)}</p>
    <p class="sub" style="margin-top:0.9rem">Your API token and 1,000M-token budget are ready.<br>You can close this tab and head back to NovaCode.</p>
    </div>`;
  return wrap("Signed in", body);
}

function parseForm(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        reject(new Error('Payload too large.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(new URLSearchParams(data)));
    req.on('error', reject);
  });
}

function createAuthFlow({ authService, openBrowser, onSession, logger, host = '127.0.0.1', port = 0, env = process.env, fetchImpl, readSecret = async () => null }) {
  let server = null;
  let state = null;
  let timer = null;
  let oauthTx = null; // { provider, verifier, oauthState, redirectUri }

  function close() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (server) {
      server.close();
      server = null;
    }
    state = null;
    oauthTx = null;
  }

  function listen() {
    return new Promise((resolve, reject) => {
      server = http.createServer(handleRequest);
      server.on('error', reject);
      server.listen(port, host, () => resolve(server.address().port));
    });
  }

  async function beginLogin() {
    if (timer) clearTimeout(timer);
    if (!server) await listen();
    state = crypto.randomBytes(16).toString('hex');
    const actualPort = server.address().port;
    const url = `http://${host}:${actualPort}/signin?state=${state}`;
    timer = setTimeout(() => {
      logger?.info?.('browser sign-in timed out');
      close();
    }, LOGIN_TIMEOUT_MS);
    // Opening the browser is best-effort: if the OS refuses (no default
    // handler, headless, etc.) we still return the URL so the UI can offer a
    // manual "open this link" affordance instead of dead-ending.
    let opened = true;
    try {
      await openBrowser(url);
    } catch (openError) {
      opened = false;
      logger?.error?.('could not launch the default browser', { error: openError.message });
    }
    return { ok: true, url, opened };
  }

  async function cancel() {
    close();
    return { ok: true };
  }

  async function safeAccounts() {
    try {
      return authService.listAccounts ? await authService.listAccounts() : [];
    } catch {
      return [];
    }
  }

  // Merge real env vars with client ids/secrets saved through Settings (stored
  // encrypted in the secret store) so a provider is "live" from either source.
  async function oauthEnv() {
    const merged = { ...env };
    for (const { id } of providerList()) {
      const key = String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_');
      const storedId = await readSecret(`oauth-${id}-id`).catch(() => null);
      const storedSecret = await readSecret(`oauth-${id}-secret`).catch(() => null);
      if (storedId) merged[`NOVACODE_${key}_CLIENT_ID`] = storedId;
      if (storedSecret) merged[`NOVACODE_${key}_CLIENT_SECRET`] = storedSecret;
    }
    return merged;
  }

  async function providerStatuses() {
    const resolvedEnv = await oauthEnv();
    return providerList().map((p) => ({ ...p, live: Boolean(getOAuthConfig(p.id, resolvedEnv)) }));
  }

  // Handles the browser hand-off for a real OAuth provider: redirect out to the
  // provider's authorize endpoint with a PKCE challenge. If the provider has no
  // client id configured on this device we show the chooser with a note instead
  // of a broken redirect.
  async function handleAuthorize(requestUrl, res) {
    const provider = requestUrl.searchParams.get('provider');
    const localState = requestUrl.searchParams.get('state') || '';
    if (!state || localState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderSignInPage({ state: localState, error: 'This sign-in request is no longer valid.', accounts: [], providers: await providerStatuses() }));
      return;
    }
    const resolvedEnv = await oauthEnv();
    const config = getOAuthConfig(provider, resolvedEnv);
    if (!config) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const label = (providerList().find((p) => p.id === provider) || {}).label || provider;
      res.end(renderSignInPage({
        state,
        error: `${label} sign-in isn't set up on this device yet. Open NovaCode Settings (Sign-in section) to add your ${label} Client ID, or continue with your email below.`,
        accounts: [],
        providers: await providerStatuses(),
      }));
      return;
    }
    const pkce = createPkce();
    const oauthState = crypto.randomBytes(16).toString('hex');
    const redirectUri = `http://${host}:${server.address().port}/callback`;
    oauthTx = { provider, def: config.def, clientId: config.clientId, clientSecret: config.clientSecret, verifier: pkce.verifier, oauthState, redirectUri };
    const url = buildAuthorizeUrl({ def: config.def, clientId: config.clientId, redirectUri, state: oauthState, codeChallenge: pkce.challenge });
    res.writeHead(302, { Location: url });
    res.end();
  }

  async function handleCallback(requestUrl, res) {
    const code = requestUrl.searchParams.get('code');
    const returnedState = requestUrl.searchParams.get('state');
    const denied = requestUrl.searchParams.get('error');
    if (!oauthTx || !returnedState || returnedState !== oauthTx.oauthState) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderSignInPage({ state: state || '', error: 'That sign-in response could not be verified. Please try again.', accounts: [], providers: await providerStatuses() }));
      return;
    }
    const tx = oauthTx;
    oauthTx = null;
    try {
      if (denied) throw new Error('Sign-in was cancelled.');
      if (!code) throw new Error('No authorization code was returned.');
      const accessToken = await exchangeCode({
        def: tx.def, clientId: tx.clientId, clientSecret: tx.clientSecret,
        code, redirectUri: tx.redirectUri, codeVerifier: tx.verifier, fetchImpl,
      });
      const profile = await fetchUserInfo({ def: tx.def, accessToken, fetchImpl });
      const account = await authService.signIn({ email: profile.email, name: profile.name, provider: tx.provider, avatar: profile.picture });
      onSession?.(account);
      close();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderSuccessPage(account));
    } catch (callbackError) {
      logger?.error?.('oauth callback failed', { error: callbackError.message });
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderSignInPage({ state: state || '', error: callbackError.message, accounts: [], providers: await providerStatuses() }));
    }
  }

  async function handleRequest(req, res) {
    try {
      const requestUrl = new URL(req.url, `http://${host}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');

      if (requestUrl.pathname === '/' && req.method === 'GET') {
        res.writeHead(302, { Location: `/signin?state=${encodeURIComponent(state || '')}` });
        res.end();
        return;
      }

      if (requestUrl.pathname === '/signin' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderSignInPage({
          state: requestUrl.searchParams.get('state') || '',
          error: '',
          accounts: await safeAccounts(),
          providers: await providerStatuses(),
        }));
        return;
      }

      if (requestUrl.pathname === '/authorize' && req.method === 'GET') {
        await handleAuthorize(requestUrl, res);
        return;
      }

      if (requestUrl.pathname === '/callback' && req.method === 'GET') {
        await handleCallback(requestUrl, res);
        return;
      }

      if (requestUrl.pathname === '/signin' && req.method === 'POST') {
        const params = await parseForm(req);
        const submittedState = params.get('state');
        if (!state || submittedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderSignInPage({
            state: submittedState || '',
            error: 'This sign-in request is no longer valid. Return to NovaCode and press Sign in again.',
            accounts: await safeAccounts(),
            providers: await providerStatuses(),
          }));
          return;
        }
        try {
          const account = await authService.signIn({ email: params.get('email'), name: params.get('name') });
          onSession?.(account);
          close();
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderSuccessPage(account));
        } catch (signInError) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderSignInPage({
            state: submittedState || '',
            error: signInError.message,
            accounts: await safeAccounts(),
            providers: await providerStatuses(),
          }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (error) {
      logger?.error?.('auth flow request error', { error: error.message });
      res.statusCode = 500;
      res.end('Sign-in failed. Return to NovaCode and try again.');
    }
  }

  return {
    beginLogin,
    cancel,
    // Delegates so this object can stand in for authService everywhere.
    signIn: (payload) => authService.signIn(payload),
    getAccount: () => authService.getAccount(),
    signOut: () => authService.signOut(),
    hasQuota: () => authService.hasQuota(),
    consume: (payload) => authService.consume(payload),
    STARTING_QUOTA: authService.STARTING_QUOTA,
  };
}

module.exports = { createAuthFlow, renderSignInPage, renderSuccessPage };
