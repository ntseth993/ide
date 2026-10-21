/**
 * Runtime detection service.
 *
 * Detects external toolchains (Python, JDK, compilers, ...) that language
 * features beyond Monaco's built-in highlighting depend on, and reports
 * honest results: found/not-found, version when parseable, and how to
 * install the missing tool. Detection never throws per-tool; a tool that
 * cannot be probed is reported as not found with the probe error.
 */

const { execFile } = require('child_process');

/** Tools probed on this platform. versionPattern extracts the first match. */
const DEFAULT_TOOLS = [
  { id: 'node', label: 'Node.js', command: 'node', versionArgs: ['--version'], versionPattern: /v(\d+[.\d]*)/, installHint: 'https://nodejs.org' },
  { id: 'python', label: 'Python', command: 'python', versionArgs: ['--version'], versionPattern: /Python\s+(\d+[.\d]*)/, installHint: 'https://python.org/downloads' },
  { id: 'java', label: 'Java (JDK)', command: 'java', versionArgs: ['-version'], versionPattern: /version\s+"([^"]+)"/, installHint: 'https://adoptium.net' },
  { id: 'gcc', label: 'GCC (C)', command: 'gcc', versionArgs: ['--version'], versionPattern: /(\d+\.\d+\.\d+)/, installHint: 'https://winlibs.com or MSYS2' },
  { id: 'gpp', label: 'G++ (C++)', command: 'g++', versionArgs: ['--version'], versionPattern: /(\d+\.\d+\.\d+)/, installHint: 'https://winlibs.com or MSYS2' },
  { id: 'dotnet', label: '.NET SDK (C#)', command: 'dotnet', versionArgs: ['--version'], versionPattern: /(\d+\.\d+\.\d+)/, installHint: 'https://dotnet.microsoft.com/download' },
  { id: 'php', label: 'PHP', command: 'php', versionArgs: ['--version'], versionPattern: /PHP\s+(\d+\.\d+\.\d+)/, installHint: 'https://windows.php.net' },
  { id: 'dart', label: 'Dart SDK', command: 'dart', versionArgs: ['--version'], versionPattern: /(\d+\.\d+\.\d+)/, installHint: 'https://dart.dev/get-dart' },
  { id: 'go', label: 'Go', command: 'go', versionArgs: ['version'], versionPattern: /go(\d+\.\d+(?:\.\d+)?)/, installHint: 'https://go.dev/dl' },
  { id: 'rustc', label: 'Rust', command: 'rustc', versionArgs: ['--version'], versionPattern: /rustc\s+(\d+\.\d+\.\d+)/, installHint: 'https://rustup.rs' },
  { id: 'ruby', label: 'Ruby', command: 'ruby', versionArgs: ['--version'], versionPattern: /ruby\s+(\d+\.\d+\.\d+)/, installHint: 'https://rubyinstaller.org' },
  { id: 'sqlite', label: 'SQLite (CLI)', command: 'sqlite3', versionArgs: ['--version'], versionPattern: /(\d+\.\d+\.\d+)/, installHint: 'https://sqlite.org/download.html' },
  { id: 'kotlinc', label: 'Kotlin compiler', command: 'kotlinc', versionArgs: ['-version'], versionPattern: /(\d+\.\d+\.\d+)/, installHint: 'https://kotlinlang.org/docs/command-line.html' },
  { id: 'swift', label: 'Swift', command: 'swift', versionArgs: ['--version'], versionPattern: /Swift\s+version\s+(\d+[.\d]*)/, installHint: 'https://swift.org/download' },
];

function execPromise(execFileFn, command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFileFn(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/**
 * @param {object} [deps]
 * @param {Array} [deps.tools] tool definitions to probe
 * @param {Function} [deps.execFileFn] injectable execFile for tests
 * @param {number} [deps.timeoutMs] per-probe timeout
 */
function createRuntimeService({ tools = DEFAULT_TOOLS, execFileFn = execFile, timeoutMs = 4000 } = {}) {
  const isWindows = process.platform === 'win32';

  async function probe(tool) {
    // Step 1: resolve the executable on PATH ("where"/"which").
    const lookup = await execPromise(
      execFileFn,
      isWindows ? 'where' : 'which',
      [tool.command],
      timeoutMs,
    );
    if (lookup.error && !lookup.stdout.trim()) {
      return {
        id: tool.id,
        label: tool.label,
        found: false,
        version: null,
        path: null,
        installHint: tool.installHint,
        note: `${tool.label} was not found on PATH.`,
      };
    }
    const resolvedPath = lookup.stdout.trim().split(/\r?\n/)[0];

    // Step 2: ask for a version (some tools print it on stderr).
    const probe2 = await execPromise(execFileFn, resolvedPath, tool.versionArgs, timeoutMs);
    const output = `${probe2.stdout}\n${probe2.stderr}`;
    const match = tool.versionPattern.exec(output);
    if (probe2.error && !match) {
      return {
        id: tool.id,
        label: tool.label,
        found: true,
        version: null,
        path: resolvedPath,
        installHint: tool.installHint,
        note: `${tool.label} is on PATH but its version could not be read.`,
      };
    }
    return {
      id: tool.id,
      label: tool.label,
      found: true,
      version: match ? match[1] : null,
      path: resolvedPath,
      installHint: tool.installHint,
      note: match ? '' : `${tool.label} is available; version unknown.`,
    };
  }

  async function detectAll() {
    const runtimes = await Promise.all(tools.map(probe));
    return { runtimes, detectedAt: new Date().toISOString() };
  }

  return { detectAll, probe, DEFAULT_TOOLS };
}

module.exports = { createRuntimeService, DEFAULT_TOOLS };
