/**
 * Autonomous-agent security policy (main process).
 *
 * The AI Agent runs file and terminal operations WITHOUT an approval dialog,
 * so the guarantees the user would otherwise give by clicking "Run" are
 * enforced HERE instead. Two rules drive everything:
 *
 *   1. Confidential material never crosses to the model or gets overwritten:
 *      secret files (.env, key pairs, token stores) are off-limits for the
 *      agent's read/write/delete/rename/move, even though they live inside the
 *      workspace and the human explorer can still open them.
 *   2. Terminal commands stay ordinary development work: an explicit denylist
 *      blocks disk formatting, shutdown, privilege escalation, remote-code
 *      pipes and destructive paths that target anything outside the project.
 *
 * Path confinement itself (no traversal outside the workspace) is already done
 * by pathGuard for every fs call; this module layers the SECRET and COMMAND
 * policies on top. It is pure — no Electron, no fs — so it unit-tests directly.
 */

// File names that hold credentials. Matched case-insensitively on the leaf name.
const SECRET_BASENAMES = new Set([
  '.env', '.env.local', '.env.development', '.env.production', '.env.test',
  '.npmrc', '.netrc', '_netrc', '.git-credentials', '.pypirc',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'credentials.json', 'credentials', 'secrets.json', 'secret.json',
  'service-account.json', 'gcloud_client_secrets.json',
]);

// Extensions / shapes that are always treated as secrets regardless of name.
const SECRET_PATTERNS = [
  /(^|[\\/])\.env([.^\\/]*|)$/, // .env, .env.prod, .env.localhost …
  /\.pem$/,
  /\.key$/,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /\.pgpass$/,
  /\.passwd$/,
  /(^|[\\/])\.aws[\\/]/,
  /(^|[\\/])(secrets|credentials|secret)[.][a-z]+$/,
];

/** Normalize a path to forward-slash form for consistent matching. */
function toPosix(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/');
}

function baseName(p) {
  const parts = toPosix(p).split('/');
  return parts[parts.length - 1] || '';
}

/**
 * True when a path points at a credential/secret file the agent must not read,
 * overwrite or remove. Applied to AI-initiated file operations only; the human
 * explorer keeps full access to its own project files.
 */
function isSecretPath(target) {
  const posix = toPosix(target).toLowerCase();
  if (!posix) return false;
  const leaf = baseName(posix).toLowerCase();
  if (SECRET_BASENAMES.has(leaf)) return true;
  return SECRET_PATTERNS.some((re) => re.test(posix));
}

// Executables that must never be run from the agent, by first token. These are
// OS-level / destructive tools, not project build tools.
const BLOCKED_EXECUTABLES = new Set([
  'mkfs', 'fdisk', 'diskpart', 'format', 'dd', 'shred',
  'shutdown', 'reboot', 'poweroff', 'halt', 'init',
  'sudo', 'su', 'runas', 'gsudo',
  'takeown', 'cacls', 'sc', 'reg',
]);

// Command shapes that are destructive or exfiltration-flavoured. Matched against
// the whole lower-cased command line.
const BLOCKED_PATTERNS = [
  // Recursive/root deletes of absolute or home paths (project-local rm is fine).
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~|\$home\b|c:\/?\s|c:\/windows)/i,
  /\bdel\s+([a-z]:\\windows|\/s(\s|\/)|\/q(\s|\/))/i,
  /\brd\s+\/s\b/i,
  /\b(remove-item|ri)\b.*-recur.*\b(c:\\|\\windows|\\system32|\$env:)/i,
  // Disk / filesystem tampering.
  /\b(mkfs|format)\b[\s:]/i,
  /\bdd\b.*\bof=\/dev\//i,
  /\b(chmod|chown)\b[^\n]*\s(\/etc\b|\/var\b|\/usr\b|\/bin\b|\/sbin\b|\/boot\b|\/sys\b|\/proc\b|\/root\b|\$home\b|\/(?=\s|$))/i,
  // Piping a fetched remote script straight into a shell (classic RCE vector).
  /\b(curl|wget)\b[^|]*\|\s*(ba)?sh\b/i,
  /(invoke-webrequest|invoke-restmethod)\b.*\|\s*(iex|invoke-expression)\b/i,
  // Fork bombs and shell self-destruct idioms.
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/,
  // Credential / security-teardown intent.
  /\bhistory\s+-c\b/i,
  /\bclear-eventlog\b/i,
  /\b(setenforce|echo\s+1\s*>.\s*selinux)/i,
  /\bnet\s+(user|localgroup)\b/i,
  /\bpasswd\b/i,
];

/**
 * Decide whether a terminal command the agent wants to run is allowed.
 * Normal development commands (npm/node/git/python/build/test) pass; anything
 * on the denylist is refused with a human-readable reason. Never throws.
 * @returns {{ok:boolean, reason?:string}}
 */
function assertCommand(command) {
  if (typeof command !== 'string' || !command.trim()) {
    return { ok: false, reason: 'A command is required.' };
  }
  const line = command.trim().toLowerCase();
  // Destructive Windows paths are written with backslashes (C:\Windows), but
  // the patterns below are expressed with forward slashes for portability, so
  // match against a slash-normalised copy too.
  const posixLine = line.replace(/\\/g, '/');
  // Inspect the first token of each `;`/`&&`/`||`/`|`/newline segment so a
  // blocked tool can't hide behind a chain ("npm ci && sudo …").
  for (const seg of line.split(/(?:&&|\|\||[;|\n])/)) {
    const first = seg.trim().split(/\s+/)[0];
    if (!first) continue;
    const bare = first.replace(/\.exe$/, '');
    if (BLOCKED_EXECUTABLES.has(bare)) {
      return { ok: false, reason: `"${bare}" is a system-level command and the agent will not run it.` };
    }
    // Dotted variants are the same tool: mkfs.ext4 / mkfs.xfs are mkfs.
    for (const blocked of BLOCKED_EXECUTABLES) {
      if (bare.startsWith(`${blocked}.`)) {
        return { ok: false, reason: `"${bare}" is a system-level command and the agent will not run it.` };
      }
    }
  }
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(line) || re.test(posixLine)) {
      return { ok: false, reason: 'That command matches a blocked destructive pattern.' };
    }
  }
  return { ok: true };
}

module.exports = { isSecretPath, assertCommand, SECRET_BASENAMES };
