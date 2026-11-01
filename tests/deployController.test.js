/**
 * Deploy controller tests.
 *
 * The controller is where the spec's promises live: nothing leaves the machine
 * before an explicit confirmation, a public URL only ever comes from the
 * provider's own status call, and a token never travels back toward the renderer.
 *
 * These run the REAL provider adapters and the REAL HTTP layer against a fake
 * transport, so the wire contract is part of the assertion, not assumed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeployController, buildSettings, normalizeEnvVars } from '../electron/services/deploy/deployController';
import { createDeployHistory } from '../electron/services/deploy/deployHistory';
import { TOKEN_SECRET } from '../electron/services/deploy/providers';

// Synthetic fixtures on purpose: they carry no provider prefix, so nothing in this
// repository can be mistaken for a real credential by a reader or a secret scanner.
const TOKEN = 'fixture-token-not-a-secret-vercel';
const NETLIFY_TOKEN = 'fixture-token-not-a-secret-netlify';
const ROOT = '/projects/demo-site';
const quiet = { info() {}, warn() {}, error() {} };

function sha1(text) { return crypto.createHash('sha1').update(text).digest('hex'); }

function jsonResponse(status, body, type = 'application/json') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? type : null) },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** Route table harness: 'METHOD /a/:param' -> handler, matched on path segments. */
function makeTransport(routes) {
  const compiled = Object.entries(routes).map(([key, value]) => {
    const [method, spec] = key.split(' ');
    return { key, method, parts: spec.split('/'), value };
  });
  const calls = [];
  const counts = {};

  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const record = {
      key: `${method} ${parsed.pathname}`,
      method,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams.entries()),
      headers: init.headers || {},
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      raw: (Buffer.isBuffer(init.body) || init.body instanceof Uint8Array) ? Buffer.from(init.body).toString() : undefined,
    };
    calls.push(record);
    const segs = parsed.pathname.split('/');
    for (const route of compiled) {
      if (route.method !== method || route.parts.length !== segs.length) continue;
      const params = {};
      let matched = true;
      for (let i = 0; i < segs.length; i += 1) {
        const spec = route.parts[i];
        if (spec.startsWith(':')) { params[spec.slice(1)] = decodeURIComponent(segs[i]); continue; }
        if (spec !== segs[i]) { matched = false; break; }
      }
      if (!matched) continue;
      counts[route.key] = (counts[route.key] || 0) + 1;
      const out = typeof route.value === 'function'
        ? route.value({ ...record, params, call: counts[route.key], calls })
        : route.value;
      if (out && out.networkError) throw new Error(out.networkError);
      return jsonResponse(out.status ?? 200, out.body, out.type);
    }
    throw new Error(`unrouted ${record.key}`);
  };

  const keys = () => calls.map((c) => c.key);
  const find = (key) => calls.find((c) => c.key === key);
  const all = (key) => calls.filter((c) => c.key === key);
  return { fetchImpl, calls, counts, keys, find, all };
}

function profileFixture(overrides = {}) {
  return {
    kind: 'node',
    framework: 'vite',
    ssr: false,
    hasPackageJson: true,
    projectName: 'demo-site',
    packageManager: 'npm',
    scripts: { build: 'vite build' },
    buildCommand: 'npm run build',
    outputDir: 'dist',
    outputExists: true,
    nodeModulesInstalled: true,
    dependencies: { vite: '^5.0.0' },
    providerConfig: { vercel: null, netlify: null, viteOutDir: null, nextStaticExport: false },
    backend: { detected: false, evidence: [] },
    deployMode: 'prebuilt',
    targetKind: 'static',
    deployable: true,
    blockers: [],
    warnings: [],
    frontendOnly: false,
    ...overrides,
  };
}

function bundleFixture(files = { 'index.html': '<h1>hi</h1>', 'assets/app.js': 'console.log(1)' }) {
  const list = Object.entries(files).map(([p, c]) => ({
    path: p,
    sha: sha1(c),
    size: Buffer.byteLength(c),
    read: async () => Buffer.from(c),
  }));
  return {
    files: list,
    fileCount: list.length,
    totalBytes: list.reduce((sum, f) => sum + f.size, 0),
    excluded: { secrets: [], ignored: 0, tooLarge: [] },
    warnings: [],
  };
}

function makeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getSecret: async (name) => map.get(name) ?? null,
    getSecretSource: async (name) => (map.has(name) ? 'os-encrypted' : null),
    setSecret: async (name, value) => { map.set(name, value); return { storage: 'os-encrypted', name }; },
    clearSecret: async (name) => { map.delete(name); return true; },
  };
}

/**
 * Vercel's happy path: file upload -> project -> deployment -> BUILDING -> READY.
 * Any route can be overridden per test.
 */
function vercelRoutes(extra = {}) {
  let polls = 0;
  return {
    'GET /v2/user': () => ({ body: { user: { id: 'usr_1', username: 'demo-user', email: 'demo@example.com' } } }),
    'GET /v2/teams': () => ({ body: { teams: [{ id: 'team_abc', name: 'Acme', slug: 'acme' }] } }),
    'GET /v10/projects': () => ({ body: { projects: [{ id: 'prj_1', name: 'demo-site', framework: 'vite' }] } }),
    'GET /v10/projects/:project/env': () => ({ body: { envs: [] } }),
    'POST /v10/projects/:project/env': () => ({ body: { ok: true } }),
    'POST /v2/files': ({ headers }) => ({ body: { sha: headers['x-vercel-digest'] } }),
    'POST /v11/projects': ({ body }) => ({ body: { id: 'prj_1', name: body.name } }),
    'GET /v9/projects/:project': () => ({ status: 404, body: { error: { code: 'not_found' } } }),
    'POST /v13/deployments': () => ({
      body: {
        id: 'dpl_1', url: 'demo-site.vercel.app', inspectUrl: 'https://vercel.com/demo-user/dpl_1',
        readyState: 'QUEUED', projectId: 'prj_1',
      },
    }),
    'GET /v3/deployments/:id': () => {
      polls += 1;
      return {
        body: polls === 1
          ? { readyState: 'BUILDING', url: 'demo-site.vercel.app' }
          : { readyState: 'READY', url: 'demo-site.vercel.app', alias: ['demo-site.vercel.app'] },
      };
    },
    'GET /v3/deployments/:id/events': () => ({ body: { events: [] } }),
    'PATCH /v12/deployments/:id/cancel': () => ({ body: { ok: true } }),
    'GET /v7/deployments': () => ({ body: { deployments: [] } }),
    'GET /v9/projects/:project/domains': () => ({ body: { domains: [] } }),
    ...extra,
  };
}

/**
 * Netlify's API deploy: create site -> send digest map -> upload required files
 * -> poll the deploy state. Paths carry the /api/v1 prefix the adapter uses.
 */
function netlifyRoutes(extra = {}) {
  let polls = 0;
  return {
    'GET /api/v1/sites': () => ({ body: [{ id: 'site_0', name: 'existing' }] }),
    'GET /api/v1/user': () => ({ body: { id: 'user_1', full_name: 'demo-user', email: 'demo@example.com' } }),
    'GET /api/v1/accounts': () => ({ body: [{ id: 'acct_1', name: 'Acme', slug: 'acme', type: 'team' }] }),
    'GET /api/v1/accounts/:slug/env': () => ({ body: [{ key: 'API_URL', values: [{ value: 'hunter2-secret' }] }] }),
    'POST /api/v1/accounts/:slug/env': () => ({ body: { key: 'API_URL' } }),
    'POST /api/v1/sites': ({ body }) => ({ body: { id: 'site_1', name: body.name, slug: body.name, ssl_url: `https://${body.name}.netlify.app` } }),
    'POST /api/v1/accounts/:slug/sites': ({ body }) => ({ body: { id: 'site_1', name: body.name, slug: body.name, ssl_url: `https://${body.name}.netlify.app` } }),
    'POST /api/v1/sites/:site/deploys': () => ({
      body: {
        id: 'dep_1',
        state: 'uploading',
        // Netlify already stores styles.css by digest, so it asks for one file.
        required: [sha1('<h1>hi</h1>')],
      },
    }),
    'PUT /api/v1/deploys/:id/files/:path': () => ({ status: 201, body: {} }),
    'GET /api/v1/deploys/:id': () => {
      polls += 1;
      return {
        body: polls === 1
          ? { state: 'uploading' }
          : { state: 'ready', ssl_url: 'https://demo-site.netlify.app', deploy_ssl_url: 'https://demo-site.netlify.app', admin_url: 'https://app.netlify.com/sites/demo-site/deploys/dep_1' },
      };
    },
    'POST /api/v1/deploys/:id/cancel': () => ({ status: 404, body: { message: 'Not Found' } }),
    'GET /api/v1/deploys/:id/logs': () => ({ status: 404, body: { message: 'Not Found' } }),
    'GET /api/v1/sites/:site': () => ({ body: { id: 'site_1', name: 'demo-site' } }),
    ...extra,
  };
}

let historySeq = 0;
let tmpDir = os.tmpdir();
beforeAll(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-controller-')); });
afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function controllerFixture({
  provider = 'vercel',
  routes = {},
  profile = {},
  bundle = bundleFixture(),
  collectError = null,
  missing = [],
  envWarnings = [],
  buildResult = null,
  store = null,
  settings = null,
  maxPollMs = 60000,
  warnSink = null,
  adapterHttp = { maxAttempts: 1 },
} = {}) {
  const transport = makeTransport(routes);
  const clock = { value: 1769644800000 };
  const events = [];
  const builds = [];
  const packed = [];
  const detected = [];
  const scannerSeen = [];
  const savedSettings = [];
  const deploy = {
    detect: async (root) => { detected.push(root); return profileFixture(profile); },
    build: async (root, options) => {
      builds.push({ root, ...options });
      return buildResult ?? { code: 0, output: 'vite v5.0.0  build started…\nvite v5.0.0  built in 412ms' };
    },
  };
  const detectEnvRequirements = async ({ providerKeys }) => {
    scannerSeen.push(providerKeys || []);
    return {
      required: missing.map((key) => ({ key, source: 'src/api.js', buildTime: false })),
      fromExampleFiles: [],
      locallyDefined: [],
      providerDefined: providerKeys || [],
      missing,
      warnings: envWarnings,
    };
  };
  const secret = store || makeStore(provider === 'vercel' ? { [TOKEN_SECRET('vercel')]: TOKEN } : { [TOKEN_SECRET(provider)]: NETLIFY_TOKEN });
  const settingsFake = settings || {
    load: async () => ({ deploy: { provider: '', teams: {} }, ...((settings && settings.initial) || {}) }),
    save: async (patch) => { savedSettings.push(patch); return patch; },
  };
  const history = createDeployHistory({
    filePath: path.join(tmpDir, `history-${historySeq += 1}.json`),
    logger: quiet,
    now: () => new Date(clock.value).toISOString(),
  });
  const logger = { ...quiet, warn: warnSink || (() => {}) };

  const controller = createDeployController({
    deploy,
    secretStore: secret,
    settings: settingsFake,
    history,
    logger,
    fetchImpl: transport.fetchImpl,
    adapterHttp,
    collectBundle: collectError ? async () => { throw collectError; } : async (options) => {
      packed.push(options);
      return typeof bundle === 'function' ? bundle(options) : bundle;
    },
    detectEnvRequirements,
    pollIntervalMs: 1000,
    maxPollMs,
    buildTimeoutMs: 5000,
    wait: async (ms) => { clock.value += ms; },
    now: () => clock.value,
  });

  const emit = (event) => events.push(event);
  const phases = () => events.filter((e) => e.type === 'phase').map((e) => e.phase);
  const states = () => events.filter((e) => e.type === 'state').map((e) => e.state);

  async function settle(runId) {
    for (let i = 0; i < 400; i += 1) {
      const snap = controller.status({ runId });
      if (snap.final) return snap;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`run never settled: ${JSON.stringify(controller.status({ runId }))}`);
  }

  const start = (payload = {}) => controller.start({ root: ROOT, provider, ...payload }, emit);

  return {
    controller, transport, events, builds, packed, detected, scannerSeen, secret, history, clock,
    settingsFake, savedSettings, settle, phases, states, start, emit,
  };
}

describe('provider wiring', () => {
  it('refuses to build an adapter for a provider it has not implemented', async () => {
    const { controller } = controllerFixture({ routes: vercelRoutes() });
    await expect(controller.plan({ root: ROOT, provider: 'nope' })).rejects.toThrow(/Unknown hosting provider/);
  });

  it('names the reason instead of faking a planned provider', async () => {
    const { controller } = controllerFixture({ routes: vercelRoutes() });
    await expect(controller.connect({ provider: 'cloudflare', token: 'x' })).rejects.toThrow(/Cloudflare Pages is not wired up yet/);
    const list = controller.providers();
    expect(list.find((p) => p.id === 'cloudflare').available).toBe(false);
    expect(list.find((p) => p.id === 'cloudflare').reason).toMatch(/not been implemented/);
  });
});

describe('connecting an account', () => {
  it('stores the token only after the provider accepts it', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    const result = await f.controller.connect({ provider: 'vercel', token: TOKEN });
    expect(result).toMatchObject({ ok: true, provider: 'vercel', storage: 'os-encrypted' });
    expect(result.account.handle).toBe('demo-user');
    expect(result.teams).toEqual([{ id: 'team_abc', name: 'Acme', slug: 'acme' }]);
    expect(f.secret.map.get(TOKEN_SECRET('vercel'))).toBe(TOKEN);
    expect(f.transport.keys()).toContain('GET /v2/user');
  });

  it('never stores a token the provider rejected', async () => {
    const store = makeStore({});
    const f = controllerFixture({
      store,
      routes: vercelRoutes({ 'GET /v2/user': () => ({ status: 401, body: { error: { code: 'not_authenticated', message: 'The provided token is not valid.' } } }) }),
    });
    await expect(f.controller.connect({ provider: 'vercel', token: 'bad-token' })).rejects.toThrow(/not valid/);
    expect([...store.map.keys()]).toEqual([]);
  });

  it('an empty token is rejected before any network call', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    await expect(f.controller.connect({ provider: 'vercel', token: '   ' })).rejects.toThrow(/access token is required/);
    expect(f.transport.calls).toHaveLength(0);
  });

  it('disconnect removes the stored credential', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    await f.controller.disconnect({ provider: 'vercel' });
    expect(f.secret.map.has(TOKEN_SECRET('vercel'))).toBe(false);
  });

  it('reports a connection without ever returning the secret', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    const rows = await f.controller.connections();
    const vercel = rows.find((r) => r.id === 'vercel');
    expect(vercel).toMatchObject({ connected: true, storage: 'os-encrypted', label: 'Vercel' });
    expect(vercel.account.handle).toBe('demo-user');
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    const netlify = rows.find((r) => r.id === 'netlify');
    expect(netlify.connected).toBe(false);
    expect(netlify.storage).toBeNull();
    expect(rows.find((r) => r.id === 'cloudflare').connected).toBe(false);
  });

  it('does not claim a stored token works when the provider stops accepting it', async () => {
    const f = controllerFixture({ routes: vercelRoutes({ 'GET /v2/user': () => ({ status: 403, body: { error: { message: 'Token revoked.' } } }) }) });
    const [vercel] = (await f.controller.connections()).filter((r) => r.id === 'vercel');
    // "Connected" is a claim about the host, not about our own key store, so a
    // token the provider refuses is not connected. `hasToken` keeps the two
    // states apart so the panel can offer the right repair.
    expect(vercel.connected).toBe(false);
    expect(vercel.hasToken).toBe(true);
    expect(vercel.storage).toBe('os-encrypted');
    expect(vercel.account).toBeNull();
    expect(vercel.error).toMatch(/Token revoked/);
    expect(JSON.stringify(vercel)).not.toContain(TOKEN);
  });

  it('shows the rejection on the review screen instead of a green account row', async () => {
    const f = controllerFixture({
      routes: vercelRoutes({ 'GET /v2/user': () => ({ status: 401, body: { error: { code: 'not_authenticated', message: 'The provided token is not valid.' } } }) }),
    });
    const plan = await f.controller.plan({ root: ROOT, provider: 'vercel' });
    const check = plan.checks.find((c) => c.id === 'account');
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/token is not valid/);
    expect(plan.blockers.join(' ')).toMatch(/rejected the stored token/);
  });

  it('refuses to upload a single byte when the provider has rejected the token', async () => {
    const f = controllerFixture({ routes: vercelRoutes({ 'GET /v2/user': () => ({ status: 403, body: { error: { message: 'Token revoked.' } } }) }) });
    const error = await f.start({ production: true, confirmProduction: true }).catch((e) => e);
    expect(error.code).toBe('AUTH_FAILED');
    expect(error.message).toMatch(/Token revoked/);
    expect(f.transport.keys()).not.toContain('POST /v2/files');
    expect(f.transport.keys()).not.toContain('POST /v13/deployments');
    expect(f.packed).toHaveLength(0);
    expect(f.controller.listRuns()).toHaveLength(0);
  });

  it('asks the provider which teams exist so the user picks the target', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    const result = await f.controller.teams({ provider: 'vercel' });
    expect(result.teams).toEqual([{ id: 'team_abc', name: 'Acme', slug: 'acme' }]);
    expect(result.account.handle).toBe('demo-user');
  });

  it('refuses to act for a provider with no stored token', async () => {
    const f = controllerFixture({ routes: vercelRoutes(), store: makeStore({}) });
    const error = await f.controller.teams({ provider: 'vercel' }).catch((e) => e);
    expect(error.code).toBe('NOT_CONNECTED');
    expect(error.message).toMatch(/Vercel is not connected/);
  });
});

describe('the review plan', () => {
  it('answers every question the review screen shows', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    const plan = await f.controller.plan({ root: ROOT, provider: 'vercel' });
    expect(plan.root).toBe(ROOT);
    expect(plan.providerLabel).toBe('Vercel');
    expect(plan.deployMode).toBe('prebuilt');
    expect(plan.build).toEqual({
      buildCommand: 'npm run build', installCommand: null, outputDir: 'dist', framework: 'vite', root: ROOT,
    });
    expect(plan.checks.map((c) => c.id)).toEqual(['project', 'account', 'git', 'deps', 'target', 'env']);
    expect(plan.checks.every((c) => c.ok)).toBe(true);
    expect(plan.blockers).toEqual([]);
    expect(plan.supports.providerBuild).toBe(true);
  });

  it('says plainly that no Git repository is needed', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    const plan = await f.controller.plan({ root: ROOT, provider: 'vercel' });
    const git = plan.checks.find((c) => c.id === 'git');
    expect(git.ok).toBe(true);
    expect(git.label).toBe('No Git repository needed');
  });

  it('tells the user when dependencies are missing without failing the plan', async () => {
    const f = controllerFixture({ routes: vercelRoutes(), profile: { nodeModulesInstalled: false } });
    const plan = await f.controller.plan({ root: ROOT, provider: 'vercel' });
    expect(plan.build.installCommand).toBe('npm install');
    const deps = plan.checks.find((c) => c.id === 'deps');
    expect(deps.label).toBe('Dependencies not installed');
    expect(deps.ok).toBe(true);
    expect(deps.detail).toMatch(/NovaCode will run the install command/);
  });

  it('is honest about an account that has not been connected yet', async () => {
    const f = controllerFixture({ routes: vercelRoutes(), store: makeStore({}) });
    const plan = await f.controller.plan({ root: ROOT, provider: 'vercel' });
    const account = plan.checks.find((c) => c.id === 'account');
    expect(account.ok).toBe(false);
    expect(account.detail).toMatch(/Not connected\. Add your Vercel access token/);
  });

  it('lists missing variable names and never their values', async () => {
    const f = controllerFixture({
      routes: vercelRoutes({ 'GET /v10/projects/:project/env': () => ({ body: { envs: [{ key: 'API_URL', value: 'hunter2-secret' }] } }) }),
      missing: ['STRIPE_SECRET_KEY'],
    });
    const plan = await f.controller.plan({ root: ROOT, provider: 'vercel' });
    expect(plan.env.missing).toEqual(['STRIPE_SECRET_KEY']);
    expect(plan.needs.needsEnvValues).toBe(true);
    expect(plan.checks.find((c) => c.id === 'env').detail).toBe('Missing (names only): STRIPE_SECRET_KEY');
    // The host already knows API_URL, so it is handed to the scanner and not
    // reported again — and its value never enters the plan.
    expect(f.scannerSeen.at(-1)).toEqual(['API_URL']);
    expect(JSON.stringify(plan)).not.toContain('hunter2-secret');
  });

  it('asks for the frontend-only acknowledgement when a backend would be dropped', async () => {
    const f = controllerFixture({
      routes: vercelRoutes(),
      profile: { frontendOnly: true, backend: { detected: true, evidence: ['dependency express'] } },
    });
    const plan = await f.controller.plan({ root: ROOT, provider: 'vercel' });
    expect(plan.needs.acknowledgeFrontendOnly).toBe(true);
  });

  it('asks for build approval only when a local build is actually needed', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    expect((await f.controller.plan({ root: ROOT, provider: 'vercel' })).needs.confirmBuild).toBe(false);
    const rebuilt = await f.controller.plan({ root: ROOT, provider: 'vercel', rebuild: true });
    expect(rebuilt.needs.confirmBuild).toBe(true);
  });

  it('explains what has to change when the host cannot build the app', async () => {
    const f = controllerFixture({
      provider: 'netlify',
      routes: netlifyRoutes(),
      profile: { framework: 'next', ssr: true, deployMode: 'provider-build', targetKind: 'server', outputDir: '.next' },
    });
    const plan = await f.controller.plan({ root: ROOT, provider: 'netlify' });
    const target = plan.checks.find((c) => c.id === 'target');
    expect(target.ok).toBe(false);
    expect(target.label).toBe('Host must build, but cannot here');
    expect(plan.blockers[0]).toMatch(/connect the Git repository in Netlify/i);
    expect(plan.blockers[0]).toMatch(/output: 'export'/);
  });

  it('refuses to plan a folder it was not given', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    await expect(f.controller.plan({ root: '   ', provider: 'vercel' })).rejects.toThrow(/Open a folder first/);
  });
});

describe('confirmation gates', () => {
  function gateFixture(extra = {}) {
    return controllerFixture({ routes: vercelRoutes(), ...extra });
  }

  it('will not publish to production without an explicit confirmation', async () => {
    const f = gateFixture();
    const error = await f.start({ production: true }).catch((e) => e);
    expect(error.name).toBe('DeployConfirmationError');
    expect(error.code).toBe('CONFIRMATION_REQUIRED');
    expect(error.fields).toEqual(['confirmProduction']);
    expect(error.message).toMatch(/Confirm the production publish/);
    // The whole point: not one byte reached the host.
    expect(f.transport.calls).toEqual([]);
  });

  it('will not run the project’s own build script without approval', async () => {
    const f = gateFixture({ profile: { outputExists: false } });
    const error = await f.start({ production: true, confirmProduction: true, rebuild: true }).catch((e) => e);
    expect(error.fields).toEqual(['confirmBuild']);
    expect(f.builds).toEqual([]);
    expect(f.transport.calls).toEqual([]);
  });

  it('will not silently drop a backend', async () => {
    const f = gateFixture({ profile: { frontendOnly: true } });
    const error = await f.start({ production: true, confirmProduction: true }).catch((e) => e);
    expect(error.fields).toEqual(['acknowledgeFrontendOnly']);
  });

  it('lists every missing approval at once so the user is not nagged twice', async () => {
    const f = gateFixture({ profile: { frontendOnly: true, outputExists: false } });
    const error = await f.start({ production: true, rebuild: true }).catch((e) => e);
    expect(error.fields).toEqual(['confirmProduction', 'confirmBuild', 'acknowledgeFrontendOnly']);
  });

  it('accepts a preview publish without the production confirmation', async () => {
    const f = gateFixture();
    const run = await f.start({ production: false });
    expect(run.target).toBe('preview');
    const final = await f.settle(run.runId);
    expect(final.state).toBe('ready');
    const create = f.transport.find('POST /v13/deployments');
    expect(create.body.target).toBeUndefined(); // no production target
  });

  it('stops on a project-level blocker before touching the network', async () => {
    const f = gateFixture({ profile: { blockers: ['package.json is not valid JSON — fix it before deploying.'], deployable: false } });
    const error = await f.start({ production: true, confirmProduction: true }).catch((e) => e);
    expect(error.code).toBe('PROJECT_BLOCKED');
    expect(error.message).toMatch(/not valid JSON/);
    expect(f.transport.calls).toEqual([]);
  });

  it('stops when the host cannot build an app that needs a server', async () => {
    const f = controllerFixture({
      provider: 'netlify',
      routes: netlifyRoutes(),
      profile: { framework: 'next', ssr: true, deployMode: 'provider-build', targetKind: 'server', outputDir: '.next' },
    });
    const error = await f.start({ production: true, confirmProduction: true }).catch((e) => e);
    expect(error.code).toBe('PROJECT_BLOCKED');
    expect(error.message).toMatch(/Netlify cannot build next/);
    expect(f.transport.calls).toEqual([]);
  });

  it('stops before any upload when no account is connected', async () => {
    const f = gateFixture({ store: makeStore({}) });
    const error = await f.start({ production: true, confirmProduction: true }).catch((e) => e);
    expect(error.code).toBe('NOT_CONNECTED');
    expect(f.transport.calls).toEqual([]);
  });

  it('reports an unknown run id instead of inventing one', () => {
    const f = gateFixture();
    expect(() => f.controller.status({ runId: 'run-nope' })).toThrow(/no longer known/);
    expect(() => f.controller.runLogs({ runId: 'run-nope' })).toThrow(/no longer known/);
  });
});

describe('environment variables in the pipeline', () => {
  it('refuses a production publish with unaccounted variables, naming them without values', async () => {
    const f = controllerFixture({ routes: vercelRoutes(), missing: ['API_URL', 'STRIPE_SECRET_KEY'] });
    const error = await f.start({ production: true, confirmProduction: true }).catch((e) => e);
    expect(error.code).toBe('MISSING_ENV_VARS');
    expect(error.fields).toEqual(['API_URL', 'STRIPE_SECRET_KEY']);
    expect(error.message).toMatch(/Set these environment variables first/);
    expect(f.transport.all('POST /v2/files')).toEqual([]);
  });

  it('lets a preview deploy go out with variables unset, because it is not the live site', async () => {
    const f = controllerFixture({ routes: vercelRoutes(), missing: ['API_URL'] });
    const run = await f.start({ production: false });
    const final = await f.settle(run.runId);
    expect(final.state).toBe('ready');
  });

  it('sends supplied values to the host only, and never into a log', async () => {
    const f = controllerFixture({ routes: vercelRoutes(), missing: ['API_URL'] });
    const run = await f.start({
      production: true,
      confirmProduction: true,
      envVars: [{ key: 'API_URL', value: 'https://api.example.com' }],
    });
    const final = await f.settle(run.runId);
    expect(final.state).toBe('ready');

    const post = f.transport.find('POST /v10/projects/demo-site/env');
    expect(post.body.envs).toEqual([{
      key: 'API_URL', value: 'https://api.example.com', type: 'encrypted',
      target: ['production', 'preview', 'development'],
    }]);
    // Names are logged, values never — not in events, not in the run log, not in history.
    expect(f.events.some((e) => JSON.stringify(e).includes('https://api.example.com'))).toBe(false);
    expect(f.controller.runLogs({ runId: run.runId }).text).not.toContain('https://api.example.com');
    expect(f.controller.runLogs({ runId: run.runId }).text).toContain('API_URL');
    expect(JSON.stringify(await f.controller.historyList({ root: ROOT }))).not.toContain('https://api.example.com');
  });

  it('drops malformed variable keys instead of sending them', async () => {
    expect(normalizeEnvVars([
      { key: 'BAD-NAME', value: 'x' },
      { key: '9LEADING', value: 'x' },
      { key: 'OK_NAME', value: '   ' },
      { key: '  SPACED  ', value: 'y' },
      null,
      { key: 'X', value: 'z'.repeat(9000) },
      { key: 'X', value: 'duplicate' },
    ])).toEqual([{ key: 'SPACED', value: 'y' }, { key: 'X', value: 'z'.repeat(8000) }]);
    expect(normalizeEnvVars('nope')).toEqual([]);
  });

  it('keeps the exact case a project reads, because the host does too', async () => {
    // Uppercasing `connectionString` would create a variable the app never sees
    // and still report a successful deploy.
    expect(normalizeEnvVars([
      { key: 'connectionString', value: 'postgres://x' },
      { key: 'CONNECTIONSTRING', value: 'other' },
    ])).toEqual([
      { key: 'connectionString', value: 'postgres://x' },
      { key: 'CONNECTIONSTRING', value: 'other' },
    ]);
  });
});

describe('the deploy pipeline against the real Vercel wire', () => {
  it('runs the whole pipeline and ends on the provider’s own confirmation', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    const run = await f.start({ production: true, confirmProduction: true });
    expect(run).toMatchObject({ provider: 'vercel', phase: 'validating', state: 'queued', publicUrl: null, final: false });
    const final = await f.settle(run.runId);

    expect(f.phases()).toEqual(['validating', 'packing', 'uploading', 'deploying']);
    expect(final).toMatchObject({
      state: 'ready',
      phase: 'live',
      publicUrl: 'https://demo-site.vercel.app',
      deploymentId: 'dpl_1',
      dashboardUrl: 'https://vercel.com/demo-user/dpl_1',
      projectId: 'prj_1',
      fileCount: 2,
      totalBytes: 25,
      final: true,
    });
    expect(final.message).toBe('Live at https://demo-site.vercel.app');
    expect(final.upload).toEqual({ uploaded: 2, total: 2, bytes: 25 });
    expect(final.finishedAt).toBe(new Date(f.clock.value).toISOString());
  });

  it('uploads each distinct digest once before creating the deployment', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    const run = await f.start({ production: true, confirmProduction: true });
    await f.settle(run.runId);
    expect(f.transport.keys()).toEqual([
      // The account is proven with the host before anything is sent, and the
      // answer is cached, so this happens once per session rather than per call.
      'GET /v2/user',
      'GET /v2/teams',
      'GET /v10/projects/demo-site/env',
      'POST /v2/files',
      'POST /v2/files',
      'POST /v11/projects',
      'POST /v13/deployments',
      'GET /v3/deployments/dpl_1',
      'GET /v3/deployments/dpl_1',
    ]);
    const digests = f.transport.all('POST /v2/files').map((c) => c.headers['x-vercel-digest']);
    expect(digests).toEqual([sha1('<h1>hi</h1>'), sha1('console.log(1)')]);
    expect(f.transport.all('POST /v2/files')[0].raw).toBe('<h1>hi</h1>');
    expect(f.transport.all('POST /v2/files')[0].headers['x-now-size']).toBe('11');
  });

  it('sends the reviewed build settings with the deployment', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    const run = await f.start({ production: true, confirmProduction: true });
    await f.settle(run.runId);
    const create = f.transport.find('POST /v13/deployments');
    expect(create.body).toEqual({
      name: 'demo-site',
      project: 'demo-site',
      target: 'production',
      skipAutoDetectionConfirmation: 1,
      projectSettings: { framework: 'vite', buildCommand: 'npm run build', outputDirectory: 'dist' },
      files: [
        { file: 'index.html', sha: sha1('<h1>hi</h1>'), size: 11 },
        { file: 'assets/app.js', sha: sha1('console.log(1)'), size: 14 },
      ],
    });
  });

  it('deploys into the team the user picked, on every single call', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    const run = await f.start({ production: true, confirmProduction: true, teamId: 'team_abc' });
    await f.settle(run.runId);
    // /v2/user and /v2/teams describe the account itself and take no team
    // parameter; every call that writes is scoped, which is what §3 requires.
    const scoped = f.transport.calls.filter((c) => !/^GET \/v2\/(user|teams)$/.test(c.key));
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((c) => c.query.teamId === 'team_abc')).toBe(true);
    const [row] = await f.controller.historyList({ root: ROOT });
    expect(row.teamId).toBe('team_abc');
  });

  it('ignores a team id shaped like something else', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    const run = await f.start({ production: true, confirmProduction: true, teamId: 'team/../etc' });
    await f.settle(run.runId);
    expect(f.transport.calls.every((c) => c.query.teamId === undefined)).toBe(true);
  });

  it('runs install then build when it has to build locally', async () => {
    const f = controllerFixture({ routes: vercelRoutes(), profile: { nodeModulesInstalled: false, outputExists: false } });
    const run = await f.start({
      production: true, confirmProduction: true, confirmBuild: true, rebuild: true,
    });
    await f.settle(run.runId);
    expect(f.builds.map((b) => b.command)).toEqual(['npm install', 'npm run build']);
    expect(f.builds[0].root).toBe(ROOT);
    expect(f.builds[0].timeoutMs).toBe(5000);
    const log = f.controller.runLogs({ runId: run.runId }).text;
    expect(log).toContain('$ npm install');
    expect(log).toContain('$ npm run build');
    expect(log).toContain('built in 412ms');
  });

  it('packs the build output folder, never the workspace, for a static deploy', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    const run = await f.start({ production: true, confirmProduction: true });
    await f.settle(run.runId);
    expect(f.packed[0]).toEqual({ root: ROOT, dir: 'dist', logger: expect.any(Object) });
  });

  it('packs the whole workspace when the host has to build the app', async () => {
    const f = controllerFixture({
      routes: vercelRoutes(),
      profile: { framework: 'next', ssr: true, deployMode: 'provider-build', targetKind: 'server', outputDir: '.next', scripts: { build: 'next build' }, buildCommand: 'npm run build' },
    });
    const run = await f.start({ production: true, confirmProduction: true });
    await f.settle(run.runId);
    expect(f.packed[0].dir).toBe(ROOT);
    expect(f.builds).toEqual([]); // the host builds it, so no local build
    expect(f.transport.find('POST /v13/deployments').body.projectSettings.framework).toBe('next');
    const [row] = await f.controller.historyList({ root: ROOT });
    expect(row.deployMode).toBe('provider-build');
    expect(row.framework).toBe('next');
  });

  it('reports a failed dependency install and uploads nothing', async () => {
    const f = controllerFixture({
      routes: vercelRoutes(),
      profile: { nodeModulesInstalled: false, outputExists: false },
      buildResult: { code: 1, output: 'npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/left-pad' },
    });
    const run = await f.start({ production: true, confirmProduction: true, confirmBuild: true, rebuild: true });
    const final = await f.settle(run.runId);
    expect(final.state).toBe('error');
    expect(final.phase).toBe('failed');
    expect(final.error.code).toBeNull();
    expect(final.message).toMatch(/Dependency install failed \(1\)/);
    expect(final.message).toContain('404 Not Found');
    expect(f.transport.all('POST /v2/files')).toEqual([]);
    expect(final.publicUrl).toBeNull();
  });

  it('turns a non-zero build exit into a failure that explains itself', async () => {
    const f = controllerFixture({
      routes: vercelRoutes(),
      profile: { outputExists: false },
      buildResult: { code: 2, output: 'vite v5.0.0 building for production...\nerror: Cannot resolve entry module index.html' },
    });
    const run = await f.start({ production: true, confirmProduction: true, confirmBuild: true, rebuild: true });
    const final = await f.settle(run.runId);
    expect(final.state).toBe('error');
    expect(final.message).toMatch(/Build failed \(2\)/);
    expect(final.message).toContain('Cannot resolve entry module');
    expect(f.transport.all('POST /v13/deployments')).toEqual([]);
  });

  it('keeps going when the runner reports success', async () => {
    const f = controllerFixture({ routes: vercelRoutes(), profile: { outputExists: false } });
    const run = await f.start({ production: true, confirmProduction: true, confirmBuild: true, rebuild: true });
    const final = await f.settle(run.runId);
    expect(final.state).toBe('ready');
    expect(f.builds).toHaveLength(1);
  });

  it('logs the secret rules that removed files from the bundle', async () => {
    const bundle = {
      ...bundleFixture({ 'index.html': '<h1>hi</h1>' }),
      fileCount: 1,
      totalBytes: 11,
      excluded: { secrets: [{ path: '.env', reason: 'local environment secrets' }], ignored: 2, tooLarge: [] },
    };
    const f = controllerFixture({ routes: vercelRoutes(), bundle });
    const run = await f.start({ production: true, confirmProduction: true });
    await f.settle(run.runId);
    expect(f.controller.runLogs({ runId: run.runId }).text).toContain('excluded .env — local environment secrets');
  });

  it('fails loudly instead of publishing nothing', async () => {
    const empty = { files: [], fileCount: 0, totalBytes: 0, excluded: { secrets: [], ignored: 0, tooLarge: [] }, warnings: ['no uploadable files'] };
    const f = controllerFixture({ routes: vercelRoutes(), bundle: empty });
    const run = await f.start({ production: true, confirmProduction: true });
    const final = await f.settle(run.runId);
    expect(final.message).toMatch(/nothing to upload after the ignore and secret rules/i);
    expect(final.publicUrl).toBeNull();
    expect(f.transport.all('POST /v13/deployments')).toEqual([]);
  });

  it('explains an unreadable output folder and suggests the fix', async () => {
    const f = controllerFixture({ routes: vercelRoutes(), collectError: new Error('Access outside the workspace folder is not allowed.') });
    const run = await f.start({ production: true, confirmProduction: true });
    const final = await f.settle(run.runId);
    expect(final.message).toMatch(/Could not read "dist" to upload it/);
    expect(final.message).toContain('Run a build first');
  });
});

describe('honest status while the host is still working', () => {
  it('never shows a URL while the provider is still building', async () => {
    const f = controllerFixture({
      routes: vercelRoutes({ 'GET /v3/deployments/:id': () => ({ body: { readyState: 'BUILDING', url: 'demo-site.vercel.app' } }) }),
      maxPollMs: 3000,
    });
    const run = await f.start({ production: true, confirmProduction: true });
    const final = await f.settle(run.runId);
    expect(final.state).toBe('building');
    expect(final.publicUrl).toBeNull();
    expect(final.message).toMatch(/Stopped polling after 0 minutes/);
    expect(final.final).toBe(true);
  });

  it('surfaces the provider’s own reason for a failed deploy', async () => {
    const f = controllerFixture({
      routes: vercelRoutes({
        'GET /v3/deployments/:id': () => ({ body: { readyState: 'ERROR', builds: [{ error: { message: 'Command "npm run build" exited with code 1' } }] } }),
        'GET /v3/deployments/:id/events': () => ({ body: { events: [{ type: 'error', created: 1769644800000, data: { message: 'exited with code 1' } }] } }),
      }),
    });
    const run = await f.start({ production: true, confirmProduction: true });
    const final = await f.settle(run.runId);
    expect(final.state).toBe('error');
    expect(final.message).toContain('Command "npm run build" exited with code 1');
    expect(final.publicUrl).toBeNull();
    expect(f.controller.runLogs({ runId: run.runId }).text).toContain('exited with code 1');
  });

  it('reports a provider-side cancellation as cancelled, not as a success', async () => {
    const f = controllerFixture({
      routes: vercelRoutes({ 'GET /v3/deployments/:id': () => ({ body: { readyState: 'CANCELED' } }) }),
    });
    const run = await f.start({ production: true, confirmProduction: true });
    const final = await f.settle(run.runId);
    expect(final.state).toBe('canceled');
    expect(final.phase).toBe('canceled');
    expect(final.publicUrl).toBeNull();
    expect(final.message).toMatch(/Vercel reported this deployment as cancelled/);
  });

  it('says so when the host reports ready without ever giving a URL', async () => {
    const warnings = [];
    const f = controllerFixture({
      routes: vercelRoutes({ 'GET /v3/deployments/:id': () => ({ body: { readyState: 'READY' } }) }),
      warnSink: (message) => warnings.push(message),
    });
    const run = await f.start({ production: true, confirmProduction: true });
    const final = await f.settle(run.runId);
    expect(final.state).toBe('ready');
    expect(final.publicUrl).toBeNull();
    expect(final.message).toMatch(/reports the deployment as ready but returned no URL/);
    expect(warnings.join(' ')).toMatch(/ready without a url/);
  });

  it('shrugs off a transient status failure and keeps watching', async () => {
    let calls = 0;
    const f = controllerFixture({
      routes: vercelRoutes({
        'GET /v3/deployments/:id': () => {
          calls += 1;
          if (calls === 1) return { status: 503, body: { error: { message: 'maintenance' } } };
          return { body: { readyState: 'READY', url: 'demo-site.vercel.app' } };
        },
      }),
    });
    const run = await f.start({ production: true, confirmProduction: true });
    const final = await f.settle(run.runId);
    expect(final.state).toBe('ready');
    expect(final.publicUrl).toBe('https://demo-site.vercel.app');
    expect(f.controller.runLogs({ runId: run.runId }).text).toMatch(/status check failed \(1\/4\)/);
  });

  it('gives up after four consecutive status failures rather than spinning forever', async () => {
    const f = controllerFixture({
      routes: vercelRoutes({ 'GET /v3/deployments/:id': () => ({ status: 500, body: { error: { message: 'boom' } } }) }),
    });
    const run = await f.start({ production: true, confirmProduction: true });
    const final = await f.settle(run.runId);
    expect(final.state).toBe('error');
    expect(final.message).toMatch(/boom/);
    expect(f.transport.all('GET /v3/deployments/dpl_1')).toHaveLength(4);
  });

  it('checks the provider once more when the user asks for a refresh', async () => {
    let ready = false;
    const f = controllerFixture({
      routes: vercelRoutes({
        'GET /v3/deployments/:id': () => (ready
          ? { body: { readyState: 'READY', url: 'demo-site.vercel.app' } }
          : { body: { readyState: 'BUILDING' } }),
      }),
      maxPollMs: 2000,
    });
    const run = await f.start({ production: true, confirmProduction: true });
    expect((await f.settle(run.runId)).publicUrl).toBeNull();

    ready = true;
    const refreshed = await f.controller.refresh({ runId: run.runId });
    expect(refreshed).toMatchObject({ state: 'ready', publicUrl: 'https://demo-site.vercel.app', final: true });
    // …and the same truth is written to history, still one row.
    const rows = await f.controller.historyList({ root: ROOT });
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('ready');
  });

  it('refreshes without a deployment id by returning the run unchanged', async () => {
    const f = controllerFixture({ routes: vercelRoutes({ 'POST /v13/deployments': () => ({ status: 500, body: { error: { message: 'nope' } } }) }) });
    const run = await f.start({ production: true, confirmProduction: true });
    await f.settle(run.runId);
    const snapshot = await f.controller.refresh({ runId: run.runId });
    expect(snapshot.deploymentId).toBeNull();
  });
});

describe('cancelling', () => {
  it('stops uploading when the user cancels mid-transfer', async () => {
    const ref = {};
    let cancelCall = null;
    const f = controllerFixture({
      routes: vercelRoutes({
        'POST /v2/files': ({ call }) => {
          if (call === 1) {
            const [head] = ref.controller.listRuns();
            cancelCall = ref.controller.cancel({ runId: head.runId });
          }
          return { body: {} };
        },
      }),
    });
    ref.controller = f.controller;
    const run = await f.start({ production: true, confirmProduction: true });

    const final = await f.settle(run.runId);
    const result = await cancelCall;
    expect(result.providerCancelled).toBe(false);
    expect(result.run.state).toBe('canceled');
    expect(result.run.publicUrl).toBeNull();
    expect(f.transport.all('POST /v2/files')).toHaveLength(1);
    expect(f.transport.all('POST /v13/deployments')).toEqual([]);
    expect(result.message).toMatch(/No deployment was created, so nothing is published/);
    expect(final.state).toBe('canceled');
  });

  it('asks the provider to stop, and only claims success when it confirms', async () => {
    const ref = {};
    let cancelCall = null;
    const f = controllerFixture({
      routes: vercelRoutes({
        'GET /v3/deployments/:id': ({ call }) => {
          if (call === 1) {
            const [head] = ref.controller.listRuns();
            cancelCall = ref.controller.cancel({ runId: head.runId });
          }
          return { body: { readyState: 'BUILDING' } };
        },
      }),
    });
    ref.controller = f.controller;
    const run = await f.start({ production: true, confirmProduction: true });
    const final = await f.settle(run.runId);

    const result = await cancelCall;
    expect(f.transport.all('PATCH /v12/deployments/dpl_1/cancel')).toHaveLength(1);
    expect(result.providerCancelled).toBe(true);
    expect(result.run.state).toBe('canceled');
    expect(result.run.publicUrl).toBeNull();
    // Vercel answered the cancel request, so the message may say so.
    expect(result.run.message).toBe('Vercel confirmed the deployment was cancelled.');
    expect(final.state).toBe('canceled');
  });

  it('does not claim a Netlify deploy was cancelled on the provider side', async () => {
    const ref = {};
    let cancelCall = null;
    const f = controllerFixture({
      provider: 'netlify',
      routes: netlifyRoutes({
        'GET /api/v1/deploys/:id': ({ call }) => {
          if (call === 1) {
            const [head] = ref.controller.listRuns();
            cancelCall = ref.controller.cancel({ runId: head.runId });
          }
          return { body: { state: 'uploading' } };
        },
      }),
      bundle: bundleFixture({ 'index.html': '<h1>hi</h1>' }),
    });
    ref.controller = f.controller;
    const netlifyRun = await f.start({ production: true, confirmProduction: true });
    await f.settle(netlifyRun.runId);

    const result = await cancelCall;
    expect(result.providerCancelled).toBe(false);
    expect(result.run.state).toBe('canceled');
    expect(result.message).toMatch(/may still finish the deploy/);
  });

  it('refuses to cancel a run that is already over', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    const run = await f.start({ production: true, confirmProduction: true });
    await f.settle(run.runId);
    const result = await f.controller.cancel({ runId: run.runId });
    expect(result).toMatchObject({ ok: true, alreadyFinished: true, providerCancelled: false });
  });

  it('rejects a cancel for a run it never saw', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    await expect(f.controller.cancel({ runId: 'run-ghost' })).rejects.toThrow(/no longer known/);
  });
});

describe('watching a finished deploy', () => {
  it('keeps the ten most recent runs and lists the newest first', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    for (let i = 0; i < 12; i += 1) {
      const run = await f.start({ production: true, confirmProduction: true });
      await f.settle(run.runId);
    }
    const list = f.controller.listRuns();
    expect(list).toHaveLength(10);
    const times = list.map((r) => r.startedAt);
    expect([...times].sort().reverse()).toEqual(times);
    // Twelve complete pipelines in one test: the default 5s budget is not enough
    // once the suite is running every other file in parallel.
  }, 30000);

  it('streams the phases the panel needs and hides the credential', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    const run = await f.start({ production: true, confirmProduction: true });
    const final = await f.settle(run.runId);
    expect(f.events[0]).toMatchObject({ type: 'start', runId: run.runId, provider: 'vercel' });
    expect(f.events.some((e) => e.type === 'progress')).toBe(true);
    expect(f.events.filter((e) => e.type === 'state').at(-1)).toMatchObject({ state: 'ready', publicUrl: 'https://demo-site.vercel.app' });
    expect(f.events.filter((e) => e.type === 'phase').at(-1)).toMatchObject({ phase: 'deploying' });
    const everything = JSON.stringify([f.events, final, await f.controller.historyList({ root: ROOT })]);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('Bearer');
  });

  it('writes exactly one history row per deployment, updated as it goes', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    const run = await f.start({ production: true, confirmProduction: true });
    await f.settle(run.runId);
    const rows = await f.controller.historyList({ root: ROOT });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'vercel', state: 'ready', publicUrl: 'https://demo-site.vercel.app',
      deploymentId: 'dpl_1', projectName: 'demo-site', target: 'production', fileCount: 2,
    });
  });

  it('records a failed run in history with its reason', async () => {
    const f = controllerFixture({
      routes: vercelRoutes({ 'POST /v13/deployments': () => ({ status: 404, body: { error: { message: 'Project not found' } } }) }),
    });
    const run = await f.start({ production: true, confirmProduction: true });
    await f.settle(run.runId);
    const [row] = await f.controller.historyList({ root: ROOT });
    expect(row.state).toBe('error');
    expect(row.message).toMatch(/Project not found/);
    expect(row.publicUrl).toBeNull();
  });

  it('reads the real remote log from the provider', async () => {
    const f = controllerFixture({
      routes: vercelRoutes({
        'GET /v3/deployments/:id/events': () => ({
          body: { events: [{ type: 'build', created: 1769644800000, data: { message: 'Installing dependencies' } }] },
        }),
      }),
    });
    const logs = await f.controller.deployLogs({ provider: 'vercel', deploymentId: 'dpl_1' });
    expect(logs.deploymentId).toBe('dpl_1');
    expect(logs.text).toBe('00:00:00 [build] Installing dependencies');
  });

  it('refuses to invent a log source when there is nothing to read', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    await expect(f.controller.deployLogs({ provider: 'vercel' })).rejects.toThrow(/No deployment to read logs for yet/);
  });

  it('lists projects and domains through the provider, never from memory', async () => {
    const f = controllerFixture({
      routes: vercelRoutes({
        'GET /v9/projects/:project/domains': () => ({
          body: { domains: [{ name: 'example.com', verified: true, apexName: 'example.com' }, { name: 'beta.example.com', verified: false, misconfigured: true }] },
        }),
      }),
    });
    expect(await f.controller.listProjects({ provider: 'vercel' })).toEqual([{
      id: 'prj_1', name: 'demo-site', framework: 'vite', outputDir: null, productionUrl: null,
    }]);
    const domains = await f.controller.domains({ provider: 'vercel', project: 'demo-site' });
    expect(domains.domains).toEqual([
      { name: 'example.com', confirmed: true, https: true, apex: 'example.com', misconfigured: false },
      { name: 'beta.example.com', confirmed: false, https: false, apex: null, misconfigured: true },
    ]);
    expect(domains.instructions.join(' ')).toMatch(/only marks a domain active once Vercel reports it as verified/);
  });
});

describe('redeploy', () => {
  it('re-uses the reviewed settings but still demands its own confirmation', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    const run = await f.start({ production: true, confirmProduction: true, teamId: 'team_abc' });
    await f.settle(run.runId);

    const error = await f.controller.redeploy({ root: ROOT, provider: 'vercel' }, f.emit).catch((e) => e);
    expect(error.code).toBe('CONFIRMATION_REQUIRED');

    const again = await f.controller.redeploy({ root: ROOT, provider: 'vercel', confirmProduction: true, confirmBuild: true }, f.emit);
    const final = await f.settle(again.runId);
    expect(final.state).toBe('ready');
    // Same project, same team: nothing about the target changed silently.
    expect(f.transport.all('POST /v13/deployments')).toHaveLength(2);
    expect(f.transport.all('POST /v13/deployments')[1].query.teamId).toBe('team_abc');
    expect((await f.controller.historyList({ root: ROOT })).map((r) => r.state)).toEqual(['ready', 'ready']);
  });

  it('refuses when this folder has never been deployed', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    await expect(f.controller.redeploy({ root: '/projects/never-deployed', provider: 'vercel' }, f.emit))
      .rejects.toThrow(/No earlier deployment to redeploy/);
  });

  it('clears history only on an explicit confirmation', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    const run = await f.start({ production: true, confirmProduction: true });
    await f.settle(run.runId);

    const error = await f.controller.historyClear({ root: ROOT }).catch((e) => e);
    expect(error.code).toBe('CONFIRMATION_REQUIRED');
    expect(await f.controller.historyList({ root: ROOT })).toHaveLength(1);

    expect(await f.controller.historyClear({ root: ROOT, confirm: true })).toEqual({ ok: true, removed: 1 });
    expect(await f.controller.historyList({ root: ROOT })).toEqual([]);
  });
});

describe('deploy preferences', () => {
  it('remembers the provider and team the user chose', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    expect(await f.controller.getPreferences()).toEqual({ provider: '', teams: {} });
    await f.controller.setPreferences({ provider: 'vercel', teamId: 'team_abc' });
    expect(f.savedSettings[0]).toEqual({ deploy: { provider: 'vercel', teams: { vercel: 'team_abc' } } });
  });

  it('will not remember a provider that does not work yet', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    await f.controller.setPreferences({ provider: 'cloudflare' });
    expect(f.savedSettings[0].deploy.provider).toBe('');
  });

  it('drops a team that has no provider to belong to', async () => {
    const f = controllerFixture({ routes: vercelRoutes() });
    await f.controller.setPreferences({ teamId: 'team_abc' });
    expect(f.savedSettings[0].deploy.teams).toEqual({});
  });

  it('has no preferences without a settings service', async () => {
    const controller = createDeployController({
      deploy: { detect: async () => profileFixture(), build: async () => ({ code: 0 }) },
      secretStore: makeStore({}),
    });
    expect(await controller.getPreferences()).toEqual({ provider: '', teams: {} });
    expect(await controller.setPreferences({ provider: 'vercel' })).toEqual({ ok: false });
    expect(await controller.historyList({})).toEqual([]);
    expect(await controller.historyClear({ confirm: true })).toEqual({ ok: false, removed: 0 });
  });

  it('refuses to be built without the pieces it needs', () => {
    expect(() => createDeployController({ secretStore: makeStore({}) })).toThrow(/deploy service/);
    expect(() => createDeployController({ deploy: { detect: async () => ({}), build: async () => ({}) } })).toThrow(/secret store/);
  });
});

describe('the same pipeline through Netlify', () => {
  it('creates a site, sends the digest map, uploads only what is required and waits for ready', async () => {
    const f = controllerFixture({
      provider: 'netlify',
      routes: netlifyRoutes(),
      bundle: bundleFixture({ 'index.html': '<h1>hi</h1>', 'styles.css': 'body{}' }),
    });
    const run = await f.start({ production: true, confirmProduction: true });
    const final = await f.settle(run.runId);

    expect(final.state).toBe('ready');
    expect(final.publicUrl).toBe('https://demo-site.netlify.app');
    expect(final.deploymentId).toBe('dep_1');

    const digest = f.transport.find('POST /api/v1/sites/site_1/deploys');
    expect(digest.body.files).toEqual({ '/index.html': sha1('<h1>hi</h1>'), '/styles.css': sha1('body{}') });
    expect(digest.body.draft).toBe(false);
    // Netlify answered that it already has styles.css, so only one file travels.
    expect(f.transport.all('PUT /api/v1/deploys/dep_1/files/index.html')).toHaveLength(1);
    expect(f.transport.all('PUT /api/v1/deploys/dep_1/files/styles.css')).toEqual([]);
    expect(f.phases()).toEqual(['validating', 'packing', 'uploading', 'deploying']);
  });

  it('publishes a preview as a draft so the live site is untouched', async () => {
    const f = controllerFixture({ provider: 'netlify', routes: netlifyRoutes(), bundle: bundleFixture({ 'index.html': '<h1>hi</h1>' }) });
    const run = await f.start({ production: false });
    await f.settle(run.runId);
    expect(f.transport.find('POST /api/v1/sites/site_1/deploys').body.draft).toBe(true);
  });

  it('deploys into the team account the user selected', async () => {
    const f = controllerFixture({
      provider: 'netlify',
      routes: netlifyRoutes(),
      bundle: bundleFixture({ 'index.html': '<h1>hi</h1>' }),
    });
    const run = await f.start({ production: true, confirmProduction: true, teamId: 'acme' });
    await f.settle(run.runId);
    expect(f.transport.find('POST /api/v1/accounts/acme/sites')).toBeDefined();
    expect(f.transport.find('POST /api/v1/sites/site_1/deploys').body.draft).toBe(false);
  });

  it('sends env values to the account scope and logs only the names', async () => {
    const f = controllerFixture({
      provider: 'netlify',
      routes: netlifyRoutes(),
      bundle: bundleFixture({ 'index.html': '<h1>hi</h1>' }),
      missing: ['API_URL'],
    });
    const run = await f.start({
      production: true, confirmProduction: true, teamId: 'acme',
      envVars: [{ key: 'API_URL', value: 'secret-value' }],
    });
    await f.settle(run.runId);
    const post = f.transport.find('POST /api/v1/accounts/acme/env');
    expect(post.body).toEqual({ key: 'API_URL', values: [{ context: 'all', value: 'secret-value' }] });
    expect(f.controller.runLogs({ runId: run.runId }).text).toContain('API_URL');
    expect(f.controller.runLogs({ runId: run.runId }).text).not.toContain('secret-value');
  });
});

describe('build settings handed to the host', () => {
  it('tells Vercel the framework so its auto-detection cannot guess wrong', () => {
    expect(buildSettings(profileFixture({ framework: 'next' }), 'vercel')).toEqual({
      framework: 'next', buildCommand: 'npm run build', installCommand: null, outputDir: 'dist',
    });
  });

  it('does not claim a framework Netlify would ignore', () => {
    expect(buildSettings(profileFixture({ framework: 'next' }), 'netlify').framework).toBeNull();
  });

  it('asks the host to install dependencies when they are not there locally', () => {
    const settings = buildSettings(profileFixture({ nodeModulesInstalled: false, packageManager: 'pnpm' }), 'vercel');
    expect(settings.installCommand).toBe('pnpm install');
  });
});
