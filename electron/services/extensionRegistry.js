/**
 * Remote extension registry (Open VSX).
 *
 * Gives the Extensions tab real marketplace discovery — the same open
 * registry used by VSCodium, Cursor and Theia — so searching fetches a large
 * catalog of extensions with publishers, versions and download counts.
 *
 * Security model is unchanged from the bundled catalog: NovaCode NEVER
 * downloads or executes extension CODE. "Install" here downloads a VSIX,
 * reads only its declarative manifest, and imports the subset NovaCode
 * understands (today: snippets). Anything else is recorded but inert. This
 * mirrors docs/EXTENSIONS.md and the v0.2 sandboxing stance.
 */
const { findEntryBuffer } = require('./vsix');
const { validateManifest } = require('./extensionService');

const REGISTRY_BASE = process.env.NOVACODE_EXTENSION_REGISTRY || 'https://open-vsx.org/api';
const ALLOWED_CATEGORIES = ['themes', 'snippets', 'language', 'formatters', 'tools'];

/** Force an arbitrary version string into the semver shape we validate. */
function safeSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || '').trim());
  if (match) return String(version).trim();
  const parts = String(version || '0').split('.');
  const nums = [0, 1, 2].map((i) => (/^\d+$/.test(parts[i] || '') ? parts[i] : '0'));
  return nums.join('.');
}

/** Build a "publisher.name" id that satisfies the manifest id pattern. */
function safeId(namespace, name) {
  const clean = (value) => String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/g, '') || 'x';
  return `${clean(namespace)}.${clean(name)}`;
}

function normalizeSearchResult(ext) {
  const namespace = ext.namespace || ext.publisher || 'unknown';
  const name = ext.name || 'extension';
  // Open VSX exposes file URLs either at the top level or nested under
  // latestVersion, depending on the API revision; icons are frequently only
  // present in one of them, so check both (png first, then svg).
  const files = { ...(ext.latestVersion?.files || {}), ...(ext.files || {}) };
  return {
    id: `${namespace}.${name}`,
    namespace,
    name,
    displayName: ext.displayName || name,
    publisher: namespace,
    version: ext.version || ext.latestVersion?.version || '0.0.0',
    description: ext.description || '',
    downloadCount: Number(ext.downloadCount || 0) || 0,
    categories: Array.isArray(ext.categories) ? ext.categories : [],
    tags: Array.isArray(ext.tags) ? ext.tags : [],
    iconUrl: files.icon || files.svgicon || null,
    downloadUrl: files.download || null,
  };
}

function buildCategories(pkg, detail) {
  const contributes = pkg.contributes || {};
  const haystack = [
    ...(detail.tags || []),
    ...(detail.categories || []),
    ...(pkg.categories || []),
  ].map((tag) => String(tag).toLowerCase());
  const has = (re) => haystack.some((tag) => re.test(tag));
  const categories = new Set();
  if (contributes.themes || has(/theme|color/)) categories.add('themes');
  if (contributes.snippets || has(/snippet/)) categories.add('snippets');
  if (contributes.languages || has(/language|syntax/)) categories.add('language');
  if (contributes.formatters || has(/format/)) categories.add('formatters');
  if (categories.size === 0) categories.add('tools');
  return [...categories].filter((category) => ALLOWED_CATEGORIES.includes(category));
}

/**
 * Import VS Code-style snippets (referenced JSON files inside the VSIX) into
 * NovaCode's `{ language: [{ prefix, body, description }] }` shape.
 */
function extractSnippets(pkg, vsixBuffer) {
  const list = Array.isArray(pkg.contributes?.snippets) ? pkg.contributes.snippets : [];
  const byLanguage = {};
  for (const entry of list) {
    if (!entry || !entry.language || !entry.path) continue;
    const zipPath = 'extension/' + String(entry.path).replace(/^\.?\//, '');
    let data;
    try {
      data = findEntryBuffer(vsixBuffer, zipPath);
    } catch {
      data = null;
    }
    if (!data) continue;
    let parsed;
    try {
      parsed = JSON.parse(data.toString('utf8'));
    } catch {
      continue;
    }
    const snippets = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || !value.prefix) continue;
      const prefix = Array.isArray(value.prefix) ? value.prefix[0] : value.prefix;
      const body = Array.isArray(value.body) ? value.body.join('\n') : String(value.body || '');
      if (!prefix || !body) continue;
      snippets.push({ prefix: String(prefix), body, description: value.description || key });
    }
    if (snippets.length) {
      byLanguage[entry.language] = (byLanguage[entry.language] || []).concat(snippets);
    }
  }
  return byLanguage;
}

/** Turn a VSIX package.json + registry detail into a NovaCode manifest. */
function buildManifest(pkg, detail, vsixBuffer) {
  const id = safeId(detail.namespace, detail.name);
  const snippets = extractSnippets(pkg, vsixBuffer);
  const contributes = {};
  if (Object.keys(snippets).length) contributes.snippets = snippets;
  const hasSnippets = Boolean(contributes.snippets);
  // Keep categories honest: only claim 'snippets' when we actually imported some.
  const categories = buildCategories(pkg, detail).filter(
    (category) => category !== 'snippets' || hasSnippets,
  );
  const description = String(pkg.description || detail.description || `${detail.namespace}.${detail.name} extension`)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280) || 'Marketplace extension (declarative subset only).';
  return {
    id,
    name: pkg.displayName || detail.displayName || detail.name || id,
    publisher: detail.namespace,
    version: safeSemver(detail.version || pkg.version),
    description,
    categories: categories.length ? categories : ['tools'],
    engines: { nova: '>=0.2.0' },
    permissions: [],
    contributes,
  };
}

function createExtensionRegistry({ extensions, logger = console, fetchImpl = globalThis.fetch } = {}) {
  async function fetchJson(url) {
    let response;
    try {
      response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    } catch {
      throw new Error('Could not reach the extension registry. Check your internet connection.');
    }
    if (!response.ok) throw new Error(`The extension registry responded with ${response.status}.`);
    return response.json();
  }

  async function search({ query = '', size = 24 } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('Extension search is unavailable in this environment.');
    const url = new URL(`${REGISTRY_BASE}/-/search`);
    const trimmed = String(query || '').trim().slice(0, 120);
    if (trimmed) url.searchParams.set('query', trimmed);
    url.searchParams.set('size', String(Math.min(Math.max(Number(size) || 24, 1), 50)));
    url.searchParams.set('sortBy', trimmed ? 'relevance' : 'downloadCount');
    url.searchParams.set('sortOrder', 'desc');
    url.searchParams.set('client', 'novacode');
    const data = await fetchJson(url.toString());
    const results = (data.extensions || []).map(normalizeSearchResult);
    return { results, total: Number(data.total || results.length) };
  }

  async function install({ namespace, name } = {}) {
    if (!namespace || !name) throw new Error('Choose a registry extension to install.');
    if (!extensions || typeof extensions.installRemote !== 'function') {
      throw new Error('The extension manager is unavailable.');
    }
    const detail = await fetchJson(`${REGISTRY_BASE}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);
    const downloadUrl = (detail.files && detail.files.download) || (detail.latestVersion?.files?.download);
    if (!downloadUrl) throw new Error('This extension has no downloadable package.');

    let response;
    try {
      response = await fetchImpl(downloadUrl);
    } catch {
      throw new Error('Could not download the extension package.');
    }
    if (!response.ok) throw new Error(`Download failed with ${response.status}.`);
    const vsixBuffer = Buffer.from(await response.arrayBuffer());

    const pkgBytes = findEntryBuffer(vsixBuffer, 'extension/package.json');
    if (!pkgBytes) throw new Error('The package has no readable extension manifest.');
    let pkg;
    try {
      pkg = JSON.parse(pkgBytes.toString('utf8'));
    } catch {
      throw new Error('The extension manifest inside the package is unreadable.');
    }

    const manifest = buildManifest(pkg, detail, vsixBuffer);
    validateManifest(manifest);
    const result = await extensions.installRemote(manifest);
    logger.info?.(`extension installed from registry: ${manifest.id}`);
    return result;
  }

  return { search, install, buildManifest, normalizeSearchResult, safeSemver, safeId };
}

module.exports = { createExtensionRegistry, REGISTRY_BASE };
