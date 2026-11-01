'use strict';
/**
 * Source collector — decides exactly which bytes leave the machine.
 *
 * This is the one place that turns a folder into an uploadable bundle, so it is
 * also the place that guarantees the "never upload secrets, private keys, local
 * databases or unrelated files" rule. Two independent layers of exclusion:
 *
 *   1. DENIED — hard rules that ignore files cannot turn off: .env files, key
 *      material, credential stores, VCS/IDE state, node_modules, NovaCode's own
 *      `.novacode` folder, and the connector's database files.
 *   2. Ignores — the project's own `.gitignore`, plus the provider's ignore file
 *      (`.vercelignore` / `.netlifyignore`), evaluated with a deliberately small
 *      gitignore subset (documented below) that covers real-world usage.
 *
 * Files are hashed with SHA1 while walking, because both providers identify
 * upload content by that digest (Vercel `x-vercel-digest`, Netlify's file
 * digest). Contents are read lazily so a 500-file bundle never sits in memory.
 */
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { resolveWithin } = require('../pathGuard');

const MAX_FILES = 15000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

/** Directories that must never be walked. */
const DENIED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.novacode', '.vercel', '.netlify',
  '.next', '.nuxt', '.turbo', '.parcel-cache', '.idea', '.vscode', '.cache',
  '.parcel-cache', 'coverage', '.nyc_output', '__pycache__', '.venv', 'venv',
]);

/**
 * File-name rules that are always denied. `reason` is surfaced in the review
 * screen so the user can see *why* something was left out, not just that it was.
 */
const DENIED_FILES = [
  { test: /^\.env(\.|$)/, reason: 'local environment secrets' },
  { test: /\.(pem|key|p12|pfx|jks|keystore)$/i, reason: 'private key material' },
  { test: /^(id_[a-z0-9]+|.*\.pub\.key)$/i, reason: 'ssh key material' },
  { test: /^novacode-secrets\.json$/i, reason: 'NovaCode credential store' },
  { test: /\.(novadb|sqlite3?|db|duckdb)$/i, reason: 'local database files' },
  { test: /\.(log|tsbuildinfo)$/i, reason: 'build/log output' },
  { test: /^(\.DS_Store|Thumbs\.db|\.localized)$/i, reason: 'OS metadata' },
  { test: /^\.npmrc$|^\.yarnrc(\.npmrc)?$/i, reason: 'registry credentials' },
  { test: /^credentials(\.|$)/i, reason: 'cloud credentials' },
  { test: /\.aws-config$/i, reason: 'cloud credentials' },
];

const IGNORE_FILES = ['.gitignore', '.vercelignore', '.netlifyignore', '.npmignore'];

/** Escape a path for display in the UI (forward slashes everywhere). */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

function deniedFile(name) {
  for (const rule of DENIED_FILES) if (rule.test.test(name)) return rule.reason;
  return null;
}

/**
 * Minimal gitignore matcher.
 * Supports: `#` comments, blank lines, `!` negation, trailing `/` (directory
 * only), leading `/` (anchored to root), `*` / `?` globs and `**` anywhere.
 * Deliberately does not support character classes or brace expansion; a project
 * that needs those keeps its exact behaviour by editing the build settings.
 */
function compileIgnoreRule(raw) {
  let pattern = raw.trim();
  if (!pattern || pattern.startsWith('#')) return null;
  let negated = false;
  if (pattern.startsWith('!')) { negated = true; pattern = pattern.slice(1); }
  let dirOnly = false;
  if (pattern.endsWith('/')) { dirOnly = true; pattern = pattern.slice(0, -1); }
  const anchored = pattern.startsWith('/');
  if (anchored) pattern = pattern.slice(1);

  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment === '**') return '.*';
      return segment
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]');
    })
    .join('/');
  // A pattern matches the path itself or anything below it, never a sibling
  // that merely starts with the same characters ('temp' vs 'temp.txt').
  const regex = new RegExp(`^(${anchored ? '' : '(?:.*/)?'}${source})(?:/.*)?$`);
  return { regex, negated, dirOnly };
}

function createIgnoreMatcher(linesByFile) {
  const rules = [];
  for (const [baseDir, lines] of Object.entries(linesByFile)) {
    for (const line of lines) {
      const compiled = compileIgnoreRule(line);
      if (compiled) rules.push({ ...compiled, base: baseDir });
    }
  }
  /** @param {string} relPosix path relative to the bundle root, no leading slash */
  return function isIgnored(relPosix, { directory = false } = {}) {
    let ignored = false;
    for (const rule of rules) {
      // A rule from a nested .gitignore only ever speaks about its own subtree.
      let candidate = relPosix;
      if (rule.base) {
        if (!relPosix.startsWith(`${rule.base}/`)) continue;
        candidate = relPosix.slice(rule.base.length + 1);
      }
      // Directory-only patterns cover the folder itself and what is inside it;
      // anything deeper always contains a slash, so a plain name cannot match.
      if (rule.dirOnly && !directory && !candidate.includes('/')) continue;
      if (rule.regex.test(candidate)) ignored = !rule.negated;
    }
    return ignored;
  };
}

async function readIgnoreLines(rootAbs, dirAbs) {
  const out = {};
  const rootRel = toPosix(path.relative(rootAbs, dirAbs));
  for (const name of IGNORE_FILES) {
    const file = path.join(dirAbs, name);
    try {
      const text = await fsp.readFile(file, 'utf8');
      const key = rootRel === '.' ? '' : rootRel;
      out[key] = (out[key] || []).concat(text.split(/\r?\n/));
    } catch { /* not every folder has one */ }
  }
  return out;
}

/**
 * Walk `dirAbs` and produce the bundle descriptor.
 *
 * @param {{ root: string, dir: string, limits?: {maxFiles?: number, maxFileBytes?: number, maxTotalBytes?: number} }} options
 *   `root` is the workspace (everything is confined to it), `dir` the folder to upload.
 * @returns {Promise<{ files: Array<{path,sha,size,read}>, fileCount, totalBytes,
 *   excluded: {secrets: Array<{path,reason}>, ignored: number, tooLarge: Array<{path,size}> },
 *   limits: Object, warnings: string[] }>}
 */
async function collectBundle({ root, dir, limits = {}, logger = console } = {}) {
  const rootAbs = resolveWithin(root, root);
  const baseAbs = resolveWithin(rootAbs, dir || rootAbs);
  const maxFiles = limits.maxFiles || MAX_FILES;
  const maxFileBytes = limits.maxFileBytes || MAX_FILE_BYTES;
  const maxTotalBytes = limits.maxTotalBytes || MAX_TOTAL_BYTES;

  const files = [];
  const excluded = { secrets: [], ignored: 0, tooLarge: [] };
  const warnings = [];
  let totalBytes = 0;

  // Collect ignore files first so nested .gitignore entries are honoured.
  const ignoreLines = {};
  async function gatherIgnores(current) {
    Object.assign(ignoreLines, await readIgnoreLines(baseAbs, current));
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (DENIED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await gatherIgnores(path.join(current, entry.name));
    }
  }
  await gatherIgnores(baseAbs);
  const isIgnored = createIgnoreMatcher(ignoreLines);

  async function walk(current, relBase) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        warnings.push(`Stopped after ${maxFiles} files — narrow the output folder or raise the limit.`);
        return;
      }
      const abs = path.join(current, entry.name);
      const rel = toPosix(relBase ? path.join(relBase, entry.name) : entry.name);

      if (entry.isDirectory()) {
        if (DENIED_DIRS.has(entry.name)) continue;
        if (isIgnored(rel, { directory: true })) { excluded.ignored += 1; continue; }
        await walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue; // skip symlinks/fifos: never follow out of root

      const secretReason = deniedFile(entry.name);
      if (secretReason) { excluded.secrets.push({ path: rel, reason: secretReason }); continue; }
      if (IGNORE_FILES.includes(entry.name)) { excluded.ignored += 1; continue; }
      if (isIgnored(rel)) { excluded.ignored += 1; continue; }

      const stat = await fsp.stat(abs);
      if (stat.size > maxFileBytes) {
        excluded.tooLarge.push({ path: rel, size: stat.size });
        continue;
      }
      if (totalBytes + stat.size > maxTotalBytes) {
        warnings.push(`Bundle would exceed ${Math.round(maxTotalBytes / 1048576)} MB — "${rel}" and later files were skipped.`);
        continue;
      }

      const sha = crypto.createHash('sha1').update(await fsp.readFile(abs)).digest('hex');
      totalBytes += stat.size;
      files.push({
        path: rel,
        sha,
        size: stat.size,
        // Lazily re-read at upload time so the whole bundle is never resident.
        read: () => fsp.readFile(abs),
      });
    }
  }

  await walk(baseAbs, '');

  if (!files.length) warnings.push('The selected folder contains no uploadable files after ignore rules were applied.');
  if (excluded.tooLarge.length) {
    warnings.push(`${excluded.tooLarge.length} file(s) exceeded the ${Math.round(maxFileBytes / 1048576)} MB per-file limit and were skipped.`);
  }
  logger.info?.('deploy bundle collected', { fileCount: files.length, totalBytes, ignored: excluded.ignored, secrets: excluded.secrets.length });

  return {
    files,
    fileCount: files.length,
    totalBytes,
    excluded,
    warnings,
    limits: { maxFiles, maxFileBytes, maxTotalBytes },
    sourceDir: baseAbs,
  };
}

module.exports = {
  collectBundle,
  createIgnoreMatcher,
  compileIgnoreRule,
  deniedFile,
  DENIED_DIRS,
  DENIED_FILES,
  IGNORE_FILES,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
};
