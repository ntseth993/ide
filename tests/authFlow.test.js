import { describe, it, expect, vi } from 'vitest';
import http from 'http';
import { createAuthFlow } from '../electron/services/authFlow';

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
}

function postForm(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/signin',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function makeAuthService() {
  return {
    signIn: vi.fn(async ({ email, name }) => ({
      email: String(email).toLowerCase(),
      name: name || 'anon',
      token: 'nova_test',
      tokensRemaining: 999,
    })),
    getAccount: vi.fn(() => null),
    listAccounts: vi.fn(async () => []),
    signOut: vi.fn(() => ({ ok: true })),
    hasQuota: vi.fn(() => true),
    consume: vi.fn(() => ({ ok: true })),
    STARTING_QUOTA: 1000,
  };
}

describe('browser sign-in auth flow', () => {
  it('opens the default browser and mints the session when the page posts back', async () => {
    const authService = makeAuthService();
    const sessions = [];
    const opened = [];
    const flow = createAuthFlow({
      authService,
      openBrowser: vi.fn(async (url) => { opened.push(url); }),
      onSession: (account) => sessions.push(account),
    });

    const { url } = await flow.beginLogin();
    expect(opened).toHaveLength(1);
    expect(url).toMatch(/\/signin\?state=[0-9a-f]+$/);

    const parsed = new URL(url);
    const port = Number(parsed.port);
    const state = parsed.searchParams.get('state');

    const page = await get(port, '/signin');
    expect(page.status).toBe(200);
    expect(page.body).toMatch(/Sign in to NovaCode/);

    const res = await postForm(port, `state=${state}&email=Ada@Example.com&name=Ada`);
    expect(res.status).toBe(200);
    expect(authService.signIn).toHaveBeenCalledWith({ email: 'Ada@Example.com', name: 'Ada' });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ email: 'ada@example.com', token: 'nova_test' });

    await flow.cancel();
  });

  it('rejects a submission whose state token does not match', async () => {
    const authService = makeAuthService();
    const onSession = vi.fn();
    const flow = createAuthFlow({ authService, openBrowser: vi.fn(async () => {}), onSession });

    const { url } = await flow.beginLogin();
    const port = Number(new URL(url).port);

    const res = await postForm(port, 'state=deadbeef&email=a@b.com');
    expect(res.status).toBe(400);
    expect(onSession).not.toHaveBeenCalled();
    expect(authService.signIn).not.toHaveBeenCalled();

    await flow.cancel();
  });

  it('lists saved accounts as a chooser on the sign-in page', async () => {
    const authService = makeAuthService();
    authService.listAccounts.mockResolvedValue([
      { email: 'ada@example.com', name: 'Ada Lovelace' },
      { email: 'grace@example.com', name: 'Grace Hopper' },
    ]);
    const flow = createAuthFlow({ authService, openBrowser: vi.fn(async () => {}), onSession: vi.fn() });

    const { url } = await flow.beginLogin();
    const port = Number(new URL(url).port);

    const page = await get(port, '/signin');
    expect(page.status).toBe(200);
    expect(page.body).toMatch(/Choose an account/);
    expect(page.body).toMatch(/ada@example\.com/);
    expect(page.body).toMatch(/grace@example\.com/);
    expect(authService.listAccounts).toHaveBeenCalled();

    await flow.cancel();
  });

  it('redirects a configured provider to its authorize URL and completes the callback', async () => {
    const authService = makeAuthService();
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/token')) return { ok: true, json: async () => ({ access_token: 'ya29.test' }) };
      if (String(url).includes('/userinfo')) return { ok: true, json: async () => ({ email: 'Ada@Gmail.com', name: 'Ada', picture: 'https://x/a.png' }) };
      throw new Error(`unexpected fetch: ${url}`);
    });
    const sessions = [];
    const flow = createAuthFlow({
      authService,
      openBrowser: vi.fn(async () => {}),
      onSession: (account) => sessions.push(account),
      env: { NOVACODE_GOOGLE_CLIENT_ID: 'google-client.apps.googleusercontent.com' },
      fetchImpl,
    });

    const { url } = await flow.beginLogin();
    const port = Number(new URL(url).port);
    const localState = new URL(url).searchParams.get('state');

    const signin = await get(port, '/signin');
    expect(signin.body).toMatch(/provider-btn/);
    expect(signin.body).toMatch(/Google/);

    const authRes = await get(port, `/authorize?provider=google&state=${localState}`);
    expect(authRes.status).toBe(302);
    const loc = new URL(authRes.headers.location);
    expect(loc.origin).toBe('https://accounts.google.com');
    expect(loc.searchParams.get('client_id')).toBe('google-client.apps.googleusercontent.com');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('code_challenge')).toBeTruthy();
    expect(loc.searchParams.get('redirect_uri')).toMatch(/http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const oauthState = loc.searchParams.get('state');

    const cb = await get(port, `/callback?code=authcode123&state=${oauthState}`);
    expect(cb.status).toBe(200);
    expect(cb.body).toMatch(/close this tab/i);
    expect(fetchImpl).toHaveBeenCalled();
    const signedIn = authService.signIn.mock.calls.at(-1)[0];
    expect(signedIn.provider).toBe('google');
    expect(signedIn.email).toBe('Ada@Gmail.com');
    expect(sessions.at(-1).name).toBe('Ada');

    await flow.cancel();
  });

  it('rejects a callback whose state does not match the pending request', async () => {
    const flow = createAuthFlow({
      authService: makeAuthService(),
      openBrowser: vi.fn(async () => {}),
      onSession: vi.fn(),
      env: { NOVACODE_GOOGLE_CLIENT_ID: 'cid' },
      fetchImpl: vi.fn(),
    });
    const { url } = await flow.beginLogin();
    const port = Number(new URL(url).port);
    const cb = await get(port, '/callback?code=x&state=tampered');
    expect(cb.status).toBe(400);
    expect(cb.body).toMatch(/could not be verified/i);
    await flow.cancel();
  });

  it('shows a not-configured note when a provider has no client id', async () => {
    const flow = createAuthFlow({
      authService: makeAuthService(),
      openBrowser: vi.fn(async () => {}),
      onSession: vi.fn(),
      env: {},
      fetchImpl: vi.fn(),
    });
    const { url } = await flow.beginLogin();
    const port = Number(new URL(url).port);
    const localState = new URL(url).searchParams.get('state');
    const res = await get(port, `/authorize?provider=github&state=${localState}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/Settings/);
    await flow.cancel();
  });

  it('treats a provider as live when its client id comes from the secret store', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/token')) return { ok: true, json: async () => ({ access_token: 't' }) };
      return { ok: true, json: async () => ({ email: 'ada@gmail.com', name: 'Ada' }) };
    });
    const flow = createAuthFlow({
      authService: makeAuthService(),
      openBrowser: vi.fn(async () => {}),
      onSession: vi.fn(),
      env: {},
      fetchImpl,
      readSecret: async (name) => (name === 'oauth-google-id' ? 'stored-client-id' : null),
    });
    const { url } = await flow.beginLogin();
    const port = Number(new URL(url).port);
    const localState = new URL(url).searchParams.get('state');

    const signin = await get(port, '/signin');
    expect(signin.body).toMatch(/Google/);

    const authRes = await get(port, `/authorize?provider=google&state=${localState}`);
    expect(authRes.status).toBe(302);
    expect(new URL(authRes.headers.location).searchParams.get('client_id')).toBe('stored-client-id');
    await flow.cancel();
  });

  it('delegates account methods to the underlying authService', () => {
    const authService = makeAuthService();
    const flow = createAuthFlow({ authService, openBrowser: vi.fn(), onSession: vi.fn() });
    expect(flow.STARTING_QUOTA).toBe(1000);
    flow.hasQuota();
    flow.consume({ tokens: 1 });
    expect(authService.hasQuota).toHaveBeenCalled();
    expect(authService.consume).toHaveBeenCalledWith({ tokens: 1 });
  });
});
