/**
 * Extension manager service.
 *
 * Manages declarative extensions from the bundled catalog: install,
 * enable/disable, update, uninstall, and listing. State persists in
 * <userData>/extensions/installed.json.
 *
 * Security model (v0.2): extensions are DATA, not code. Only catalog
 * manifests validated here are ever applied by the renderer (theme CSS
 * variables, editor snippets, formatter flags). No extension code is
 * downloaded or executed, so untrusted extensions cannot run - see
 * docs/EXTENSIONS.md for the manifest format and the roadmap for a
 * sandboxed code-execution story.
 */

const fs = require('fs');
const path = require('path');
const { CATALOG } = require('./extensionCatalog');

const ALLOWED_CATEGORIES = ['themes', 'snippets', 'language', 'formatters', 'tools'];
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/i;

/** Compare dotted versions: returns -1, 0, or 1. */
function compareVersions(a, b) {
  const pa = String(a).split(/[-+]/)[0].split('.');
  const pb = String(b).split(/[-+]/)[0].split('.');
  for (let i = 0; i < 3; i += 1) {
    const na = Number.parseInt(pa[i] || '0', 10);
    const nb = Number.parseInt(pb[i] || '0', 10);
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

/** Minimal `>=x.y.z` engine range check for the `nova` engine field. */
function satisfiesEngine(range, version) {
  const match = /^>=\s*(\d+\.\d+\.\d+)$/.exec(String(range || '').trim());
  if (!match) return false; // Unsupported ranges are treated as incompatible.
  return compareVersions(version, match[1]) >= 0;
}

/** Validate a manifest; throws with a precise message when invalid. */
function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('Extension manifest must be an object.');
  for (const field of ['id', 'name', 'version', 'publisher', 'description']) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim()) {
      throw new Error(`Extension manifest field "${field}" is required.`);
    }
  }
  if (!ID_PATTERN.test(manifest.id)) {
    throw new Error('Extension id must look like "publisher.name".');
  }
  if (!VERSION_PATTERN.test(manifest.version)) {
    throw new Error(`Extension version "${manifest.version}" must be semver (x.y.z).`);
  }
  if (!Array.isArray(manifest.categories) || manifest.categories.length === 0) {
    throw new Error('Extension manifest must declare at least one category.');
  }
  for (const category of manifest.categories) {
    if (!ALLOWED_CATEGORIES.includes(category)) {
      throw new Error(`Unknown extension category "${category}".`);
    }
  }
  if (manifest.engines?.nova && !/^>=\s*\d+\.\d+\.\d+$/.test(String(manifest.engines.nova))) {
    // Compatibility against the running version is checked at install time;
    // here we only require a parseable ">=x.y.z" range.
    throw new Error('engines.nova must be a ">=x.y.z" range.');
  }
  if (manifest.contributes && typeof manifest.contributes !== 'object') {
    throw new Error('Extension "contributes" must be an object.');
  }
  return manifest;
}

/**
 * @param {object} deps
 * @param {string} deps.userDataDir directory that holds extensions state
 * @param {string} deps.appVersion running NovaCode version (x.y.z)
 * @param {object} [deps.logger]
 * @param {object} [deps.fs] injectable fs for tests
 */
function createExtensionService({ userDataDir, appVersion, logger = console, fs: nodeFs = fs }) {
  const statePath = path.join(userDataDir, 'installed.json');

  function readState() {
    try {
      const raw = nodeFs.readFileSync(statePath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return []; // Missing or corrupt state starts fresh.
    }
  }

  function writeState(records) {
    nodeFs.mkdirSync(path.dirname(statePath), { recursive: true });
    nodeFs.writeFileSync(statePath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  }

  function findCatalogEntry(id) {
    return CATALOG.find((entry) => entry.manifest.id === id) || null;
  }

  async function list() {
    const installed = readState().map((record) => {
      const entry = findCatalogEntry(record.manifest.id);
      const updateAvailable = entry
        ? compareVersions(entry.manifest.version, record.manifest.version) > 0
        : false;
      return { ...record, updateAvailable };
    });
    const installedIds = new Set(installed.map((record) => record.manifest.id));
    return {
      installed,
      available: CATALOG.filter((entry) => !installedIds.has(entry.manifest.id)).map((entry) => ({
        manifest: entry.manifest,
        recommended: entry.recommended,
        popular: entry.popular,
      })),
      exampleCatalog: true,
    };
  }

  // Install a manifest that came from the remote registry (Open VSX). The
  // registry has already reduced the VSIX to the declarative subset NovaCode
  // supports, so this path never touches extension code.
  async function installRemote(manifest) {
    const validated = validateManifest(manifest);
    const records = readState();
    const existing = records.find((record) => record.manifest.id === validated.id);
    if (existing) {
      existing.manifest = validated;
      existing.enabled = true;
      existing.updatedAt = new Date().toISOString();
    } else {
      records.push({
        manifest: validated,
        enabled: true,
        installedAt: new Date().toISOString(),
        source: 'registry',
      });
    }
    writeState(records);
    logger.info?.(`extension installed from registry: ${validated.id}`);
    return { ok: true, manifest: validated };
  }

  async function install(id) {
    const entry = findCatalogEntry(id);
    if (!entry) throw new Error(`Extension "${id}" is not in the catalog.`);
    const manifest = validateManifest(entry.manifest);
    if (manifest.engines?.nova && !satisfiesEngine(manifest.engines.nova, appVersion)) {
      throw new Error(`${manifest.name} requires NovaCode ${manifest.engines.nova} (you have ${appVersion}).`);
    }
    const records = readState();
    if (records.some((record) => record.manifest.id === id)) {
      throw new Error(`${manifest.name} is already installed.`);
    }
    records.push({
      manifest,
      enabled: true,
      installedAt: new Date().toISOString(),
      source: 'bundled-catalog',
    });
    writeState(records);
    logger.info?.(`extension installed: ${id}`);
    return { ok: true, manifest };
  }

  async function update(id) {
    const entry = findCatalogEntry(id);
    if (!entry) throw new Error(`Extension "${id}" is not in the catalog.`);
    const records = readState();
    const record = records.find((item) => item.manifest.id === id);
    if (!record) throw new Error(`${id} is not installed.`);
    const comparison = compareVersions(entry.manifest.version, record.manifest.version);
    if (comparison <= 0) return { ok: true, updated: false, version: record.manifest.version };
    const manifest = validateManifest(entry.manifest);
    if (manifest.engines?.nova && !satisfiesEngine(manifest.engines.nova, appVersion)) {
      throw new Error(`${manifest.name} requires NovaCode ${manifest.engines.nova}.`);
    }
    record.manifest = manifest;
    record.updatedAt = new Date().toISOString();
    writeState(records);
    logger.info?.(`extension updated: ${id} -> ${manifest.version}`);
    return { ok: true, updated: true, version: manifest.version };
  }

  async function setEnabled(id, enabled) {
    const records = readState();
    const record = records.find((item) => item.manifest.id === id);
    if (!record) throw new Error(`${id} is not installed.`);
    record.enabled = Boolean(enabled);
    writeState(records);
    return { ok: true, enabled: record.enabled };
  }

  async function uninstall(id) {
    const records = readState();
    const next = records.filter((item) => item.manifest.id !== id);
    if (next.length === records.length) throw new Error(`${id} is not installed.`);
    writeState(next);
    logger.info?.(`extension uninstalled: ${id}`);
    return { ok: true };
  }

  return { list, install, installRemote, update, setEnabled, uninstall, validateManifest };
}

module.exports = {
  createExtensionService,
  validateManifest,
  compareVersions,
  satisfiesEngine,
  ALLOWED_CATEGORIES,
};
