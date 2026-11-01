/**
 * Hosting provider adapter tests — the exact wire calls each provider gets.
 *
 * A fake transport records every request, so these tests pin the real API
 * contract (paths, auth header, digest body, polling states) without touching
 * the network. The safety-critical half is deliberate: a token must never
 * appear in a thrown message, and a URL must never appear before the provider
 * says the deployment is live.
 */
import { describe, it, expect } from 'vitest';
import {
  createProviderClient, scrub, appendQuery, toApiError,
} from '../electron/services/deploy/providers/httpClient';
import {
  createVercelAdapter, mapState as mapVercelState, projectSettingsFrom,
} from '../electron/services/deploy/providers/vercelProvider';
import {
  createNetlifyAdapter, slugifySiteName,
} from '../electron/services/deploy/providers/netlifyProvider';
import {
  describeProviders, getAdapter, listAvailable, TOKEN_SECRET,
} from '../electron/services/deploy/providers';

const quiet = { info() {}, warn() {}, error() {} };
const TOKEN = 'vercel-token-abcdefghijklmnop';

/** A Response-shaped stub: the client only reads ok/status/headers/json/text. */
function json(body, { status = 200, headers = {} } = {}) {
  const all = { 'content-type': 'application/json', ...headers };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => all[String(name).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** A text/plain Response stub, for provider log bodies. */
function textBody(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/plain' : null) },
    json: async () => { throw new Error('not json'); },
    text: async () => body,
  };
}

/** Route by `METHOD /path`. Handlers receive the call number (1-based) so a test
 * can answer differently on a retry.
 */
function harness(routes, { http } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const query = Object.fromEntries(parsed.searchParams.entries());
    const record = {
      method: (init.method || 'GET').toUpperCase(),
      path: parsed.pathname,
      query,
      headers: init.headers || {},
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      rawBody: Buffer.isBuffer(init.body) ? init.body.toString() : undefined,
      url,
    };
    calls.push(record);
    const handler = routes[`${record.method} ${record.path}`];
    if (!handler) throw new Error(`unrouted ${record.method} ${record.path}`);
    const result = typeof handler === 'function' ? handler(record, calls.length) : handler;
    return result || json({});
  };
  const client = (token, provider = 'vercel', baseUrl = 'https://api.vercel.com') =>
    createProviderClient({ provider, baseUrl, token, fetchImpl, logger: quiet, ...http });
  return { calls, fetchImpl, client };
}

function bundle(...files) {
  return {
    files: files.map(([path, sha, content = `content of ${path}`]) => ({
      path, sha, size: content.length, read: async () => Buffer.from(content),
    })),
    fileCount: files.length,
    totalBytes: 12,
  };
}

describe('provider http client', () => {
  it('sends bearer auth and reads a JSON body', async () => {
    const { calls, client } = harness({ 'GET /v2/user': json({ user: { id: 'usr_1' } }) });
    const res = await client(TOKEN).request('/v2/user');
    expect(res.body.user.id).toBe('usr_1');
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].headers.Accept).toBe('application/json');
    expect(calls[0].url).toBe('https://api.vercel.com/v2/user');
  });

  it('refuses to send a request when no token is connected', async () => {
    const { calls, client } = harness({});
    await expect(client('').request('/v2/user')).rejects.toThrow(/No account token/);
    expect(calls).toHaveLength(0);
  });

  it('maps 401 to a reconnect message and never retries it', async () => {
    const { calls, client } = harness({ 'GET /v2/user': json({ error: { code: 'not_authenticated' } }, { status: 401 }) });
    await expect(client(TOKEN).request('/v2/user')).rejects.toThrow(/token is not valid/);
    expect(calls).toHaveLength(1);
  });

  it('retries a 500 and succeeds inside the attempt budget', async () => {
    const { calls, client } = harness({
      'GET /v2/user': (_record, n) => (n === 1 ? json({ error: { code: 'server_error' } }, { status: 500 }) : json({ user: { id: 'ok' } })),
    }, { retryBackoffMs: 1, maxAttempts: 3 });
    const res = await client(TOKEN).request('/v2/user');
    expect(res.body.user.id).toBe('ok');
    expect(calls).toHaveLength(2);
  });

  it('gives up after three attempts and reports the provider failure', async () => {
    const { calls, client } = harness({
      'GET /v2/user': () => json({ error: { message: 'boom' } }, { status: 503 }),
    }, { retryBackoffMs: 1, maxAttempts: 3 });
    await expect(client(TOKEN).request('/v2/user')).rejects.toThrow(/boom/);
    expect(calls).toHaveLength(3);
  });

  it('turns an unreachable host into a connection message', async () => {
    const fetchImpl = async () => { throw new Error('getaddrinfo ENOTFOUND api.vercel.com'); };
    const client = createProviderClient({
      provider: 'netlify', baseUrl: 'https://api.netlify.com/api/v1', token: TOKEN, fetchImpl, logger: quiet,
      retryBackoffMs: 1, maxAttempts: 1,
    });
    await expect(client.request('/sites')).rejects.toThrow(/Could not reach Netlify/);
  });

  it('reports our own timeout instead of a generic network error', async () => {
    const fetchImpl = (_url, init = {}) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('This operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
    const client = createProviderClient({
      provider: 'vercel', baseUrl: 'https://api.vercel.com', token: TOKEN, fetchImpl, logger: quiet,
      retryBackoffMs: 1, maxAttempts: 1,
    });
    await expect(client.request('/v2/user', { timeoutMs: 5 })).rejects.toThrow(/did not respond in time/);
  });

  it('never repeats the bearer token when the server echoes the request', async () => {
    const { client } = harness({
      'POST /v13/deployments': () => json({
        error: { message: `Invalid header Authorization: Bearer ${TOKEN}` },
      }, { status: 400 }),
    });
    const error = await client(TOKEN).request('/v13/deployments', { method: 'POST', body: {} }).catch((e) => e);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain('Bearer [redacted]');
  });

  it('scrub keeps digests but redacts credential-shaped text', () => {
    expect(scrub('sha 356a192b7913b04c54574d1702d96f10897b7f09')).toContain('356a192b7913b04c54574d1702d96f10897b7f09');
    expect(scrub('key is sk-abcdefghijklmnop12345678')).not.toContain('sk-abcdefghijklmnop12345678');
  });

  it('appendQuery drops empty values', () => {
    expect(appendQuery('/v10/projects', { limit: 100, teamId: undefined, q: '' })).toBe('/v10/projects?limit=100');
    expect(appendQuery('/v10/projects', {})).toBe('/v10/projects');
  });

  it('toApiError falls back to a status message when the payload is empty', () => {
    const error = toApiError('vercel', 'Vercel', { status: 402 }, null);
    expect(error.message).toMatch(/paid plan/);
    expect(error.status).toBe(402);
  });
});

describe('vercel adapter', () => {
  it('verify reads the real user and team list', async () => {
    const { calls, fetchImpl } = harness({
      'GET /v2/user': json({ user: { id: 'usr_1', username: 'ada', email: 'ada@example.com' } }),
      'GET /v2/teams': json({ teams: [{ id: 'team_1', name: 'Acme', slug: 'acme' }] }),
    });
    const adapter = createVercelAdapter({ fetchImpl, logger: quiet });
    const result = await adapter.verify({ token: TOKEN });
    expect(result.ok).toBe(true);
    expect(result.account.handle).toBe('ada');
    expect(result.teams).toEqual([{ id: 'team_1', name: 'Acme', slug: 'acme' }]);
    expect(calls.map((c) => c.path)).toEqual(['/v2/user', '/v2/teams']);
  });

  it('scopes every call by teamId when a team is selected', async () => {
    const { calls, fetchImpl } = harness({ 'GET /v10/projects': json({ projects: [] }) });
    const adapter = createVercelAdapter({ fetchImpl, logger: quiet });
    await adapter.listProjects({ token: TOKEN, teamId: 'team_1' });
    expect(calls[0].query.teamId).toBe('team_1');
  });

  it('listEnvKeys returns names and never values', async () => {
    const { fetchImpl } = harness({
      'GET /v10/projects/acme/env': json({ envs: [{ key: 'API_URL', value: 'super-secret' }] }),
    });
    const adapter = createVercelAdapter({ fetchImpl, logger: quiet });
    const keys = await adapter.listEnvKeys({ token: TOKEN, project: 'acme' });
    expect(keys).toEqual(['API_URL']);
    expect(JSON.stringify(keys)).not.toContain('super-secret');
  });

  it('setEnvVars writes encrypted project vars and skips malformed keys', async () => {
    const { calls, fetchImpl } = harness({ 'POST /v10/projects/acme/env': json({}) });
    const adapter = createVercelAdapter({ fetchImpl, logger: quiet });
    const result = await adapter.setEnvVars({
      token: TOKEN,
      project: 'acme',
      vars: [{ key: 'API_URL', value: 'https://api' }, { key: 'bad key!', value: 'x' }, { key: '', value: 'y' }],
    });
    expect(result.created).toEqual(['API_URL']);
    expect(calls[0].body.envs[0]).toMatchObject({
      key: 'API_URL', value: 'https://api', type: 'encrypted',
      target: ['production', 'preview', 'development'],
    });
  });

  it('uploads each digest once, then creates the deployment', async () => {
    const { calls, fetchImpl } = harness({
      'POST /v2/files': json({}),
      'POST /v13/deployments': json({ id: 'dpl_1', url: 'acme-omega.vercel.app', inspectUrl: 'https://vercel.com/dpl_1', readyState: 'BUILDING', projectId: 'prj_1' }),
    });
    const adapter = createVercelAdapter({ fetchImpl, logger: quiet });
    const result = await adapter.startDeploy({
      token: TOKEN,
      projectName: 'acme',
      production: false,
      build: { buildCommand: 'npm run build', outputDir: 'dist', framework: 'vite' },
      bundle: bundle(['index.html', 'aaa', 'same'], ['assets/app.js', 'aaa', 'same']),
    });
    const uploads = calls.filter((c) => c.path === '/v2/files');
    expect(uploads).toHaveLength(1); // identical SHA1 uploaded once
    expect(uploads[0].headers['x-vercel-digest']).toBe('aaa');
    expect(uploads[0].headers['x-now-size']).toBe('4');
    expect(uploads[0].rawBody).toBe('same');
    const create = calls.find((c) => c.path === '/v13/deployments');
    expect(create.body.files).toEqual([
      { file: 'index.html', sha: 'aaa', size: 4 },
      { file: 'assets/app.js', sha: 'aaa', size: 4 },
    ]);
    expect(create.body.projectSettings).toMatchObject({ buildCommand: 'npm run build', outputDirectory: 'dist', framework: 'vite' });
    expect(create.body.skipAutoDetectionConfirmation).toBe(1);
    expect(create.body.target).toBeUndefined(); // preview deploys carry no target
    expect(result.deploymentId).toBe('dpl_1');
    expect(result.state).toBe('building');
  });

  it('creates the project before a production deploy and targets production', async () => {
    const { calls, fetchImpl } = harness({
      'POST /v2/files': json({}),
      'POST /v11/projects': () => json({ error: { code: 'conflict' } }, { status: 409 }),
      'GET /v9/projects/acme': json({ id: 'prj_1', name: 'acme' }),
      'POST /v13/deployments': json({ id: 'dpl_2', readyState: 'QUEUED' }),
    });
    const adapter = createVercelAdapter({ fetchImpl, logger: quiet });
    await adapter.startDeploy({
      token: TOKEN, projectName: 'acme', production: true, build: {}, bundle: bundle(['index.html', 'aaa']),
    });
    expect(calls.find((c) => c.path === '/v13/deployments').body).toMatchObject({ project: 'acme', target: 'production' });
  });

  it('status withholds the public URL until Vercel reports READY', async () => {
    let ready = false;
    const { fetchImpl } = harness({
      'GET /v3/deployments/dpl_1': () => (ready
        ? json({ url: 'acme.vercel.app', readyState: 'READY', alias: ['acme.vercel.app'] })
        : json({ url: 'acme.vercel.app', readyState: 'BUILDING' })),
    });
    const adapter = createVercelAdapter({ fetchImpl, logger: quiet });
    expect(await adapter.status({ token: TOKEN, deploymentId: 'dpl_1' })).toMatchObject({ state: 'building', publicUrl: null });
    ready = true;
    expect(await adapter.status({ token: TOKEN, deploymentId: 'dpl_1' })).toMatchObject({ state: 'ready', publicUrl: 'https://acme.vercel.app' });
  });

  it('status explains a failed build from the deployment payload', async () => {
    const { fetchImpl } = harness({
      'GET /v3/deployments/dpl_1': json({ readyState: 'ERROR', builds: [{ error: { message: 'Command "npm run build" exited with 1' } }] }),
    });
    const adapter = createVercelAdapter({ fetchImpl, logger: quiet });
    const res = await adapter.status({ token: TOKEN, deploymentId: 'dpl_1' });
    expect(res.state).toBe('error');
    expect(res.publicUrl).toBeNull();
    expect(res.message).toMatch(/Build failed: Command "npm run build"/);
  });

  it('cancel hits the documented cancel endpoint', async () => {
    const { calls, fetchImpl } = harness({ 'PATCH /v12/deployments/dpl_1/cancel': json({}) });
    const adapter = createVercelAdapter({ fetchImpl, logger: quiet });
    expect(await adapter.cancel({ token: TOKEN, deploymentId: 'dpl_1' })).toEqual({ ok: true });
    expect(calls[0].method).toBe('PATCH');
  });

  it('renders deployment events as log lines', async () => {
    const { fetchImpl } = harness({
      'GET /v3/deployments/dpl_1/events': json({
        events: [{ type: 'build_error', created: 1730000000000, data: { message: 'missing dependency' } }],
      }),
    });
    const adapter = createVercelAdapter({ fetchImpl, logger: quiet });
    const text = await adapter.logs({ token: TOKEN, deploymentId: 'dpl_1' });
    expect(text).toMatch(/\[build_error\] missing dependency/);
  });

  it('only calls a custom domain live when Vercel verified it', async () => {
    const { fetchImpl } = harness({
      'GET /v9/projects/acme/domains': json({
        domains: [{ name: 'acme.dev', verified: true }, { name: 'www.acme.dev', verified: false, misconfigured: true }],
      }),
    });
    const adapter = createVercelAdapter({ fetchImpl, logger: quiet });
    const res = await adapter.domains({ token: TOKEN, project: 'acme' });
    expect(res.domains[0]).toMatchObject({ name: 'acme.dev', confirmed: true });
    expect(res.domains[1]).toMatchObject({ confirmed: false, misconfigured: true });
    expect(res.instructions.length).toBeGreaterThan(0);
  });

  it('maps readyState values and reports an id-less creation as a failure', async () => {
    expect([mapVercelState('QUEUED'), mapVercelState('INITIALIZING'), mapVercelState('CANCELED'), mapVercelState('???')])
      .toEqual(['queued', 'building', 'canceled', 'queued']);
    expect(projectSettingsFrom({ buildCommand: 'npm run build', outputDir: 'dist' }))
      .toEqual({ framework: null, buildCommand: 'npm run build', outputDirectory: 'dist' });
    const { fetchImpl } = harness({
      'POST /v2/files': json({}),
      'POST /v13/deployments': json({ readyState: 'QUEUED' }),
    });
    const adapter = createVercelAdapter({ fetchImpl, logger: quiet });
    await expect(adapter.startDeploy({
      token: TOKEN, projectName: 'acme', build: {}, bundle: bundle(['index.html', 'aaa']), production: false,
    })).rejects.toThrow(/did not return a deployment id/);
  });
});

describe('netlify adapter', () => {
  it('verify probes /sites and reads identity + accounts', async () => {
    const { calls, fetchImpl } = harness({
      'GET /api/v1/sites': json([{ id: 'site_1', user_id: 'usr_9' }], { status: 200 }),
      'GET /api/v1/user': json({ id: 'usr_9', full_name: 'Ada', email: 'ada@example.com' }),
      'GET /api/v1/accounts': json([{ id: 'acc_1', name: 'Acme', slug: 'acme', type: 'account' }]),
    });
    const adapter = createNetlifyAdapter({ fetchImpl, logger: quiet });
    const res = await adapter.verify({ token: TOKEN });
    expect(res.account.handle).toBe('Ada');
    expect(res.teams[0].slug).toBe('acme');
    expect(calls[0].path).toBe('/api/v1/sites');
    expect(calls[0].query.per_page).toBe('1');
    expect(calls[0].headers['User-Agent']).toBe('NovaCode IDE');
  });

  it('creates a site, sends the digest, and uploads only required files', async () => {
    const { calls, fetchImpl } = harness({
      'POST /api/v1/sites': () => json({ id: 'site_9', name: 'my-app', slug: 'my-app' }),
      'POST /api/v1/sites/site_9/deploys': () => json({ id: 'deploy_9', state: 'uploaded', required: ['bbb'], deploy_ssl_url: 'https://deploy-9.netlify.app' }),
      'PUT /api/v1/deploys/deploy_9/files/assets/app.js': () => json({ id: 'deploy_9' }),
    });
    const adapter = createNetlifyAdapter({ fetchImpl, logger: quiet });
    const progress = [];
    const res = await adapter.startDeploy({
      token: TOKEN,
      projectName: 'My App!',
      production: true,
      build: {},
      bundle: bundle(['index.html', 'aaa'], ['assets/app.js', 'bbb']),
      onProgress: (p) => progress.push(p),
    });
    expect(calls[0].body.name).toBe('my-app'); // site names must be subdomain-safe
    const deploy = calls.find((c) => c.path === '/api/v1/sites/site_9/deploys');
    expect(deploy.body.files).toEqual({ '/index.html': 'aaa', '/assets/app.js': 'bbb' });
    expect(deploy.body.draft).toBe(false);
    const uploads = calls.filter((c) => c.method === 'PUT');
    expect(uploads).toHaveLength(1); // 'aaa' was already stored by digest
    expect(uploads[0].rawBody).toBe('content of assets/app.js');
    expect(res.deploymentId).toBe('deploy_9');
    expect(res.state).toBe('building');
    expect(res.dashboardUrl).toBe('https://app.netlify.com/sites/my-app/deploys/deploy_9');
    expect(res.stats).toMatchObject({ uploaded: 1, skipped: 1 });
    expect(progress).toHaveLength(1);
  });

  it('sends a preview deploy as a draft into the chosen site', async () => {
    const { calls, fetchImpl } = harness({
      'POST /api/v1/sites/site_9/deploys': () => json({ id: 'deploy_10', state: 'ready', required: [] }),
    });
    const adapter = createNetlifyAdapter({ fetchImpl, logger: quiet });
    await adapter.startDeploy({
      token: TOKEN, projectName: 'whatever', project: 'site_9', production: false, build: {}, bundle: bundle(['a.html', 'aaa']),
    });
    expect(calls).toHaveLength(1); // no site created when one was chosen
    expect(calls[0].body.draft).toBe(true);
  });

  it('creates the site inside the selected team account', async () => {
    const { calls, fetchImpl } = harness({
      'POST /api/v1/accounts/acme/sites': () => json({ id: 'site_11', name: 'acme-web' }),
      'POST /api/v1/sites/site_11/deploys': () => json({ id: 'd1', state: 'ready', required: [] }),
    });
    const adapter = createNetlifyAdapter({ fetchImpl, logger: quiet });
    await adapter.startDeploy({
      token: TOKEN, accountSlug: 'acme', projectName: 'acme-web', production: true, build: {}, bundle: bundle(['a.html', 'aaa']),
    });
    expect(calls[0].path).toBe('/api/v1/accounts/acme/sites');
  });

  it('retries with a suffix when the subdomain is taken', async () => {
    let first = true;
    const { calls, fetchImpl } = harness({
      'POST /api/v1/sites': () => {
        if (first) { first = false; return json({ message: 'Name is already taken' }, { status: 422 }); }
        return json({ id: 'site_12', name: 'taken-name-4f2k1' });
      },
      'POST /api/v1/sites/site_12/deploys': () => json({ id: 'd2', state: 'ready', required: [] }),
    });
    const adapter = createNetlifyAdapter({ fetchImpl, logger: quiet });
    const res = await adapter.startDeploy({
      token: TOKEN, projectName: 'taken-name', production: true, build: {}, bundle: bundle(['a.html', 'aaa']),
    });
    expect(calls.filter((c) => c.path === '/api/v1/sites')).toHaveLength(2);
    expect(res.siteId).toBe('site_12');
  });

  it('keeps a URL back until Netlify reports the deploy ready', async () => {
    const { fetchImpl } = harness({
      'GET /api/v1/deploys/d1': json({ state: 'uploading', deploy_ssl_url: 'https://d1.netlify.app' }),
      'GET /api/v1/deploys/d2': json({ state: 'ready', deploy_ssl_url: 'https://d2.netlify.app', admin_url: 'https://app.netlify.com/sites/x/deploys/d2' }),
    });
    const adapter = createNetlifyAdapter({ fetchImpl, logger: quiet });
    expect(await adapter.status({ token: TOKEN, deploymentId: 'd1' })).toMatchObject({ state: 'building', publicUrl: null });
    expect(await adapter.status({ token: TOKEN, deploymentId: 'd2' })).toMatchObject({ state: 'ready', publicUrl: 'https://d2.netlify.app' });
  });

  it('reports honestly when Netlify has no cancel endpoint', async () => {
    const { calls, fetchImpl } = harness({
      // 404 rather than a thrown request: this is what the live API answers
      // today, and it must not be retried or reported as a cancellation.
      'POST /api/v1/deploys/d1/cancel': () => json({ message: 'Not Found' }, { status: 404 }),
    });
    const adapter = createNetlifyAdapter({ fetchImpl, logger: quiet });
    expect(await adapter.cancel({ token: TOKEN, deploymentId: 'd1' })).toEqual({ ok: true, providerCancelled: false });
    expect(calls).toHaveLength(1);
  });

  it('account env vars need an account scope and never come back as values', async () => {
    const { calls, fetchImpl } = harness({
      'GET /api/v1/accounts/acme/env': json([{ key: 'API_URL', values: [{ value: 'secret' }], secret: true }]),
      'POST /api/v1/accounts/acme/env': () => json({ key: 'TOKEN_KEY' }),
    });
    const adapter = createNetlifyAdapter({ fetchImpl, logger: quiet });
    expect(await adapter.listEnvKeys({ token: TOKEN })).toEqual([]); // no account slug = no guess
    expect(await adapter.listEnvKeys({ token: TOKEN, accountSlug: 'acme' })).toEqual(['API_URL']);
    const written = await adapter.setEnvVars({ token: TOKEN, accountSlug: 'acme', vars: [{ key: 'TOKEN_KEY', value: 'v' }] });
    expect(written.created).toEqual(['TOKEN_KEY']);
    expect(JSON.stringify(calls)).not.toContain('secret');
    expect(calls[1].body).toMatchObject({ key: 'TOKEN_KEY', values: [{ context: 'all', value: 'v' }] });
    expect(await adapter.setEnvVars({ token: TOKEN, vars: [{ key: 'X', value: 'y' }] })).toEqual({ created: [] });
  });

  it('listDeploys needs a site and stops inventing history without one', async () => {
    const { calls, fetchImpl } = harness({});
    const adapter = createNetlifyAdapter({ fetchImpl, logger: quiet });
    expect(await adapter.listDeploys({ token: TOKEN })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('slugifies site names into something Netlify accepts', () => {
    expect(slugifySiteName('My Cool App!!')).toBe('my-cool-app');
    expect(slugifySiteName('   ')).toBe('novacode-site');
    expect(slugifySiteName('-leading-and-trailing-')).toBe('leading-and-trailing');
    expect(slugifySiteName('a'.repeat(80))).toHaveLength(63);
  });

  it('reads the deploy log body through the injected transport', async () => {
    const { calls, fetchImpl } = harness({
      'GET /api/v1/deploys/d1/logs': () => json({ deployLog: 'https://logs.netlify.com/abc' }),
      'GET /abc': () => textBody('Building site\nDone in 4s'),
    });
    const adapter = createNetlifyAdapter({ fetchImpl, logger: quiet });
    const text = await adapter.logs({ token: TOKEN, deploymentId: 'd1' });
    expect(text).toContain('— deployLog —');
    expect(text).toContain('Done in 4s');
    expect(calls.map((c) => c.path)).toEqual(['/api/v1/deploys/d1/logs', '/abc']);
    // The presigned log URL is fetched without the account token.
    expect(calls[1].headers.Authorization).toBeUndefined();
  });

  it('falls back to the deploy record when there is no log body', async () => {
    const { fetchImpl } = harness({
      'GET /api/v1/deploys/d1/logs': () => json({}),
      'GET /api/v1/deploys/d1': () => json({ state: 'error', error_message: 'Build exited with code 1' }),
    });
    const adapter = createNetlifyAdapter({ fetchImpl, logger: quiet });
    expect(await adapter.logs({ token: TOKEN, deploymentId: 'd1' })).toMatch(/Build exited with code 1/);
  });
});

describe('provider registry', () => {
  it('describes every provider for the dashboard without any secret material', () => {
    const rows = describeProviders();
    expect(rows.map((r) => r.id)).toEqual(['vercel', 'netlify', 'cloudflare', 'render', 'railway']);
    const vercelRow = rows.find((r) => r.id === 'vercel');
    expect(vercelRow).toMatchObject({ available: true, requiresGit: false });
    expect(vercelRow.supports.providerBuild).toBe(true);
    expect(vercelRow.tokenUrl).toBe('https://vercel.com/account/tokens');
    expect(vercelRow.instructions.length).toBeGreaterThan(0);
    const netlifyRow = rows.find((r) => r.id === 'netlify');
    expect(netlifyRow.supports.providerBuild).toBe(false);
    expect(netlifyRow.supports.next).toBe(false);
    for (const row of rows.filter((r) => !r.available)) {
      expect(row.reason).toBeTruthy();
      expect(row.tokenUrl).toBeNull();
    }
    expect(JSON.stringify(rows)).not.toContain(TOKEN_SECRET('vercel'));
  });

  it('lists only implemented providers for network work', () => {
    expect(listAvailable().map((p) => p.id)).toEqual(['vercel', 'netlify']);
  });

  it('refuses to build an adapter for a reserved slot', () => {
    expect(() => getAdapter('cloudflare')).toThrow(/Cloudflare Pages is not wired up/);
    expect(() => getAdapter('nope')).toThrow(/Unknown hosting provider/);
  });

  it('names each stored token after the provider, never the token', () => {
    expect(TOKEN_SECRET('vercel')).toBe('hosting-vercel-token');
    expect(TOKEN_SECRET('netlify')).toBe('hosting-netlify-token');
  });
});
