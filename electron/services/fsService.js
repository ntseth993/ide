/**
 * Workspace filesystem service.
 *
 * Every operation resolves its target through pathGuard first, so the
 * renderer can never read, write, or delete anything outside the opened
 * workspace folder. Large/binary-ish files and dependency folders are
 * deliberately skipped to keep the IDE fast on big repositories.
 */
const fsp = require('fs').promises;
const path = require('path');
const { assertPlainName, resolveWithin, resolveRename, PathGuardError } = require('./pathGuard');

const IGNORED_NAMES = new Set([
  'node_modules', '.git', 'dist', 'release', 'build', 'out',
  '__pycache__', '.venv', 'venv', '.next', '.cache', '.nova-backup',
]);
const MAX_TREE_DEPTH = 6;
const MAX_TREE_ENTRIES = 5000;
const MAX_READ_BYTES = 5 * 1024 * 1024;
const MAX_SEARCH_BYTES = 1024 * 1024;
const MAX_SEARCH_RESULTS = 200;

async function readTree(root, target) {
  const dir = resolveWithin(root, target || root);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const nodes = [];
  let count = 0;

  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name)) continue;
    if (count >= MAX_TREE_ENTRIES) break;
    count += 1;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const relative = path.relative(path.resolve(root), fullPath);
      const children = relative.split(path.sep).length <= MAX_TREE_DEPTH
        ? await readTree(root, fullPath).catch(() => [])
        : [];
      nodes.push({ name: entry.name, path: fullPath, type: 'folder', children });
    } else if (entry.isFile()) {
      nodes.push({ name: entry.name, path: fullPath, type: 'file', children: [] });
    }
  }

  return nodes.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'folder' ? -1 : 1;
  });
}

async function readFile(root, target) {
  const filePath = resolveWithin(root, target);
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) {
    throw new PathGuardError('That item is not a file.');
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new PathGuardError(
      `File is too large to open (${(stat.size / (1024 * 1024)).toFixed(1)} MB, limit 5 MB).`,
    );
  }
  return fsp.readFile(filePath, 'utf8');
}

async function writeFile(root, target, content) {
  if (typeof content !== 'string') {
    throw new PathGuardError('File content must be text.');
  }
  const filePath = resolveWithin(root, target);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, 'utf8');
  return { path: filePath };
}

async function createFile(root, dir, name) {
  const clean = assertPlainName(name);
  const filePath = resolveWithin(root, path.join(resolveWithin(root, dir), clean));
  await fsp.writeFile(filePath, '', { flag: 'wx', encoding: 'utf8' });
  return { path: filePath };
}

async function createFolder(root, dir, name) {
  const clean = assertPlainName(name);
  const folderPath = resolveWithin(root, path.join(resolveWithin(root, dir), clean));
  await fsp.mkdir(folderPath, { recursive: false });
  return { path: folderPath };
}

async function rename(root, target, newName) {
  const { source, destination } = resolveRename(root, target, newName);
  if (source === path.resolve(root)) {
    throw new PathGuardError('The workspace folder cannot be renamed.');
  }
  await fsp.rename(source, destination);
  return { path: destination };
}

async function remove(root, target) {
  const targetPath = resolveWithin(root, target);
  if (targetPath === path.resolve(root)) {
    throw new PathGuardError('The workspace folder itself cannot be deleted.');
  }
  await fsp.rm(targetPath, { recursive: true, force: false });
  return { ok: true };
}

/**
 * Multi-file text search across the workspace (skips ignored folders and
 * oversized files). `query` is treated as plain text; `isRegex` opts into
 * JavaScript regular expressions.
 */
async function search(root, { query, isRegex = false, caseSensitive = false } = {}) {
  if (typeof query !== 'string' || !query) {
    throw new PathGuardError('A search query is required.');
  }
  let matcher;
  try {
    matcher = new RegExp(
      isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      caseSensitive ? 'g' : 'gi',
    );
  } catch (error) {
    throw new PathGuardError(`Invalid search pattern: ${error.message}`);
  }

  const results = [];
  let searched = 0;
  const absoluteRoot = path.resolve(root);

  async function walk(dir, depth) {
    if (depth > MAX_TREE_DEPTH || results.length >= MAX_SEARCH_RESULTS) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_SEARCH_RESULTS) return;
      if (IGNORED_NAMES.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        let stat;
        try {
          stat = await fsp.stat(fullPath);
        } catch {
          continue;
        }
        if (stat.size > MAX_SEARCH_BYTES || stat.size === 0) continue;
        let text;
        try {
          text = await fsp.readFile(fullPath, 'utf8');
        } catch {
          continue;
        }
        searched += 1;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          matcher.lastIndex = 0;
          if (matcher.test(lines[i])) {
            results.push({
              path: fullPath,
              line: i + 1,
              preview: lines[i].trim().slice(0, 200),
            });
            matcher.lastIndex = 0;
            break;
          }
        }
      }
    }
  }

  await walk(absoluteRoot, 0);
  return { results, searchedFiles: searched, truncated: results.length >= MAX_SEARCH_RESULTS };
}

module.exports = {
  IGNORED_NAMES,
  MAX_READ_BYTES,
  createFile,
  createFolder,
  readFile,
  readTree,
  remove,
  rename,
  search,
  writeFile,
};
