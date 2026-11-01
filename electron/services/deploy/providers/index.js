'use strict';
/**
 * Hosting provider registry.
 *
 * Mirrors the shape of electron/services/ai/providers.js: one module that knows
 * every supported host, hands the renderer only trimmed descriptors, and keeps
 * the wire implementation behind a small, uniform adapter contract.
 *
 * Adapter contract (everything a controller needs, nothing more):
 *   verify({ token })                       -> { ok, account, teams }
 *   listProjects({ token })                 -> [{ id, name, url }]
 *   listEnvKeys({ token, ... })             -> ['NAME', ...]        (names only, always)
 *   setEnvVars({ token, vars, ... })        -> { created: [name] }
 *   startDeploy({ token, bundle, ... })     -> { deploymentId, dashboardUrl, state }
 *   status({ token, deploymentId })         -> { state, publicUrl }  (publicUrl null until live)
 *   cancel({ token, deploymentId })         -> { ok }
 *   listDeploys({ token, ... })             -> history rows
 *   logs({ token, deploymentId })           -> plain-text log
 *   domains({ token, project })             -> { domains, instructions }
 *
 * A planned provider is listed with `available: false` and a reason, so the UI
 * can be honest about it instead of shipping a button that does nothing.
 */
const { createNetlifyAdapter } = require('./netlifyProvider');
const { createVercelAdapter } = require('./vercelProvider');

/** Secret-store keys. One per provider; never named after the raw token. */
const TOKEN_SECRET = (providerId) => `hosting-${providerId}-token`;

const ADAPTER_FACTORIES = {
  vercel: createVercelAdapter,
  netlify: createNetlifyAdapter,
};

const silentLogger = { info() {}, warn() {}, error() {} };

const PROVIDERS = [
  {
    id: 'vercel', label: 'Vercel', available: true, requiresGit: false,
    consoleHome: 'https://vercel.com/dashboard',
    // `providerBuild` = the host can run install+build itself from uploaded
    // source (needed for Next.js / server-rendered apps). Vercel can, Netlify
    // only builds a repo it is connected to — an API deploy must be pre-built.
    supports: { static: true, next: true, providerBuild: true, nodeServerless: true, envVars: true, customDomain: true, logs: true, cancel: true },
  },
  {
    id: 'netlify', label: 'Netlify', available: true, requiresGit: false,
    consoleHome: 'https://app.netlify.com/user/sites',
    supports: { static: true, next: false, providerBuild: false, nodeServerless: false, envVars: true, customDomain: true, logs: true, cancel: false, rollback: true },
  },
  {
    id: 'cloudflare', label: 'Cloudflare Pages', available: false,
    reason: 'Adapter slot reserved. Cloudflare Pages deploys through a direct-upload endpoint that has not been implemented or verified yet.',
    consoleHome: 'https://dash.cloudflare.com',
    supports: {},
  },
  {
    id: 'render', label: 'Render', available: false,
    reason: 'Adapter slot reserved. Render deploys require a Git-connected or blueprint flow that NovaCode has not verified.',
    consoleHome: 'https://dashboard.render.com',
    supports: {},
  },
  {
    id: 'railway', label: 'Railway', available: false,
    reason: 'Adapter slot reserved. Railway’s deployment API has not been implemented or verified yet.',
    consoleHome: 'https://railway.app',
    supports: {},
  },
];

/** Descriptors for the renderer: no secrets, no implementation detail. */
function describeProviders() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    available: p.available,
    requiresGit: Boolean(p.requiresGit),
    reason: p.reason || null,
    consoleHome: p.consoleHome || null,
    supports: p.supports || {},
    tokenUrl: p.available ? tokenUrlFor(p.id) : null,
    instructions: p.available ? instructionsFor(p.id) : [],
  }));
}

function listAvailable() {
  return PROVIDERS.filter((p) => p.available).map((p) => ({ id: p.id, label: p.label }));
}

function getDescriptor(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

function tokenUrlFor(id) {
  return ADAPTER_FACTORIES[id] ? ADAPTER_FACTORIES[id]({ logger: silentLogger }).auth.tokenUrl : null;
}

function instructionsFor(id) {
  return ADAPTER_FACTORIES[id] ? ADAPTER_FACTORIES[id]({ logger: silentLogger }).auth.instructions : [];
}

/** Instantiate a real adapter. Unknown or unimplemented ids throw. */
function getAdapter(id, { fetchImpl, logger = console, http } = {}) {
  const factory = ADAPTER_FACTORIES[id];
  if (!factory) {
    const descriptor = getDescriptor(id);
    throw new Error(descriptor && !descriptor.available
      ? `${descriptor.label} is not wired up yet. ${descriptor.reason || ''}`.trim()
      : 'Unknown hosting provider.');
  }
  return factory({ fetchImpl, logger, http });
}

module.exports = {
  PROVIDERS,
  TOKEN_SECRET,
  describeProviders,
  listAvailable,
  getDescriptor,
  getAdapter,
};
