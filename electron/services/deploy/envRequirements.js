'use strict';
/**
 * Environment-variable requirement detection — names only, never values.
 *
 * A deployment that "succeeds" while the app crashes on a missing variable is
 * not a working deploy, so the Deploy review screen has to answer: which
 * variables does this project actually read, and which of them does the host
 * not know about yet?
 *
 * Everything here is static analysis over source text. Values are never read,
 * never parsed out of a .env file, never returned over IPC and never logged:
 * the only thing this module reports is the *name* of a variable and where the
 * reference was found.
 */
const fsp = require('fs').promises;
const path = require('path');
const { resolveWithin } = require('../pathGuard');

const SCAN_DIRS = ['src', 'app', 'pages', 'server', 'api', 'lib', 'functions', 'netlify', 'electron', '.'];
const TEXT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte', '.py', '.rb', '.ru', '.go', '.rs', '.php', '.html', '.json', '.toml', '.yaml', '.yml']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out', '.novacode', '.vercel', '.netlify', 'coverage', '__pycache__', '.venv', 'venv', 'static', 'public', 'assets', 'images', 'img', 'vendor']);
const MAX_SCAN_FILES = 400;
const MAX_SCAN_BYTES = 512 * 1024;

// Frameworks that never see a runtime env: `Vite` inlines import.meta.env.VITE_*
// at build time, so those have to exist *before* we run the build, unlike a
// server-side process.env read which the host resolves at run time.
const BUILD_TIME_PREFIXES = ['VITE_', 'NEXT_PUBLIC_', 'ASTRO_PUBLIC_'];

const PATTERNS = [
  { kind: 'process.env', re: /\bprocess\.env\.([A-Z][A-Z0-9_]*)/g, buildTime: false },
  { kind: 'process.env', re: /\bprocess\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g, buildTime: false },
  { kind: 'import.meta.env', re: /\bimport\.meta\.env\.([A-Z][A-Z0-9_]*)/g, buildTime: true },
  { kind: 'os.environ', re: /\bos\.environ(?:\.get)?\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g, buildTime: false },
  // Subscript is the idiomatic Python read, so it has to match as well as .get().
  { kind: 'os.environ', re: /\bos\.environ\s*\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g, buildTime: false },
  { kind: 'ENV[]', re: /\bENV\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g, buildTime: false },
];

// Cheap pre-filter so a static site does not pay for five regexes per file.
// Case-insensitive on purpose: Ruby spells the reference ENV[...].
const ENV_HINT = /env/i;

const IGNORED_NAMES = new Set(['NODE_ENV', 'PORT', 'CI', 'PATH', 'HOME', 'PWD', 'SHELL', 'LANG', 'DEBUG', 'HOSTNAME', 'TZ']);

function isBuildTime(name) {
  return BUILD_TIME_PREFIXES.some((prefix) => String(name).startsWith(prefix));
}

/** Parse only the KEYS of an .env-style file. The value side of `=` is discarded. */
function envKeysFrom(text) {
  const keys = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

async function readIfExists(abs) {
  try { return await fsp.readFile(abs, 'utf8'); } catch { return null; }
}

async function collectScanFiles(rootAbs, maxFiles) {
  const found = [];
  const seen = new Set();
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= maxFiles) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext) && !/\benv\.example\b|\benv\.sample\b/i.test(entry.name)) continue;
      if (seen.has(abs)) continue;
      seen.add(abs);
      found.push(abs);
    }
  }
  // Scan known source-ish folders first, then the root, so a big repo still
  // finds its references before hitting the file budget.
  for (const dir of SCAN_DIRS) {
    await walk(path.join(rootAbs, dir));
    if (found.length >= maxFiles) break;
  }
  return found;
}

/**
 * @param {{ root: string, providerKeys?: string[], logger?: Object,
 *   limits?: { maxScanFiles?: number, maxScanBytes?: number } }} options
 * The limits exist so callers (and tests) can lower the budget on huge repos;
 * they only ever shrink the default, never raise it above what is safe to read.
 * @returns {Promise<{ required: Array<{key, source, buildTime}>, fromExampleFiles: string[],
 *   locallyDefined: string[], providerDefined: string[], missing: string[], warnings: string[] }>}
 */
async function detectEnvRequirements({ root, providerKeys = [], logger = console, limits = {} } = {}) {
  const rootAbs = resolveWithin(root, root);
  const maxFiles = Math.min(Number(limits.maxScanFiles) || MAX_SCAN_FILES, MAX_SCAN_FILES);
  const maxBytes = Math.min(Number(limits.maxScanBytes) || MAX_SCAN_BYTES, MAX_SCAN_BYTES);
  const required = new Map();
  const warnings = [];

  // 1 · .env.example / .env.sample document the contract explicitly.
  const fromExampleFiles = [];
  for (const name of ['.env.example', '.env.sample', '.env.template']) {
    const text = await readIfExists(path.join(rootAbs, name));
    if (!text) continue;
    for (const key of envKeysFrom(text)) {
      fromExampleFiles.push(key);
      if (!required.has(key)) required.set(key, { key, source: name, buildTime: isBuildTime(key) });
    }
  }

  // 2 · Static scan of the sources.
  const files = await collectScanFiles(rootAbs, maxFiles);
  let scannedBytes = 0;
  for (const abs of files) {
    try {
      const stat = await fsp.stat(abs);
      if (stat.size > maxBytes) continue;
      scannedBytes += stat.size;
      const text = await fsp.readFile(abs, 'utf8');
      if (!ENV_HINT.test(text)) continue;
      for (const pattern of PATTERNS) {
        pattern.re.lastIndex = 0;
        let match;
        while ((match = pattern.re.exec(text)) !== null) {
          const key = match[1];
          if (!key || IGNORED_NAMES.has(key)) continue;
          const buildTime = pattern.buildTime || isBuildTime(key);
          if (!required.has(key)) {
            required.set(key, { key, source: toRel(rootAbs, abs), buildTime });
          }
        }
      }
    } catch { /* unreadable file: skipping is correct here */ }
  }
  if (files.length >= maxFiles) {
    warnings.push(`Scanned the first ${maxFiles} source files; add any remaining variables manually below.`);
  }

  // 3 · Names the developer already has locally, and names the host already knows.
  const locallyDefined = [];
  for (const name of ['.env', '.env.local', '.env.development']) {
    const text = await readIfExists(path.join(rootAbs, name));
    if (text) locallyDefined.push(...envKeysFrom(text));
  }

  const providerSet = new Set(providerKeys);
  const localSet = new Set(locallyDefined);
  const list = [...required.values()].sort((a, b) => a.key.localeCompare(b.key));
  const missing = list
    .filter((entry) => !providerSet.has(entry.key) && !localSet.has(entry.key))
    .map((entry) => entry.key);

  logger.info?.('env requirement scan', { files: files.length, bytes: scannedBytes, required: list.length, missing: missing.length });

  return {
    required: list,
    fromExampleFiles: [...new Set(fromExampleFiles)],
    locallyDefined: [...new Set(locallyDefined)],
    providerDefined: [...providerSet],
    missing,
    warnings,
  };
}

function toRel(rootAbs, abs) {
  return path.relative(rootAbs, abs).split(path.sep).join('/');
}

module.exports = { detectEnvRequirements, envKeysFrom, isBuildTime, BUILD_TIME_PREFIXES, SKIP_DIRS };
