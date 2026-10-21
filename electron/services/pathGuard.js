/**
 * Pure path-validation helpers used by every privileged IPC handler.
 *
 * Every filesystem or terminal operation must prove that its target lives
 * inside the workspace root before touching the disk. These helpers are kept
 * free of Electron and filesystem imports so they can be unit tested quickly.
 */
const path = require('path');

class PathGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathGuardError';
    this.code = 'EPATHGUARD';
  }
}

/** Characters that are illegal in file names on at least one supported OS. */
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const FORBIDDEN_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

/** Windows reserved device names that must never be used as file names. */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Validate a user-supplied file or folder name (no path segments allowed).
 * @returns {string} the trimmed name when valid
 */
function assertPlainName(name) {
  if (typeof name !== 'string') {
    throw new PathGuardError('A text name is required.');
  }
  const cleaned = name.trim();
  if (!cleaned) {
    throw new PathGuardError('Name cannot be empty.');
  }
  if (cleaned.length > 255) {
    throw new PathGuardError('Name is too long (maximum 255 characters).');
  }
  if (cleaned === '.' || cleaned === '..') {
    throw new PathGuardError('That name is not allowed.');
  }
  if (FORBIDDEN_NAME_CHARS.test(cleaned)) {
    throw new PathGuardError('Name contains characters that are not allowed in file names.');
  }
  const lower = cleaned.toLowerCase().split('.')[0];
  if (WINDOWS_RESERVED.has(lower)) {
    throw new PathGuardError(`"${cleaned}" is a reserved system name.`);
  }
  return cleaned;
}

/**
 * Resolve `target` and prove it stays inside `root`.
 * Both arguments may be absolute or root-relative paths on any platform.
 * @returns {string} the resolved absolute path, guaranteed inside root
 */
function resolveWithin(root, target) {
  if (typeof root !== 'string' || !root.trim()) {
    throw new PathGuardError('Workspace root is not available. Open a folder first.');
  }
  if (typeof target !== 'string' || !target.trim()) {
    throw new PathGuardError('A target path is required.');
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, target);
  const relative = path.relative(resolvedRoot, resolved);
  // The root itself is a valid target for resolving (it is used as the base
  // directory for creates and tree reads); services decide which operations
  // may act on it.
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PathGuardError('Access outside the workspace folder is not allowed.');
  }
  return resolved;
}

/**
 * Resolve a rename destination: validates both the source and the new name.
 * @returns {{ source: string, destination: string }}
 */
function resolveRename(root, target, newName) {
  const source = resolveWithin(root, target);
  const clean = assertPlainName(newName);
  const destination = path.join(path.dirname(source), clean);
  const relative = path.relative(path.resolve(root), destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PathGuardError('Rename would move the item outside the workspace.');
  }
  return { source, destination };
}

module.exports = {
  PathGuardError,
  assertPlainName,
  resolveWithin,
  resolveRename,
};
