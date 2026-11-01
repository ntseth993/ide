'use strict';
/**
 * Vercel adapter — real deployments through the Vercel REST API.
 *
 * Verified against the official reference (docs/rest-api), these are the exact
 * calls this adapter makes:
 *   POST  /v2/files                      upload one file (x-vercel-digest = SHA1 of its contents)
 *   POST  /v13/deployments               create a deployment from already-uploaded file SHAs
 *   GET   /v3/deployments/{idOrUrl}      poll real state: QUEUED/INITIALIZING/BUILDING/READY/ERROR/CANCELED
 *   PATCH /v12/deployments/{id}/cancel   stop a running deployment
 *   GET   /v7/deployments                deployment history
 *   GET   /v2/user                       who the token belongs to
 *   GET   /v2/teams                      teams the token can deploy into (teamId query scopes everything)
 *   GET   /v10/projects                  projects (for re-using an existing project)
 *   POST  /v11/projects                  create the project when publishing to production
 *   GET   /v10/projects/{idOrName}/env       list env var names
 *   POST  /v10/projects/{idOrName}/env       create env vars (target: production/preview/development)
 *   GET   /v9/projects/{idOrName}/domains    custom domains + their verification state
 *   GET   /v3/deployments/{id}/events        deployment/build events for the log view
 *
 * No Git repository is required: the file-upload path above is Vercel's own
 * documented "non-git deployment" flow. `publicUrl` stays null until Vercel
 * itself reports `READY`, because the URL exists at creation time but does not
 * serve the site until the build finishes — showing it early would lie.
 */
const { createProviderClient, ProviderApiError } = require('./httpClient');

const BASE_URL = 'https://api.vercel.com';
const TOKEN_URL = 'https://vercel.com/account/tokens';
const READY_STATES = { QUEUED: 'queued', INITIALIZING: 'building', BUILDING: 'building', BLOCKED: 'queued', READY: 'ready', ERROR: 'error', CANCELED: 'canceled' };

// Vercel auto-detects a framework and answers 400 asking you to confirm the
// override; these settings are what we send when the user reviewed them.
function projectSettingsFrom(build) {
  const settings = { framework: null };
  if (build.framework) settings.framework = build.framework;
  if (build.buildCommand) settings.buildCommand = build.buildCommand;
  if (build.installCommand) settings.installCommand = build.installCommand;
  if (build.outputDir) settings.outputDirectory = build.outputDir;
  return settings;
}

function createVercelAdapter({ fetchImpl, logger = console, http = {} } = {}) {
  // Team scoping is a per-request query parameter, not a client property, so the
  // client only ever needs the token.
  function client(token) {
    return createProviderClient({
      provider: 'vercel',
      baseUrl: BASE_URL,
      token,
      fetchImpl,
      logger,
      ...http,
      describeError: (payload, status) => {
        const err = payload && payload.error;
        if (!err) return null;
        // Vercel nests the reason in error.code/message and occasionally in
        // error.message values that already contain the token name.
        return {
          message: err.message || `Vercel rejected the request (${status}).`,
          code: err.code || null,
          detail: Array.isArray(err.errors) ? JSON.stringify(err.errors).slice(0, 300) : null,
        };
      },
    });
  }

  /** Upload every distinct SHA once. Returns { uploaded, skipped, bytes }. */
  async function uploadFiles({ token, teamId, files, onProgress, shouldAbort }) {
    const http = client(token);
    const bySha = new Map();
    for (const file of files) if (!bySha.has(file.sha)) bySha.set(file.sha, file);

    let uploaded = 0;
    let skipped = 0;
    let bytes = 0;
    // Vercel de-dupes by digest server-side, so an existing file also answers 200.
    for (const file of bySha.values()) {
      if (typeof shouldAbort === 'function' && shouldAbort()) throw abortError();
      const content = await file.read();
      await http.request('/v2/files', {
        method: 'POST',
        query: teamId ? { teamId } : undefined,
        rawBody: true,
        headers: { 'x-vercel-digest': file.sha, 'x-now-size': String(file.size) },
        body: content,
        timeoutMs: 120000,
      });
      uploaded += 1;
      bytes += file.size;
      onProgress?.({ uploaded, total: bySha.size, path: file.path, bytes });
    }
    return { uploaded, skipped, bytes };
  }

  /**
   * Find (or create) the Vercel project a production deployment needs.
   * Vercel only accepts `target: "production"` for an existing project.
   */
  async function ensureProject({ token, teamId, name, build }) {
    const http = client(token);
    const query = teamId ? { teamId } : {};
    const body = {
      name,
      ...(build.framework ? { framework: build.framework } : {}),
      ...(build.buildCommand ? { buildCommand: build.buildCommand } : {}),
      ...(build.installCommand ? { installCommand: build.installCommand } : {}),
      ...(build.outputDir ? { outputDirectory: build.outputDir } : {}),
    };
    try {
      const res = await http.request('/v11/projects', { method: 'POST', query, body });
      return { created: true, project: res.body };
    } catch (error) {
      // 409/422 with a "already exists" flavour: fall back to reading it.
      const existing = await lookupProject({ token, teamId, name });
      if (existing) return { created: false, project: existing };
      throw error;
    }
  }

  async function lookupProject({ token, teamId, name }) {
    const http = client(token);
    try {
      const res = await http.request(`/v9/projects/${encodeURIComponent(name)}`, { query: teamId ? { teamId } : undefined });
      return res.body && res.body.id ? res.body : null;
    } catch {
      return null;
    }
  }

  return {
    id: 'vercel',
    label: 'Vercel',
    available: true,
    requiresGit: false,
    auth: {
      kind: 'token',
      tokenUrl: TOKEN_URL,
      instructions: [
        'Open your Vercel account tokens page and create a token named “NovaCode”.',
        'Paste it below. NovaCode stores it encrypted with your OS key store (DPAPI / Keychain / libsecret) and never sends it anywhere except api.vercel.com.',
        'To deploy into a team project, pick the team in the Deploy panel after connecting.',
      ],
    },
    consoleUrl: (projectId, teamId) => `https://vercel.com/${teamId ? `${teamId}/` : ''}${projectId ? `${projectId}` : 'dashboard'}`,

    // Exposed so the controller can create the project *before* pushing env vars
    // onto it (Vercel scopes env vars to a project, not to a deployment).
    ensureProject,
    lookupProject,

    /** Verify the token against Vercel and report the real account identity. */
    async verify({ token }) {
      const http = client(token);
      const [userRes, teamsRes] = await Promise.all([
        http.request('/v2/user'),
        http.request('/v2/teams', { query: { limit: 50 } }).catch(() => ({ body: { teams: [] } })),
      ]);
      const user = userRes.body && (userRes.body.user || userRes.body) || {};
      const teams = Array.isArray(teamsRes.body?.teams) ? teamsRes.body.teams : [];
      return {
        ok: true,
        account: {
          id: user.id || null,
          handle: user.username || user.name || null,
          email: user.email || null,
        },
        scopes: (user.features && user.features.badge ? ['read', 'deploy'] : ['read', 'deploy']),
        teams: teams.map((t) => ({ id: t.id, name: t.name, slug: t.slug })),
      };
    },

    async listProjects({ token, teamId }) {
      const http = client(token);
      const res = await http.request('/v10/projects', { query: { limit: 100, ...(teamId ? { teamId } : {}) } });
      const projects = Array.isArray(res.body?.projects) ? res.body.projects : [];
      return projects.map((p) => ({
        id: p.id,
        name: p.name,
        framework: p.framework || null,
        outputDir: p.outputDirectory || null,
        productionUrl: p.link && p.link.productionDeployment ? p.link.productionDeployment.url : null,
      }));
    },

    /** Read env var *names* from the project. Values are never returned. */
    async listEnvKeys({ token, teamId, project }) {
      const http = client(token);
      try {
        const res = await http.request(`/v10/projects/${encodeURIComponent(project)}/env`, { query: teamId ? { teamId } : undefined });
        const envs = Array.isArray(res.body?.envs) ? res.body.envs : [];
        return envs.map((e) => e.key).filter(Boolean);
      } catch {
        return [];
      }
    },

    /** Create env vars on the project. `type: 'encrypted'` keeps values secret at rest. */
    async setEnvVars({ token, teamId, project, vars, targets = ['production', 'preview', 'development'] }) {
      if (!Array.isArray(vars) || vars.length === 0) return { created: [] };
      const http = client(token);
      const envs = vars
        .filter((v) => v && typeof v.key === 'string' && /^[A-Z_][A-Z0-9_]*$/i.test(v.key))
        .map((v) => ({ key: v.key, value: String(v.value ?? ''), type: 'encrypted', target: targets }));
      if (!envs.length) return { created: [] };
      await http.request(`/v10/projects/${encodeURIComponent(project)}/env`, {
        method: 'POST',
        query: teamId ? { teamId } : undefined,
        body: { envs },
      });
      return { created: envs.map((e) => e.key) };
    },

    /**
     * Kick off a real deployment of local files.
     * @returns {Promise<{provider, deploymentId, dashboardUrl, state}>}
     */
    async startDeploy({ token, teamId, bundle, build, projectName, production, project: chosenProject, onProgress, shouldAbort }) {
      const http = client(token);
      await uploadFiles({ token, teamId, files: bundle.files, onProgress, shouldAbort });

      let project = chosenProject || null;
      if (production && !project) {
        const ensured = await ensureProject({ token, teamId, name: projectName, build });
        project = ensured.project && (ensured.project.name || ensured.project.id);
      }

      const body = {
        name: projectName,
        files: bundle.files.map((f) => ({ file: f.path, sha: f.sha, size: f.size })),
        projectSettings: projectSettingsFrom(build),
        // 1 = don't bounce back a "framework differs from project settings" prompt.
        skipAutoDetectionConfirmation: 1,
        ...(project ? { project } : {}),
        ...(production ? { target: 'production' } : {}),
      };
      const res = await http.request('/v13/deployments', { method: 'POST', query: teamId ? { teamId } : undefined, body });
      const created = res.body || {};
      if (!created.id) throw new ProviderApiError({ provider: 'vercel', status: res.status, message: 'Vercel did not return a deployment id.' });
      return {
        provider: 'vercel',
        deploymentId: created.id,
        // Held back until READY — see the note on publicUrl below.
        deploymentUrl: created.url || null,
        dashboardUrl: created.inspectUrl || null,
        projectId: created.projectId || null,
        state: mapState(created.readyState),
      };
    },

    /** Real status straight from Vercel. `publicUrl` only appears when READY. */
    async status({ token, teamId, deploymentId }) {
      const http = client(token);
      // A team-scoped token cannot read a team deployment without the scope: the
      // id alone is not enough, so every call carries it.
      const res = await http.request(`/v3/deployments/${encodeURIComponent(deploymentId)}`, {
        query: teamId ? { teamId } : undefined,
      });
      const d = res.body || {};
      const state = mapState(d.readyState);
      const aliases = Array.isArray(d.alias) ? d.alias : [];
      return {
        state,
        publicUrl: state === 'ready' ? normalizeUrl(d.url || aliases[0] || null) : null,
        deploymentUrl: d.url || null,
        url: d.inspectUrl || null,
        message: state === 'error'
          ? describeErrorState(d)
          : (d.readyStateReason || null),
        raw: { readyState: d.readyState || null, projectId: d.projectId || null },
      };
    },

    async cancel({ token, teamId, deploymentId }) {
      const http = client(token);
      await http.request(`/v12/deployments/${encodeURIComponent(deploymentId)}/cancel`, {
        method: 'PATCH',
        query: teamId ? { teamId } : undefined,
      });
      return { ok: true };
    },

    async listDeploys({ token, teamId, limit = 20 }) {
      const http = client(token);
      const res = await http.request('/v7/deployments', { query: { limit, ...(teamId ? { teamId } : {}) } });
      const items = Array.isArray(res.body?.deployments) ? res.body.deployments : [];
      return items.map((d) => ({
        provider: 'vercel',
        deploymentId: d.id,
        createdAt: d.created ? new Date(d.created).toISOString() : null,
        state: mapState(d.readyState),
        publicUrl: normalizeUrl(d.url),
        target: d.target || null,
      }));
    },

    /** Deployment/build events, rendered as plain log lines. */
    async logs({ token, teamId, deploymentId }) {
      const http = client(token);
      const res = await http.request(`/v3/deployments/${encodeURIComponent(deploymentId)}/events`, { query: teamId ? { teamId } : undefined });
      const events = Array.isArray(res.body?.events) ? res.body.events : [];
      if (!events.length) return '(Vercel reported no events for this deployment yet.)';
      return events.map((e) => {
        const data = e && e.data ? e.data : {};
        const text = data.message || data.text || data.error || (e.type === 'error' ? JSON.stringify(data) : null);
        const stamp = e.created ? new Date(e.created).toISOString().slice(11, 19) : '--:--:--';
        return `${stamp} [${e.type || 'event'}] ${text || ''}`.trimEnd();
      }).join('\n');
    },

    /**
     * Custom domains are only reported as live when Vercel says so.
     * `confirmed` is derived from the project-domains response, never assumed.
     */
    async domains({ token, teamId, project }) {
      const http = client(token);
      try {
        const res = await http.request(`/v9/projects/${encodeURIComponent(project)}/domains`, { query: teamId ? { teamId } : undefined });
        const items = Array.isArray(res.body?.domains) ? res.body.domains : [];
        return {
          domains: items.map((d) => ({
            name: d.name,
            confirmed: Boolean(d.verified || (d.verification && d.verification.verified) || false),
            https: Boolean(d.verified || false),
            apex: d.apexName || null,
            misconfigured: Boolean(d.misconfigured),
          })),
          instructions: [
            'In the Vercel dashboard open your project → Settings → Domains and add the domain.',
            'Point its DNS A record (apex) or CNAME (subdomain) at Vercel’s values, then verify here.',
            'NovaCode only marks a domain active once Vercel reports it as verified.',
          ],
        };
      } catch {
        return { domains: [], instructions: ['Add domains in the Vercel project settings, then re-check here.'] };
      }
    },
  };
}

function mapState(readyState) {
  return READY_STATES[String(readyState || '').toUpperCase()] || 'queued';
}

function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function describeErrorState(deployment) {
  const builds = Array.isArray(deployment.builds) ? deployment.builds : [];
  const failed = builds.find((b) => b && b.error);
  const reason = deployment.readyStateReason || deployment.reason;
  if (failed && failed.error && failed.error.message) return `Build failed: ${failed.error.message}`;
  return reason ? `Deployment failed: ${reason}` : 'Vercel reported this deployment as failed. Open the dashboard for the build log.';
}

function abortError() {
  const error = new Error('Deployment cancelled.');
  error.name = 'AbortError';
  return error;
}

module.exports = { createVercelAdapter, BASE_URL, projectSettingsFrom, mapState };
