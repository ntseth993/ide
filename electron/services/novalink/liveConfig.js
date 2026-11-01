'use strict';
/**
 * Runtime reader for the NovaLink Live endpoint.
 *
 * Resolution order (first hit wins):
 *   1. `liveConfig.generated.js` — written by `scripts/generate-live-config.js`
 *      during `npm run build` / `npm run dist`. This is what a packaged
 *      NovaCode install reads.
 *   2. `process.env.NOVALINK_LIVE_URL` — dev escape hatch. `npm run dev`
 *      without a generated file still works against a laptop link-server.
 *   3. Empty string — the client boots unconfigured; the diagnostics panel
 *      surfaces "Not configured" honestly rather than pretending.
 *
 * The generated file is gitignored; the loader tolerates its absence so a
 * clean checkout without a `prebuild` run still boots.
 */
let cachedBaseUrl;

function loadGenerated() {
  try {
    const mod = require('./liveConfig.generated.js');
    if (mod && typeof mod.baseUrl === 'string') return mod.baseUrl;
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
  }
  return null;
}

function getBaseUrl() {
  if (cachedBaseUrl !== undefined) return cachedBaseUrl;
  const generated = loadGenerated();
  if (generated) {
    cachedBaseUrl = generated;
    return cachedBaseUrl;
  }
  cachedBaseUrl = typeof process.env.NOVALINK_LIVE_URL === 'string'
    ? process.env.NOVALINK_LIVE_URL.trim()
    : '';
  return cachedBaseUrl;
}

/** Test seam — clear the memoized value after mutating process.env. */
function __resetForTests() {
  cachedBaseUrl = undefined;
}

module.exports = { getBaseUrl, __resetForTests };
