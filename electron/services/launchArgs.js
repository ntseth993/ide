/**
 * NovaCode CLI argument parsing.
 *
 * The `nova` launcher shims (bin/nova.cmd, bin/nova, bin/nova.js) forward
 * their arguments to the Electron binary verbatim. This module turns that
 * argv slice into a single well-defined launch intent so the main process
 * can honor `nova`, `nova .`, `nova <folder>`, `nova <file>`, --help and
 * --version without embedding string parsing in lifecycle code.
 *
 * Accepted forms:
 *   (no args)          -> open the app with no workspace request
 *   --version | -v     -> print the version
 *   --help    | -h     -> print usage text
 *   .                  -> open the caller's working directory (the shim's
 *                         working directory is inherited by the app)
 *   <folder|file path> -> open that folder as a workspace / open that file
 *
 * Only the first positional argument is honored; extra positionals and
 * unknown flags are reported as errors so typos fail loudly instead of
 * being silently ignored.
 */

const VERSION_FLAGS = new Set(['--version', '-v', '-V']);
const HELP_FLAGS = new Set(['--help', '-h', '-?', '/?']);

/** Usage text; kept in one place so help output and docs stay in sync. */
function usageText(command = 'nova') {
  return [
    'NovaCode IDE - local-first AI code editor',
    '',
    'Usage:',
    `  ${command}                     Open NovaCode`,
    `  ${command} .                   Open the current directory as a workspace`,
    `  ${command} <folder>            Open a folder as a workspace`,
    `  ${command} <file>              Open a file in its parent folder`,
    `  ${command} --help | -h         Show this help`,
    `  ${command} --version | -v      Show the version`,
    '',
    'Examples:',
    `  ${command} .`,
    `  ${command} "C:\\Users\\me\\projects\\site"`,
    `  ${command} src\\index.js`,
  ].join('\n');
}

/**
 * Parse a launcher argv slice into a launch intent.
 *
 * @param {string[]} argv user arguments only (exe/app-path entries removed)
 * @param {{ version?: string, command?: string }} [meta]
 * @returns {{ kind: 'none'|'version'|'help'|'open'|'error',
 *             target?: string, text?: string }}
 */
function parseLaunchArgs(argv, { version = '', command = 'nova' } = {}) {
  const args = Array.isArray(argv) ? argv : [];
  let target = null;

  for (const raw of args) {
    const arg = String(raw);

    if (VERSION_FLAGS.has(arg)) {
      return { kind: 'version', text: `${command} ${version}`.trim() };
    }
    if (HELP_FLAGS.has(arg)) {
      return { kind: 'help', text: usageText(command) };
    }
    if (arg.startsWith('-')) {
      return { kind: 'error', text: `${command}: unknown option "${arg}" (try --help)` };
    }

    // First positional wins; anything after it is a mistake worth reporting.
    if (target !== null) {
      return {
        kind: 'error',
        text: `${command}: unexpected extra argument "${arg}" (only one folder or file is accepted)`,
      };
    }
    target = arg;
  }

  if (target === null) return { kind: 'none' };
  return { kind: 'open', target };
}

module.exports = { parseLaunchArgs, usageText };
