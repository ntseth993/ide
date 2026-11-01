'use strict';
/**
 * Deploy controller — the orchestrator behind the Deploy dashboard.
 *
 * Everything a deployment needs, in one honest pipeline:
 *
 *   validating → connecting → building → packing → uploading → deploying → live
 *                                                      ↘ failed / canceled
 *
 * It owns the safety rules the renderer is not allowed to relax on its own:
 *   - a production publish requires an explicit confirmation flag;
 *   - running the project's own build script requires explicit approval;
 *   - a deploy that would silently drop a backend requires acknowledgement;
 *   - production deploys stop on missing environment variables;
 *   - a public URL is only ever published from the provider's own status call.
 *
 * Provider credentials live in the encrypted secret store and are read here, in
 * the main process, immediately before an adapter call. They are never returned
 * to the renderer, never written to history, and never logged (the HTTP layer
 * scrubs them from error text too).
 */
const { PROVIDERS, TOKEN_SECRET, describeProviders, getDescriptor, getAdapter } = require('./providers');
const { collectBundle: defaultCollectBundle } = require('./sourceFiles');
const { detectEnvRequirements: defaultDetectEnv } = require('./envRequirements');

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_MS = 20 * 60 * 1000;
const MAX_POLL_FAILURES = 4;
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_LOG_CHARS = 200000;
const TOKEN_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Terminal states: once reached, polling stops and the run is finished. */
const DONE_STATES = new Set(['ready', 'error', 'canceled']);

class DeployConfirmationError extends Error {
  constructor(message, fields = []) {
    super(message);
    this.name = 'DeployConfirmationError';
    this.code = 'CONFIRMATION_REQUIRED';
    this.fields = fields;
  }
}

function shortId() {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function asString(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Only whitelisted, non-secret-shaped keys survive into a history row. */
function safeTeamId(value) {
  const clean = asString(value, 80);
  return /^[A-Za-z0-9_-]+$/.test(clean) ? clean : '';
}

function normalizeEnvVars(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    // The name is kept exactly as given: hosts treat env vars case-sensitively,
    // so rewriting the case would publish a variable the app never reads.
    const key = asString(item && item.key, 64);
    const value = typeof (item && item.value) === 'string' ? item.value : '';
    if (!key || !TOKEN_KEY.test(key)) continue;
    if (!value.trim() || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, value: value.slice(0, 8000) });
  }
  return out;
}

function lastLines(text, count = 40) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim());
  return lines.slice(-count).join('\n');
}

function createDeployController({
  deploy,
  secretStore,
  settings,
  history,
  logger = console,
  fetchImpl,
  adapterHttp,
  collectBundle = defaultCollectBundle,
  detectEnvRequirements = defaultDetectEnv,
  pollIntervalMs = POLL_INTERVAL_MS,
  maxPollMs = MAX_POLL_MS,
  buildTimeoutMs = BUILD_TIMEOUT_MS,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  if (!deploy || typeof deploy.detect !== 'function' || typeof deploy.build !== 'function') {
    throw new Error('Deploy controller requires the deploy service.');
  }
  if (!secretStore || typeof secretStore.getSecret !== 'function') {
    throw new Error('Deploy controller requires the secret store.');
  }

  const runs = new Map();
  // Verified identities, kept in memory only: tokens never live in the renderer,
  // and re-verifying on demand is cheap compared to storing state that can go
  // stale (a revoked token must not keep showing as "connected").
  const identities = new Map();

  async function tokenFor(provider) {
    const token = await secretStore.getSecret(TOKEN_SECRET(provider));
    if (!token) {
      const error = new Error(`${labelFor(provider)} is not connected. Add your access token first.`);
      error.code = 'NOT_CONNECTED';
      throw error;
    }
    return token;
  }

  function adapterFor(provider) {
    return getAdapter(provider, { fetchImpl, logger, http: adapterHttp });
  }

  function labelFor(provider) {
    const descriptor = getDescriptor(provider);
    return descriptor ? descriptor.label : String(provider || 'Provider');
  }

  function availableProviders() {
    return PROVIDERS.filter((p) => p.available).map((p) => p.id);
  }

  function assertProvider(provider) {
    const id = asString(provider, 32);
    const descriptor = getDescriptor(id);
    if (!descriptor) throw new Error('Unknown hosting provider.');
    if (!descriptor.available) throw new Error(`${descriptor.label} is not wired up yet. ${descriptor.reason || ''}`.trim());
    return descriptor;
  }

  // --- connection ------------------------------------------------------------

  /**
   * Ask the provider whether this account works *right now*.
   *
   * A stored token is only a string: it can be mistyped, revoked or scoped to
   * another team. Everything that decides whether a deploy may proceed goes
   * through here, so `ok` always means the provider itself answered 2xx.
   * Verified identities are cached in memory, so repeated dashboard refreshes do
   * not hammer the API — a rejected token clears the cache instead of ageing.
   *
   * @returns {Promise<{ ok: boolean, hasToken: boolean, reason: string|null,
   *   account: Object|null, teams: Array, error: string|null, verifiedAt: string|null }>}
   */
  async function checkAccount(providerId) {
    let token = null;
    try {
      token = await tokenFor(providerId);
    } catch (error) {
      // Nothing stored yet: the normal empty state of the panel, not a failure.
      if (error.code === 'NOT_CONNECTED') {
        return { ok: false, hasToken: false, reason: 'missing', account: null, teams: [], error: null, verifiedAt: null };
      }
      return { ok: false, hasToken: false, reason: 'error', account: null, teams: [], error: error.message, verifiedAt: null };
    }
    const cached = identities.get(providerId);
    if (cached) {
      return { ok: true, hasToken: true, reason: null, account: cached.account, teams: cached.teams, error: null, verifiedAt: cached.verifiedAt };
    }
    try {
      const identity = await verifyToken({ provider: providerId, token });
      return { ok: true, hasToken: true, reason: null, account: identity.account, teams: identity.teams, error: null, verifiedAt: identity.verifiedAt };
    } catch (error) {
      identities.delete(providerId);
      return {
        ok: false,
        hasToken: true,
        reason: 'rejected',
        account: null,
        teams: [],
        error: `${labelFor(providerId)} rejected the stored token: ${error.message}`,
        verifiedAt: null,
      };
    }
  }

  /** Per-provider connection state for the dashboard. Never includes secrets. */
  async function connections() {
    const descriptors = describeProviders();
    const out = [];
    for (const descriptor of descriptors) {
      const row = {
        ...descriptor,
        // `connected` is a claim about the provider, not about our own storage:
        // it is only true once the host has accepted this token in this session.
        connected: false,
        hasToken: false,
        storage: null,
        account: null,
        teams: [],
        verifiedAt: null,
        error: null,
      };
      if (descriptor.available) {
        try {
          row.storage = await secretStore.getSecretSource(TOKEN_SECRET(descriptor.id));
        } catch (error) {
          row.error = error.message;
        }
        if (row.storage) {
          const check = await checkAccount(descriptor.id);
          row.connected = check.ok;
          row.hasToken = check.hasToken;
          row.account = check.account;
          row.teams = check.teams;
          row.verifiedAt = check.verifiedAt;
          row.error = check.error;
        }
      }
      out.push(row);
    }
    return out;
  }

  async function verifyToken({ provider, token }) {
    const adapter = adapterFor(provider);
    const clean = asString(token, 400);
    if (!clean) throw new Error('An access token is required.');
    const result = await adapter.verify({ token: clean });
    const identity = {
      account: result.account || null,
      teams: Array.isArray(result.teams) ? result.teams : [],
      verifiedAt: new Date(now()).toISOString(),
    };
    identities.set(provider, identity);
    return { ...result, ...identity };
  }

  /** Connect: verify against the provider BEFORE storing, then store encrypted. */
  async function connect({ provider, token } = {}) {
    const descriptor = assertProvider(provider);
    let identity;
    try {
      identity = await verifyToken({ provider: descriptor.id, token });
    } catch (error) {
      // A failed connect must not leave a stale working identity behind.
      identities.delete(descriptor.id);
      throw error;
    }
    const stored = await secretStore.setSecret(TOKEN_SECRET(descriptor.id), asString(token, 400));
    logger.info?.('hosting account connected', { provider: descriptor.id, storage: stored.storage, account: identity.account && identity.account.handle });
    return {
      ok: true,
      provider: descriptor.id,
      storage: stored.storage,
      account: identity.account,
      teams: identity.teams,
      verifiedAt: identity.verifiedAt,
    };
  }

  async function disconnect({ provider } = {}) {
    const descriptor = assertProvider(provider);
    await secretStore.clearSecret(TOKEN_SECRET(descriptor.id));
    identities.delete(descriptor.id);
    logger.info?.('hosting account disconnected', { provider: descriptor.id });
    return { ok: true, provider: descriptor.id };
  }

  /** Which account/team deploys go to — the user picks, we never assume. */
  async function teams({ provider } = {}) {
    const descriptor = assertProvider(provider);
    const token = await tokenFor(descriptor.id);
    const identity = await verifyToken({ provider: descriptor.id, token });
    return { provider: descriptor.id, account: identity.account, teams: identity.teams };
  }

  async function listProjects({ provider, teamId } = {}) {
    const descriptor = assertProvider(provider);
    const token = await tokenFor(descriptor.id);
    const adapter = adapterFor(descriptor.id);
    const scope = scopeArgs(descriptor.id, teamId);
    return adapter.listProjects({ token, ...scope });
  }

  async function listDeploys({ provider, teamId, project } = {}) {
    const descriptor = assertProvider(provider);
    const token = await tokenFor(descriptor.id);
    const adapter = adapterFor(descriptor.id);
    const scope = scopeArgs(descriptor.id, teamId);
    return adapter.listDeploys({ token, project: asString(project, 120) || undefined, ...scope });
  }

  async function domains({ provider, teamId, project } = {}) {
    const descriptor = assertProvider(provider);
    const token = await tokenFor(descriptor.id);
    const adapter = adapterFor(descriptor.id);
    const scope = scopeArgs(descriptor.id, teamId);
    return adapter.domains({ token, project: asString(project, 120) || undefined, ...scope });
  }

  /** Remote build/deploy log, straight from the provider. */
  async function deployLogs({ provider, teamId, deploymentId, project } = {}) {
    const descriptor = assertProvider(provider);
    const token = await tokenFor(descriptor.id);
    const adapter = adapterFor(descriptor.id);
    const id = asString(deploymentId, 120) || lastDeploymentFor(descriptor.id);
    if (!id) throw new Error('No deployment to read logs for yet.');
    const scope = scopeArgs(descriptor.id, teamId);
    return {
      text: await adapter.logs({ token, deploymentId: id, project: asString(project, 120) || undefined, ...scope }),
      deploymentId: id,
      provider: descriptor.id,
    };
  }

  function lastDeploymentFor(provider) {
    for (const run of runs.values()) if (run.provider === provider && run.deploymentId) return run.deploymentId;
    return null;
  }

  function scopeArgs(providerId, teamId) {
    const clean = safeTeamId(teamId);
    if (!clean) return {};
    // Vercel scopes by team id; Netlify's account-scoped routes use the slug.
    return providerId === 'netlify' ? { accountSlug: clean } : { teamId: clean };
  }

  // --- planning --------------------------------------------------------------

  /**
   * The review screen's data: what we detected, what we are about to send, what
   * is missing, and which confirmations the user still has to give.
   */
  async function plan({ root, provider, teamId, project, rebuild } = {}) {
    const rootPath = asString(root, 1000);
    if (!rootPath) throw new Error('Open a folder first.');
    const descriptor = assertProvider(provider);
    const profile = await deploy.detect(rootPath);
    const adapter = adapterFor(descriptor.id);
    const scope = scopeArgs(descriptor.id, teamId);

    const chosenProject = asString(project, 120);
    const providerKeys = [];
    // The review screen must not claim an account works just because a token
    // happens to be stored, so ask the provider. `checkAccount` caches its
    // answer, so this is one request per session rather than one per refresh.
    const account = await checkAccount(descriptor.id);
    let envReadError = null;
    if (account.ok) {
      try {
        providerKeys.push(...await adapter.listEnvKeys({
          token: await tokenFor(descriptor.id),
          project: chosenProject || profile.projectName || undefined,
          ...scope,
        }));
      } catch (error) {
        envReadError = error.message;
      }
    }

    const env = await detectEnvRequirements({ root: rootPath, providerKeys, logger });

    const build = {
      buildCommand: profile.buildCommand,
      installCommand: profile.nodeModulesInstalled ? null : `${profile.packageManager} install`,
      outputDir: profile.outputDir,
      framework: frameworkForProvider(descriptor.id, profile),
      root: rootPath,
    };
    const useProviderBuild = profile.deployMode === 'provider-build';
    const needsLocalBuild = !useProviderBuild && (Boolean(rebuild) || !profile.outputExists);
    if (needsLocalBuild && !profile.scripts.build) {
      build.buildCommand = null;
    }

    const checks = [];
    const blockers = [...profile.blockers];
    checks.push({
      id: 'project',
      label: `${profile.kind === 'static' ? 'Static site' : (profile.framework || profile.kind || 'Project')} detected`,
      ok: profile.deployable,
      detail: profile.projectName ? `Project name: ${profile.projectName}` : 'No package.json name; the host will generate one.',
    });
    checks.push({
      id: 'account',
      label: `${descriptor.label} account`,
      ok: account.ok && !envReadError,
      detail: envReadError || (account.ok
        ? (providerKeys.length
          ? `${providerKeys.length} env var name(s) already on the host`
          : `Confirmed with ${account.account && account.account.handle ? account.account.handle : descriptor.label}`)
        // An unconnected panel is the normal starting state, so it is described
        // rather than reported as a failure.
        : (account.error || `Not connected. Add your ${descriptor.label} access token to deploy into your own account.`)),
    });
    checks.push({
      id: 'git',
      label: descriptor.requiresGit ? 'Git repository required' : 'No Git repository needed',
      ok: !descriptor.requiresGit,
      detail: descriptor.requiresGit ? descriptor.reason : `${descriptor.label} accepts a direct file upload, so a local folder is enough.`,
    });
    // A folder of plain files has no package manager to run, so saying NovaCode
    // will install something would be a promise it does not need to make.
    const nothingToInstall = !profile.hasPackageJson;
    checks.push({
      id: 'deps',
      label: nothingToInstall
        ? 'No dependencies to install'
        : (profile.nodeModulesInstalled ? 'Dependencies installed' : 'Dependencies not installed'),
      ok: true,
      detail: nothingToInstall
        ? 'There is no package.json, so these files are uploaded as they are.'
        : (profile.nodeModulesInstalled
          ? 'node_modules is present and is never uploaded.'
          : (useProviderBuild
            ? 'The host installs dependencies itself as part of its build.'
            : 'NovaCode will run the install command before building.')),
    });
    checks.push({
      id: 'target',
      label: useProviderBuild
        ? (descriptor.supports.providerBuild ? 'Host builds from your source' : 'Host must build, but cannot here')
        : 'Static build output will be uploaded',
      ok: !useProviderBuild || Boolean(descriptor.supports.providerBuild),
      detail: useProviderBuild && !descriptor.supports.providerBuild
        ? `${descriptor.label} only runs a build for a connected Git repository; an API upload has to be pre-built.`
        : (useProviderBuild ? `${profile.framework} needs a server runtime, so the source is sent and ${descriptor.label} builds it.` : `Uploading "${profile.outputDir}".`),
    });
    checks.push({
      id: 'env',
      label: env.missing.length ? `${env.missing.length} environment variable(s) not set` : 'Environment variables accounted for',
      ok: env.missing.length === 0,
      detail: env.missing.length ? `Missing (names only): ${env.missing.join(', ')}` : 'No unaccounted variable references found.',
    });

    if (useProviderBuild && !descriptor.supports.providerBuild) {
      blockers.push(altText(descriptor, profile));
    }
    // A token the host refuses is not a soft warning: every call after it would
    // fail, so say so on the review screen instead of letting the run start.
    if (account.reason === 'rejected') blockers.push(account.error);

    const needs = {
      confirmProduction: false,
      confirmBuild: needsLocalBuild && Boolean(build.buildCommand),
      acknowledgeFrontendOnly: Boolean(profile.frontendOnly),
      needsEnvValues: env.missing.length > 0,
    };

    logger.info?.('deploy plan built', {
      provider: descriptor.id, deployMode: profile.deployMode, framework: profile.framework,
      files: 'pending', missingEnv: env.missing.length, blockers: blockers.length,
    });

    return {
      root: rootPath,
      profile,
      provider: descriptor.id,
      providerLabel: descriptor.label,
      teamId: safeTeamId(teamId),
      project: chosenProject,
      build,
      env,
      checks,
      blockers,
      warnings: [...profile.warnings, ...env.warnings],
      needs,
      deployMode: profile.deployMode,
      supports: descriptor.supports,
    };
  }

  function altText(descriptor, profile) {
    if (profile.framework === 'next') {
      return `${descriptor.label} cannot build ${profile.framework} from an uploaded folder. Either deploy with Vercel, connect the Git repository in ${descriptor.label}, or switch the app to a static export (Next.js: output: 'export' in next.config.js) and redeploy.`;
    }
    return `${descriptor.label} cannot build ${profile.framework} from an uploaded folder. Choose Vercel for a host-side build, or connect a Git repository to ${descriptor.label} and enable its build.`;
  }

  function frameworkForProvider(providerId, profile) {
    if (!profile.framework) return null;
    if (providerId === 'vercel') return profile.framework;
    // Netlify knows these names; anything else it auto-detects from the upload.
    if (providerId === 'netlify') return ['hugo', 'jekyll', 'next', 'react', 'vue', 'svelte', 'astro'].includes(profile.framework) ? profile.framework : null;
    return null;
  }

  // --- running ---------------------------------------------------------------

  function snapshot(run) {
    return {
      runId: run.id,
      root: run.root,
      provider: run.provider,
      providerLabel: labelFor(run.provider),
      teamId: run.teamId,
      phase: run.phase,
      state: run.state,
      target: run.target,
      message: run.message,
      // Never reveal a URL the provider has not confirmed as live.
      publicUrl: run.publicUrl,
      deploymentId: run.deploymentId,
      dashboardUrl: run.dashboardUrl,
      projectId: run.projectId,
      fileCount: run.fileCount,
      totalBytes: run.totalBytes,
      upload: run.upload,
      // The renderer gets a bounded tail here; runLogs() returns the full text.
      log: run.log.slice(-120),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      canceled: run.canceled,
      final: run.final,
      error: run.error ? { message: run.error.message, code: run.error.code || null, status: run.error.status || null } : null,
    };
  }

  function status({ runId } = {}) {
    const run = runs.get(asString(runId, 40));
    if (!run) throw new Error('That deployment run is no longer known.');
    return snapshot(run);
  }

  function listRuns() {
    return [...runs.values()].sort((a, b) => b.startedMs - a.startedMs).slice(0, 10).map(snapshot);
  }

  function log(run, emit, line) {
    const text = String(line == null ? '' : line);
    if (!text) return;
    run.log.push(text);
    if (run.log.length > 800) run.log.splice(0, run.log.length - 800);
    emit({ type: 'log', runId: run.id, line: text.slice(0, 4000) });
  }

  function setPhase(run, emit, phase, message) {
    run.phase = phase;
    if (message) run.message = message;
    emit({ type: 'phase', runId: run.id, phase, message: run.message });
  }

  function setState(run, emit, state, extra = {}) {
    run.state = state;
    Object.assign(run, extra);
    emit({
      type: 'state',
      runId: run.id,
      phase: run.phase,
      state,
      message: run.message,
      publicUrl: run.publicUrl,
      deploymentId: run.deploymentId,
      dashboardUrl: run.dashboardUrl,
      progress: extra.upload,
    });
  }

  /**
   * Start a real deployment. Everything the pipeline needs is re-validated here
   * rather than trusted from the plan screen, because the folder may have
   * changed and the confirmations must be attached to the actual action.
   */
  async function start(payload = {}, emit = () => {}) {
    const rootPath = asString(payload.root, 1000);
    if (!rootPath) throw new Error('Open a folder first.');
    const descriptor = assertProvider(payload.provider);
    const production = payload.production !== false;
    const teamId = safeTeamId(payload.teamId);
    const project = asString(payload.project, 120);
    const envVars = normalizeEnvVars(payload.envVars);
    const rebuild = Boolean(payload.rebuild);

    const profile = await deploy.detect(rootPath);
    const adapter = adapterFor(descriptor.id);
    const useProviderBuild = profile.deployMode === 'provider-build';
    const needsLocalBuild = !useProviderBuild && (rebuild || !profile.outputExists);
    const buildCommand = asString(payload.buildCommand, 300) || profile.buildCommand;
    const outputDir = asString(payload.outputDir, 200) || profile.outputDir || '.';

    const blockers = [...profile.blockers];
    if (useProviderBuild && !descriptor.supports.providerBuild) blockers.push(altText(descriptor, profile));
    if (needsLocalBuild && !buildCommand) blockers.push('No build command is available and the output folder is missing. Add a build script or pick the folder to upload.');

    // ---- gates -------------------------------------------------------------
    const confirmations = [];
    if (production) confirmations.push('confirmProduction');
    if (needsLocalBuild && buildCommand) confirmations.push('confirmBuild');
    if (profile.frontendOnly) confirmations.push('acknowledgeFrontendOnly');
    const missingGate = confirmations.filter((name) => payload[name] !== true);
    if (blockers.length) {
      const error = new Error(blockers[0]);
      error.code = 'PROJECT_BLOCKED';
      error.blockers = blockers;
      throw error;
    }
    if (missingGate.length) {
      throw new DeployConfirmationError(
        production
          ? 'Confirm the production publish before NovaCode sends anything to the host.'
          : 'NovaCode needs your approval for this step.',
        missingGate,
      );
    }
    // Nothing has left the machine yet, so this is the last cheap moment to prove
    // the account really works. Deploying into the wrong or a dead account is the
    // one failure a confirmation screen cannot undo.
    const account = await checkAccount(descriptor.id);
    if (!account.ok) {
      const error = new Error(account.error
        || `${labelFor(descriptor.id)} is not connected. Add your access token first.`);
      error.code = account.reason === 'rejected' ? 'AUTH_FAILED' : 'NOT_CONNECTED';
      throw error;
    }
    const token = await tokenFor(descriptor.id);

    // Missing env vars are only fatal for a production publish: a preview/draft
    // deploy is a safe way to check that the app runs before it goes live.
    const envScan = await detectEnvRequirements({
      root: rootPath,
      providerKeys: await adapter.listEnvKeys({ token, project: project || profile.projectName || undefined, ...scopeArgs(descriptor.id, teamId) }).catch(() => []),
      logger,
    }).catch(() => ({ missing: [], required: [], warnings: [] }));
    const suppliedKeys = new Set(envVars.map((v) => v.key));
    const stillMissing = envScan.missing.filter((key) => !suppliedKeys.has(key));
    if (production && stillMissing.length) {
      const error = new Error(`Set these environment variables first (values are sent to ${descriptor.label} only, never stored by NovaCode): ${stillMissing.join(', ')}`);
      error.code = 'MISSING_ENV_VARS';
      error.fields = stillMissing;
      throw error;
    }

    const run = {
      id: shortId(),
      root: rootPath,
      provider: descriptor.id,
      teamId,
      project,
      phase: 'validating',
      state: 'queued',
      target: production ? 'production' : 'preview',
      message: 'Preparing deployment.',
      publicUrl: null,
      deploymentId: null,
      dashboardUrl: null,
      projectId: null,
      fileCount: 0,
      totalBytes: 0,
      upload: null,
      log: [],
      startedAt: new Date(now()).toISOString(),
      startedMs: now(),
      finishedAt: null,
      canceled: false,
      cancelNote: null,
      userCanceled: false,
      providerCancelConfirmed: false,
      final: false,
      error: null,
      entryId: null,
      emit,
      projectName: projectNameFor(profile),
    };
    runs.set(run.id, run);
    emit({ type: 'start', runId: run.id, provider: run.provider, phase: run.phase, state: run.state });
    run.promise = execute({ run, emit, token, adapter, descriptor, profile, production, teamId, project, envVars, needsLocalBuild, buildCommand, outputDir, useProviderBuild, rebuild })
      .catch((error) => finalize(run, emit, error))
      .then(() => persist(run));
    return snapshot(run);
  }

  function projectNameFor(profile) {
    const clean = asString(profile.projectName, 80).replace(/^@[^/]+\//, '');
    return clean || 'novacode-site';
  }

  async function persist(run) {
    if (!history) return;
    try {
      const row = await history.record({
        id: run.entryId || undefined,
        root: run.root,
        provider: run.provider,
        teamId: run.teamId || null,
        projectName: run.projectName,
        deploymentId: run.deploymentId,
        publicUrl: run.publicUrl,
        dashboardUrl: run.dashboardUrl,
        target: run.target,
        state: run.state,
        message: run.error ? run.error.message : run.message,
        framework: run.framework || null,
        deployMode: run.deployMode || null,
        fileCount: run.fileCount,
        totalBytes: run.totalBytes,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      });
      if (row) run.entryId = row.id;
    } catch (error) {
      logger.error('deploy history record failed', { error: error.message });
    }
  }

  function finalize(run, emit, error) {
    if (run.canceled || error && error.name === 'AbortError') {
      run.phase = 'canceled';
      run.state = 'canceled';
      // Composed here rather than in cancel(): until the run stops we do not know
      // how many files had already left, and "nothing was sent" has to be true.
      const sent = run.upload && run.upload.uploaded ? run.upload.uploaded : 0;
      run.message = run.cancelNote || (run.deploymentId
        ? (run.providerCancelConfirmed
          ? `${labelFor(run.provider)} confirmed the deployment was cancelled.`
          // The host did not accept (or have) a cancel request: say who has to act.
          : 'NovaCode stopped sending files. The host may still finish the deploy — stop it in the dashboard if it matters.')
        : (sent
          // Files can already be in the host's file store when the deploy itself
          // was never created, so "nothing was sent" would be wrong.
          ? `NovaCode stopped after uploading ${sent} file(s). No deployment was created, so nothing is published.`
          : 'Deployment cancelled. Nothing was sent to the host.'));
      run.finishedAt = new Date(now()).toISOString();
      run.final = true;
      run.publicUrl = null;
      setState(run, emit, 'canceled');
      return;
    }
    run.phase = 'failed';
    run.state = 'error';
    run.error = error;
    run.message = error && error.message ? error.message : 'Deployment failed.';
    run.finishedAt = new Date(now()).toISOString();
    run.final = true;
    // A failed run keeps publicUrl null on purpose: there is nothing to show.
    run.publicUrl = null;
    setState(run, emit, 'error');
    logger.error('deploy run failed', { runId: run.id, provider: run.provider, error: run.message, code: error && error.code });
  }

  /**
   * The pipeline itself. Any throw is turned into a failed run by `start`, so
   * this stays linear and readable instead of defensive at every step.
   */
  async function execute({ run, emit, token, adapter, descriptor, profile, production, teamId, project, envVars, needsLocalBuild, buildCommand, outputDir, useProviderBuild, rebuild }) {
    const scope = scopeArgs(descriptor.id, teamId);
    const shouldAbort = () => run.canceled;
    run.framework = profile.framework || profile.kind;
    run.deployMode = useProviderBuild ? 'provider-build' : 'prebuilt';
    await persist(run);

    // 1 · validate the folder one more time, with the real numbers.
    setPhase(run, emit, 'validating', `Checking the project for ${descriptor.label}.`);
    log(run, emit, `Project: ${profile.projectName || descriptor.label.toLowerCase() + '-site'} · framework: ${profile.framework || profile.kind} · manager: ${profile.packageManager}`);
    log(run, emit, `Publish mode: ${useProviderBuild ? `${descriptor.label} builds from your uploaded source` : `upload ${outputDir} as static files`}`);
    if (!profile.deployable) throw new Error(profile.blockers[0] || 'This project is not deployable as-is.');

    // 2 · env vars: push the ones the user just typed to the host.
    if (envVars.length) {
      setPhase(run, emit, 'configuring', `Sending ${envVars.length} environment variable(s) to ${descriptor.label}.`);
      let target = project;
      if (descriptor.id === 'vercel') {
        const ensured = await adapter.ensureProject({ token, teamId, name: project || run.projectName, build: buildSettings(profile, descriptor.id) });
        target = ensured.project && (ensured.project.name || ensured.project.id);
        run.projectId = target;
      }
      const result = await adapter.setEnvVars({ token, ...scope, project: target, vars: envVars });
      // Names only — a value can never reach the log even by accident.
      log(run, emit, `Environment variables set on ${descriptor.label}: ${(result.created || []).join(', ')}`);
      envVars.length = 0;
    }

    // 3 · build locally when the host is not going to build.
    if (needsLocalBuild) {
      if (shouldAbort()) throw abortError();
      setPhase(run, emit, 'building', `Running ${buildCommand}`);
      log(run, emit, `$ ${buildCommand}`);
      const install = !profile.nodeModulesInstalled && profile.hasPackageJson
        ? `${profile.packageManager} install`
        : null;
      if (install) {
        log(run, emit, `$ ${install}`);
        const installResult = await deploy.build(run.root, { command: install, timeoutMs: buildTimeoutMs });
        if (installResult && Number(installResult.code) !== 0) {
          log(run, emit, lastLines(installResult.output || installResult.error, 25));
          throw new Error(`Dependency install failed (${installResult.code}): ${describeCommandFailure(installResult)}`);
        }
      }
      const buildResult = await deploy.build(run.root, { command: buildCommand, timeoutMs: buildTimeoutMs });
      if (shouldAbort()) throw abortError();
      if (buildResult) {
        if (buildResult.output) log(run, emit, lastLines(buildResult.output, 60));
        if (Number(buildResult.code) !== 0) {
          throw new Error(`Build failed (${buildResult.code ?? buildResult.signal ?? 'unknown'}): ${describeCommandFailure(buildResult)}`);
        }
      }
      log(run, emit, 'Build finished.');
    } else if (rebuild) {
      log(run, emit, 'Reusing the existing build output.');
    }

    // 4 · collect exactly the bytes that are allowed to leave the machine.
    const packDir = useProviderBuild ? run.root : outputDir;
    if (!useProviderBuild && !profile.outputExists && !needsLocalBuild) {
      throw new Error(`Build output folder "${outputDir}" does not exist. Run a build first.`);
    }
    setPhase(run, emit, 'packing', `Preparing ${useProviderBuild ? 'source files' : 'build output'} for upload.`);
    let bundle;
    try {
      bundle = await collectBundle({ root: run.root, dir: packDir, logger });
    } catch (error) {
      throw new Error(`Could not read "${packDir}" to upload it: ${error.message}${needsLocalBuild ? '' : ' Run a build first, or pick a different folder.'}`);
    }
    run.fileCount = bundle.fileCount;
    run.totalBytes = bundle.totalBytes;
    if (!bundle.fileCount) throw new Error('There is nothing to upload after the ignore and secret rules were applied.');
    log(run, emit, `${bundle.fileCount} file(s), ${formatBytes(bundle.totalBytes)} ready to send.`);
    for (const secret of bundle.excluded.secrets.slice(0, 12)) {
      log(run, emit, `excluded ${secret.path} — ${secret.reason}`);
    }
    if (bundle.excluded.secrets.length > 12) log(run, emit, `…and ${bundle.excluded.secrets.length - 12} more excluded for the same reasons.`);
    for (const warning of bundle.warnings) log(run, emit, `warning: ${warning}`);
    await persist(run);

    // 5 · upload + create the deployment.
    setPhase(run, emit, 'uploading', `Uploading to ${descriptor.label}.`);
    let lastProgress = 0;
    const result = await adapter.startDeploy({
      token,
      ...scope,
      bundle,
      build: buildSettings(profile, descriptor.id),
      projectName: project || run.projectName,
      project: project || undefined,
      production,
      shouldAbort,
      onProgress: ({ uploaded, total, bytes }) => {
        run.upload = { uploaded, total, bytes };
        // Throttle: the first few, every tenth, big jumps, and always the last.
        const worth = uploaded === total || uploaded <= 3 || uploaded % 10 === 0 || uploaded - lastProgress >= 50;
        if (!worth) return;
        lastProgress = uploaded;
        emit({ type: 'progress', runId: run.id, phase: 'uploading', uploaded, total, bytes });
      },
    });
    run.deploymentId = result.deploymentId;
    run.dashboardUrl = result.dashboardUrl || null;
    run.projectId = result.projectId || run.projectId || null;
    run.upload = { uploaded: result.stats ? result.stats.uploaded : bundle.fileCount, total: bundle.fileCount, bytes: result.stats ? result.stats.bytes : bundle.totalBytes };
    setState(run, emit, result.state || 'queued');
    log(run, emit, `${descriptor.label} accepted the deploy (id ${result.deploymentId}).`);
    await persist(run);

    // 6 · poll the provider for the real state. Never invent a URL.
    setPhase(run, emit, 'deploying', `${descriptor.label} is ${production ? 'publishing' : 'preparing'} the deployment.`);
    const final = await poll({ run, emit, adapter, token, scope, deploymentId: result.deploymentId });
    if (final.state === 'ready') {
      run.phase = 'live';
      run.state = 'ready';
      run.publicUrl = final.publicUrl || null;
      run.message = run.publicUrl
        ? `Live at ${run.publicUrl}`
        : `${descriptor.label} reports the deployment as ready but returned no URL.`;
      run.finishedAt = new Date(now()).toISOString();
      run.final = true;
      if (!run.publicUrl) logger.warn('provider reported ready without a url', { runId: run.id });
      setState(run, emit, 'ready');
      log(run, emit, run.message);
      return;
    }
    if (final.state === 'canceled') {
      run.canceled = true;
      // Only say the host cancelled it when the host really said so: poll() also
      // returns `canceled` when the user pressed the button, and blaming the
      // provider for our own action would be a lie.
      if (!final.byUser && !run.cancelNote) {
        run.cancelNote = final.message || `${descriptor.label} reported this deployment as cancelled.`;
      }
      finalize(run, emit, Object.assign(new Error(run.cancelNote || 'Deployment cancelled.'), { name: 'AbortError' }));
      return;
    }
    if (final.state === 'error') {
      const detail = final.message || 'the host did not give a reason';
      try {
        const remote = await adapter.logs({ token, deploymentId: result.deploymentId, ...scope });
        if (remote) log(run, emit, lastLines(remote, 40));
      } catch { /* the failure is already known; logs are a bonus */ }
      throw new Error(`${descriptor.label} deployment failed: ${detail}`);
    }
    // Timed out watching, or the user cancelled while polling.
    if (run.canceled) {
      finalize(run, emit, Object.assign(new Error('Deployment cancelled.'), { name: 'AbortError' }));
      return;
    }
    run.message = final.message || `${descriptor.label} is still working on this deployment. Keep the panel open or open the dashboard to watch it.`;
    setState(run, emit, final.state || 'building');
    log(run, emit, run.message);
    run.final = true;
    run.finishedAt = new Date(now()).toISOString();
  }

  async function poll({ run, emit, adapter, token, scope, deploymentId }) {
    const deadline = now() + maxPollMs;
    let failures = 0;
    let lastState = null;
    while (now() < deadline) {
      if (run.canceled) {
        // cancel() is the only thing that sets this flag, and it already asked
        // the provider to stop — here we just stop watching. Mark it as ours so
        // the caller does not report this as a provider-side cancellation.
        return { state: 'canceled', byUser: true };
      }
      let fresh;
      try {
        fresh = await adapter.status({ token, deploymentId, ...scope });
        failures = 0;
      } catch (error) {
        failures += 1;
        log(run, emit, `status check failed (${failures}/${MAX_POLL_FAILURES}): ${error.message}`);
        if (failures >= MAX_POLL_FAILURES) throw error;
        await wait(pollIntervalMs);
        continue;
      }
      if (fresh.state !== lastState) {
        lastState = fresh.state;
        setState(run, emit, fresh.state, { upload: run.upload });
        log(run, emit, `${labelFor(run.provider)} state: ${fresh.state}${fresh.message ? ` — ${fresh.message}` : ''}`);
      }
      if (DONE_STATES.has(fresh.state)) return fresh;
      await wait(pollIntervalMs);
    }
    return { state: lastState || 'building', message: `Stopped polling after ${Math.round(maxPollMs / 60000)} minutes; ${labelFor(run.provider)} had not finished.` };
  }

  /** One extra real status check for a run whose poll window ended. */
  async function refresh({ runId } = {}) {
    const run = runs.get(asString(runId, 40));
    if (!run) throw new Error('That deployment run is no longer known.');
    if (!run.deploymentId) return snapshot(run);
    const token = await tokenFor(run.provider);
    const adapter = adapterFor(run.provider);
    const fresh = await adapter.status({ token, deploymentId: run.deploymentId, ...scopeArgs(run.provider, run.teamId) });
    run.state = fresh.state;
    run.final = DONE_STATES.has(fresh.state);
    if (fresh.state === 'ready') run.publicUrl = fresh.publicUrl || run.publicUrl;
    else run.publicUrl = null;
    run.message = fresh.message || run.message;
    if (fresh.state === 'ready') run.finishedAt = run.finishedAt || new Date(now()).toISOString();
    setState(run, run.emit || (() => {}), fresh.state);
    await persist(run);
    return snapshot(run);
  }

  /**
   * Cancel: stop our own upload loop, and ask the provider to stop when it
   * supports that. If the provider cannot confirm, say so instead of implying
   * the deploy was torn down.
   */
  async function cancel({ runId } = {}) {
    const run = runs.get(asString(runId, 40));
    if (!run) throw new Error('That deployment run is no longer known.');
    if (run.final) return { ok: true, alreadyFinished: true, providerCancelled: false, run: snapshot(run) };
    run.canceled = true;
    run.userCanceled = true;
    let providerCancelled = false;
    if (run.deploymentId) {
      try {
        const token = await tokenFor(run.provider);
        const adapter = adapterFor(run.provider);
        const result = await adapter.cancel({ token, deploymentId: run.deploymentId, ...scopeArgs(run.provider, run.teamId) });
        providerCancelled = result.providerCancelled !== false;
      } catch (error) {
        logger.warn('provider cancel refused', { runId: run.id, error: error.message });
      }
      run.providerCancelConfirmed = providerCancelled;
    }
    // The message is composed by finalize() once the run has actually stopped, so
    // it can state real numbers instead of a guess made mid-upload.
    await run.promise;
    return { ok: true, providerCancelled, message: run.message, run: snapshot(run) };
  }

  function runLogs({ runId } = {}) {
    const run = runs.get(asString(runId, 40));
    if (!run) throw new Error('That deployment run is no longer known.');
    return { text: run.log.join('\n').slice(-MAX_LOG_CHARS), state: run.state, phase: run.phase };
  }

  async function historyList({ root } = {}) {
    if (!history) return [];
    return history.list({ root: asString(root, 1000) || undefined });
  }

  /** Deleting history is destructive, so the UI has to pass it explicitly. */
  async function historyClear({ root, confirm } = {}) {
    if (!history) return { ok: false, removed: 0 };
    if (confirm !== true) throw new DeployConfirmationError('Confirm that you want to delete this deployment history.', ['confirm']);
    return history.clear({ root: asString(root, 1000) || undefined });
  }

  /** Redeploy = re-run the same reviewed settings; cheap because both hosts de-dupe by digest. */
  async function redeploy(payload = {}, emit = () => {}) {
    const rootPath = asString(payload.root, 1000);
    const list = history ? await history.list({ root: rootPath }) : [];
    const previous = list.find((row) => row.provider === asString(payload.provider, 32)) || list[0];
    if (!previous) throw new Error('No earlier deployment to redeploy for this folder.');
    return start({
      root: rootPath,
      provider: previous.provider,
      teamId: previous.teamId || undefined,
      project: payload.project || undefined,
      production: payload.production !== false,
      buildCommand: payload.buildCommand,
      outputDir: payload.outputDir,
      rebuild: payload.rebuild !== false,
      confirmProduction: payload.confirmProduction === true,
      confirmBuild: payload.confirmBuild === true,
      acknowledgeFrontendOnly: payload.acknowledgeFrontendOnly === true,
      envVars: normalizeEnvVars(payload.envVars),
    }, emit);
  }

  /** Default provider + team, remembered per the user's own choice. */
  async function getPreferences() {
    if (!settings) return { provider: '', teams: {} };
    const loaded = await settings.load();
    return { provider: (loaded.deploy && loaded.deploy.provider) || '', teams: (loaded.deploy && loaded.deploy.teams) || {} };
  }

  async function setPreferences({ provider, teamId } = {}) {
    if (!settings) return { ok: false };
    const id = asString(provider, 32);
    const current = await settings.load();
    const teams = { ...((current.deploy && current.deploy.teams) || {}) };
    const cleanTeam = safeTeamId(teamId);
    if (id) teams[id] = cleanTeam;
    else if (cleanTeam) { /* a team without a provider is meaningless */ }
    await settings.save({ deploy: { provider: availableProviders().includes(id) ? id : '', teams } });
    return { ok: true, provider: id, teamId: cleanTeam };
  }

  return {
    providers: describeProviders,
    connections,
    connect,
    disconnect,
    teams,
    listProjects,
    listDeploys,
    deployLogs,
    domains,
    plan,
    start,
    status,
    listRuns,
    refresh,
    cancel,
    runLogs,
    redeploy,
    historyList,
    historyClear,
    getPreferences,
    setPreferences,
    DeployConfirmationError,
  };
}

function buildSettings(profile, providerId) {
  return {
    framework: providerId === 'vercel' ? (profile.framework || null) : null,
    buildCommand: profile.buildCommand,
    installCommand: profile.nodeModulesInstalled ? null : `${profile.packageManager} install`,
    outputDir: profile.outputDir,
  };
}

function describeCommandFailure(result) {
  const output = String((result && result.output) || (result && result.error) || '');
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const interesting = [...lines].reverse().find((line) => /error|ERR!|failed|cannot|not found|ENOENT|exited/i.test(line));
  return (interesting || lines.slice(-1)[0] || 'no output was captured').slice(0, 300);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1048576).toFixed(1)} MB`;
}

function abortError() {
  const error = new Error('Deployment cancelled.');
  error.name = 'AbortError';
  return error;
}

module.exports = { createDeployController, DeployConfirmationError, buildSettings, normalizeEnvVars, formatBytes };
