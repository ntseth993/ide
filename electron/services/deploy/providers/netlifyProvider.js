'use strict';
/**
 * Netlify adapter — real deployments through the Netlify REST API.
 *
 * Verified against Netlify's "Get started with the Netlify API" guide:
 *   POST /api/v1/sites                        create a site (optionally inside a team: POST /api/v1/{account_slug}/sites)
 *   POST /api/v1/sites/{site_id}/deploys      create a deploy from a { path: SHA1 } digest
 *   PUT  /api/v1/deploys/{deploy_id}/files/{path}   upload the files Netlify says are `required`
 *   GET  /api/v1/deploys/{deploy_id}          poll real state: preparing/prepared/uploading/uploaded/ready/error
 *   GET  /api/v1/sites                        the account's sites (also our token check)
 *   GET  /api/v1/sites/{site_id}/deploys      deploy history for a site
 *   POST /api/v1/sites/{site_id}/deploys/{deploy_id}/restore   roll a previous deploy back
 *   GET/POST /api/v1/accounts/{account_id}/env   environment variables (key-scoped, values write-only)
 *
 * File-digest deploys need no Git repository and no build on Netlify's side:
 * NovaCode uploads the already-built output, and Netlify de-dupes by SHA1 so a
 * redeploy only ships the files that actually changed.
 */
const { createProviderClient, ProviderApiError } = require('./httpClient');

const BASE_URL = 'https://api.netlify.com/api/v1';
const TOKEN_URL = 'https://app.netlify.com/user/applications#personal-access-tokens';
const STATE_MAP = { preparing: 'queued', prepared: 'queued', uploading: 'building', uploaded: 'building', error: 'error', ready: 'ready' };
const SITE_NAME_LIMIT = 63;

/** Netlify site names double as the *.netlify.app subdomain: keep them valid. */
function slugifySiteName(raw) {
  const cleaned = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SITE_NAME_LIMIT)
    .replace(/-+$/g, '');
  return cleaned || 'novacode-site';
}

function createNetlifyAdapter({ fetchImpl, logger = console, http = {} } = {}) {
  // Log bodies are served from short-lived presigned URLs, so they are fetched
  // without the account token — but always through the injected transport.
  const doFetch = fetchImpl || fetch;
  function client(token) {
    return createProviderClient({
      provider: 'netlify',
      baseUrl: BASE_URL,
      token,
      fetchImpl,
      logger,
      extraHeaders: { 'User-Agent': 'NovaCode IDE' },
      ...http,
      describeError: (payload, status) => {
        if (!payload) return null;
        const message = typeof payload === 'string' ? payload : (payload.message || payload.error);
        if (!message) return null;
        return {
          message: String(typeof message === 'object' ? (message.message || JSON.stringify(message)) : message),
          code: (payload.error && payload.error.code) || null,
          detail: status === 422 ? String(message).slice(0, 300) : null,
        };
      },
    });
  }

  /**
   * Create a site, retrying once with a random suffix when the subdomain is
   * already taken (Netlify answers 422 with a message mentioning the name).
   */
  async function createSite({ token, name, accountSlug }) {
    const http = client(token);
    const candidates = [name, `${name}-${Math.random().toString(36).slice(2, 7)}`];
    let lastError = null;
    for (const candidate of candidates) {
      try {
        // A new site is created with an empty digest: the deploy follows next.
        const res = await http.request(accountSlug ? `/accounts/${encodeURIComponent(accountSlug)}/sites` : '/sites', {
          method: 'POST',
          body: { name: candidate },
        });
        if (res.body && res.body.id) return res.body;
      } catch (error) {
        lastError = error;
        const taken = /already (been )?(taken|in use)|unique|exists/i.test(error.message || '');
        if (!taken) throw error;
      }
    }
    throw lastError || new ProviderApiError({ provider: 'netlify', message: 'Could not create a Netlify site.' });
  }

  return {
    id: 'netlify',
    label: 'Netlify',
    available: true,
    requiresGit: false,
    auth: {
      kind: 'token',
      tokenUrl: TOKEN_URL,
      instructions: [
        'In Netlify open User settings → Applications → Personal access tokens and create one named “NovaCode”.',
        'Paste it below. NovaCode stores it encrypted with your OS key store (DPAPI / Keychain / libsecret) and only sends it to api.netlify.com.',
        'To deploy into a team site, choose the team below — the token must have access to it.',
      ],
    },
    consoleUrl: (siteId) => `https://app.netlify.com/sites/${siteId || ''}`,

    async verify({ token }) {
      const http = client(token);
      // `/sites` is documented and answers 200 for any valid token, so it is
      // the authoritative "is this account connected?" probe. The identity
      // lookup is best-effort on top of that.
      const sitesRes = await http.request('/sites', { query: { per_page: 1 } });
      const sites = Array.isArray(sitesRes.body) ? sitesRes.body : [];
      let identity = {};
      try {
        const userRes = await http.request('/user');
        const u = userRes.body || {};
        identity = { id: u.id || null, handle: u.full_name || u.email || null, email: u.email || null };
      } catch {
        identity = { id: sites[0] && sites[0].user_id ? sites[0].user_id : null, handle: null, email: null };
      }
      let accounts = [];
      try {
        const accRes = await http.request('/accounts');
        accounts = (Array.isArray(accRes.body) ? accRes.body : []).map((a) => ({ id: a.id, name: a.name, slug: a.slug, type: a.type }));
      } catch {
        accounts = [];
      }
      return { ok: true, account: identity, teams: accounts, siteCount: sites.length };
    },

    async listProjects({ token }) {
      const http = client(token);
      const res = await http.request('/sites', { query: { per_page: 100 } });
      const sites = Array.isArray(res.body) ? res.body : [];
      return sites.map((s) => ({
        id: s.id,
        name: s.name || s.slug,
        url: s.ssl_url || s.url || null,
        customDomain: s.custom_domain || null,
      }));
    },

    async listEnvKeys({ token, accountSlug }) {
      if (!accountSlug) return [];
      const http = client(token);
      try {
        const res = await http.request(`/accounts/${encodeURIComponent(accountSlug)}/env`);
        const items = Array.isArray(res.body) ? res.body : (res.body && res.body.env ? res.body.env : []);
        return items.map((e) => e.key).filter(Boolean);
      } catch {
        return [];
      }
    },

    /**
     * Write env vars for the account/team scope Netlify actually reads them
     * from. Values are sent and forgotten — never stored, never logged.
     */
    async setEnvVars({ token, accountSlug, vars }) {
      if (!accountSlug || !Array.isArray(vars) || !vars.length) return { created: [] };
      const http = client(token);
      const created = [];
      for (const v of vars) {
        if (!v || typeof v.key !== 'string' || !/^[A-Z_][A-Z0-9_]*$/i.test(v.key)) continue;
        await http.request(`/accounts/${encodeURIComponent(accountSlug)}/env`, {
          method: 'POST',
          body: { key: v.key, values: [{ context: 'all' }].map((c) => ({ ...c, value: String(v.value ?? '') })) },
        });
        created.push(v.key);
      }
      return { created };
    },

    // `build` is accepted for adapter-contract symmetry and deliberately ignored:
    // Netlify only runs a build for a connected Git repository, so an API deploy
    // has to arrive pre-built (the controller refuses otherwise, per supports).
    async startDeploy({ token, bundle, build: _build, projectName, production, project: chosenSite, accountSlug, onProgress, shouldAbort }) {
      const http = client(token);
      let siteId = chosenSite || null;
      let siteName = chosenSite || slugifySiteName(projectName);
      if (!siteId) {
        const site = await createSite({ token, name: slugifySiteName(projectName), accountSlug });
        siteId = site.id;
        siteName = site.name || site.slug || siteName;
      }

      // 1 · Send the digest: { "/path": sha1 }. Netlify tells us what it lacks.
      const digest = {};
      for (const file of bundle.files) digest[`/${file.path.replace(/^\//, '')}`] = file.sha;

      const deployRes = await http.request(`/sites/${encodeURIComponent(siteId)}/deploys`, {
        method: 'POST',
        body: {
          files: digest,
          // A non-draft deploy becomes the site's published deploy; a draft
          // gets its own URL without touching the live site.
          draft: !production,
        },
      });
      const deploy = deployRes.body || {};
      if (!deploy.id) throw new ProviderApiError({ provider: 'netlify', status: deployRes.status, message: 'Netlify did not return a deploy id.' });

      // 2 · Upload only the SHAs Netlify reports as required.
      const required = new Set(Array.isArray(deploy.required) ? deploy.required : []);
      const bySha = new Map();
      for (const file of bundle.files) if (!bySha.has(file.sha)) bySha.set(file.sha, file);
      const toUpload = [...required].map((sha) => bySha.get(sha)).filter(Boolean);

      let uploaded = 0;
      let bytes = 0;
      for (const file of toUpload) {
        if (typeof shouldAbort === 'function' && shouldAbort()) throw abortError();
        const content = await file.read();
        // Paths must be escaped, and Netlify rejects '#'/'?' inside them.
        const path = `/${file.path.replace(/^\//, '')}`.replace(/[^0-9a-zA-Z\-._~/]/g, encodeURIComponent);
        await http.request(`/deploys/${encodeURIComponent(deploy.id)}/files${path}`, {
          method: 'PUT',
          rawBody: true,
          body: content,
          timeoutMs: 120000,
        });
        uploaded += 1;
        bytes += file.size;
        onProgress?.({ uploaded, total: toUpload.length, path: file.path, bytes });
      }
      for (const file of bundle.files) if (!required.has(file.sha)) { /* already stored by digest */ }

      return {
        provider: 'netlify',
        deploymentId: deploy.id,
        siteId,
        siteName,
        projectId: siteId,
        // Netlify gives drafts a `deploy_ssl_url`; the live URL only becomes
        // meaningful once state is `ready`, which status() reports.
        deploymentUrl: deploy.deploy_ssl_url || deploy.ssl_url || null,
        dashboardUrl: `https://app.netlify.com/sites/${siteName}/deploys/${deploy.id}`,
        state: mapState(deploy.state),
        stats: { uploaded, skipped: bundle.files.length - uploaded, bytes },
      };
    },

    async status({ token, deploymentId }) {
      const http = client(token);
      const res = await http.request(`/deploys/${encodeURIComponent(deploymentId)}`);
      const d = res.body || {};
      const state = mapState(d.state);
      return {
        state,
        publicUrl: state === 'ready' ? normalizeUrl(d.deploy_ssl_url || d.ssl_url || d.deploy_url || d.url) : null,
        siteUrl: state === 'ready' && !d.is_draft ? normalizeUrl(d.ssl_url || d.url) : null,
        deploymentUrl: normalizeUrl(d.deploy_ssl_url || d.deploy_url),
        url: d.admin_url || null,
        message: state === 'error' ? (d.error_message || d.title || 'Netlify reported this deploy as failed.') : null,
        raw: { netlifyState: d.state || null, isDraft: Boolean(d.is_draft), siteId: d.site_id || null },
      };
    },

    /**
     * Netlify has no "cancel a deploy" endpoint in the documented API. An
     * in-flight API deploy is driven by our own uploads, so stopping means
     * halting the upload loop and leaving the incomplete deploy unpublished
     * (a deploy only goes live once every required file is uploaded).
     */
    async cancel({ token, deploymentId }) {
      const http = client(token);
      try {
        // `cancel` is not part of the documented surface; attempting it costs
        // nothing and, if Netlify does not know it, we still report honestly.
        await http.request(`/deploys/${encodeURIComponent(deploymentId)}/cancel`, { method: 'POST' });
        return { ok: true, providerCancelled: true };
      } catch {
        return { ok: true, providerCancelled: false };
      }
    },

    async listDeploys({ token, project: siteId, limit = 20 }) {
      if (!siteId) return [];
      const http = client(token);
      const res = await http.request(`/sites/${encodeURIComponent(siteId)}/deploys`, { query: { per_page: limit } });
      const items = Array.isArray(res.body) ? res.body : [];
      return items.map((d) => ({
        provider: 'netlify',
        deploymentId: d.id,
        createdAt: d.created_at || null,
        state: mapState(d.state),
        publicUrl: normalizeUrl(d.deploy_ssl_url || d.deploy_url),
        target: d.state === 'ready' ? (d.is_draft ? 'draft' : 'production') : null,
      }));
    },

    async logs({ token, deploymentId }) {
      const http = client(token);
      const chunks = [];
      try {
        const res = await http.request(`/deploys/${encodeURIComponent(deploymentId)}/logs`);
        const body = res.body || {};
        for (const key of ['deployLog', 'buildLog']) {
          const url = body[key];
          if (!url) continue;
          try {
            const logRes = await doFetch(url, { headers: { Accept: 'text/plain' } }).then((r) => (r.ok ? r.text() : ''));
            if (logRes) chunks.push(`— ${key} —\n${logRes}`);
          } catch {
            chunks.push(`— ${key} —\n${url}`);
          }
        }
      } catch {
        /* fall through */
      }
      if (!chunks.length) {
        const deploy = await http.request(`/deploys/${encodeURIComponent(deploymentId)}`).catch(() => null);
        const d = deploy && deploy.body ? deploy.body : {};
        return d.error_message ? `Deploy failed: ${d.error_message}` : '(Netlify reported no build log for this deploy. API deploys are uploaded pre-built, so there is usually no remote build step.)';
      }
      return chunks.join('\n\n');
    },

    async domains({ token, project: siteId }) {
      if (!siteId) return { domains: [], instructions: ['Choose (or create) a Netlify site first.'] };
      const http = client(token);
      try {
        const res = await http.request(`/sites/${encodeURIComponent(siteId)}`);
        const site = res.body || {};
        return {
          domains: [
            { name: site.name || site.slug, confirmed: true, https: Boolean(site.ssl_url), apex: null },
            ...(site.custom_domain ? [{ name: site.custom_domain, confirmed: Boolean(site.domain_ssl_ready), https: Boolean(site.domain_ssl_ready) }] : []),
          ],
          instructions: [
            'In Netlify open Site configuration → Domains and add your domain.',
            'Point the DNS (A record for apex, CNAME for a subdomain) at Netlify’s values.',
            'NovaCode only marks a custom domain active once Netlify reports the domain as ready.',
          ],
        };
      } catch {
        return { domains: [], instructions: ['Add domains in the Netlify site settings, then re-check here.'] };
      }
    },
  };
}

function mapState(state) {
  return STATE_MAP[String(state || '').toLowerCase()] || 'queued';
}

function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function abortError() {
  const error = new Error('Deployment cancelled.');
  error.name = 'AbortError';
  return error;
}

module.exports = { createNetlifyAdapter, BASE_URL, slugifySiteName, mapState };
