/**
 * Terminal service: streaming command execution with cancellation.
 *
 * Commands run through the platform shell with the working directory
 * confined to the workspace. Output is streamed to the renderer as
 * { runId, type, data } events (stdout | stderr | error | exit) so the UI
 * stays responsive during long-running commands.
 */
const { spawn } = require('child_process');
const { resolveWithin, PathGuardError } = require('./pathGuard');

// Shell profiles the terminal can run commands through, mirroring an editor's
// "terminal profile" picker. The renderer shows these labels; `start({ profile })`
// selects which one actually spawns the command.
function profilesFor(platform) {
  if (platform === 'win32') {
    return [
      { id: 'powershell', label: 'PowerShell', file: 'powershell.exe', args: (c) => ['-NoLogo', '-NoProfile', '-Command', c], default: true },
      { id: 'cmd', label: 'Command Prompt', file: 'cmd.exe', args: (c) => ['/d', '/s', '/c', c] },
      { id: 'git-bash', label: 'Git Bash', file: 'bash.exe', args: (c) => ['-lc', c] },
      { id: 'wsl', label: 'WSL', file: 'wsl.exe', args: (c) => ['bash', '-lc', c] },
    ];
  }
  if (platform === 'darwin') {
    return [
      { id: 'zsh', label: 'zsh', file: 'zsh', args: (c) => ['-lc', c], default: true },
      { id: 'bash', label: 'bash', file: 'bash', args: (c) => ['-lc', c] },
    ];
  }
  return [
    { id: 'bash', label: 'bash', file: 'bash', args: (c) => ['-lc', c], default: true },
    { id: 'zsh', label: 'zsh', file: 'zsh', args: (c) => ['-lc', c] },
    { id: 'sh', label: 'sh', file: 'sh', args: (c) => ['-lc', c] },
  ];
}

function resolveShell(platform, profileId) {
  const list = profilesFor(platform);
  return list.find((p) => p.id === profileId) || list.find((p) => p.default) || list[0];
}

// Back-compat helper: the platform default shell.
function pickShell(platform = process.platform) {
  const profile = resolveShell(platform, null);
  return { file: profile.file, args: profile.args };
}

function createTerminalService({ onEvent, logger }) {
  const runs = new Map();
  let nextRunId = 1;

  function cleanup(runId) {
    runs.delete(runId);
  }

  // Terminate a spawned command and its whole child tree (Windows kill() only
  // stops the shell, not the processes it launched).
  function killTree(child) {
    if (!child) return;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 3000).unref();
    }
  }

  function profiles() {
    const list = profilesFor(process.platform);
    const defaultId = (list.find((p) => p.default) || list[0]).id;
    return {
      platform: process.platform,
      defaultId,
      profiles: list.map((p) => ({ id: p.id, label: p.label, default: Boolean(p.default) })),
    };
  }

  function start({ root, cwd, command, profile } = {}, emit = onEvent) {
    if (typeof command !== 'string' || !command.trim()) {
      throw new PathGuardError('A command is required.');
    }
    const runCwd = cwd ? resolveWithin(root, cwd) : resolveWithin(root, root);
    const shell = resolveShell(process.platform, profile);
    const runId = `term-${nextRunId}`;
    nextRunId += 1;

    let child;
    try {
      child = spawn(shell.file, shell.args(command), {
        cwd: runCwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      logger.error('terminal spawn failed', { error: error.message });
      emit({ runId, type: 'error', data: error.message });
      emit({ runId, type: 'exit', data: JSON.stringify({ code: 127, signal: null }) });
      return { runId };
    }

    runs.set(runId, child);
    logger.info('terminal start', { runId, cwd: runCwd });

    child.stdout?.on('data', (chunk) => emit({ runId, type: 'stdout', data: chunk.toString() }));
    child.stderr?.on('data', (chunk) => emit({ runId, type: 'stderr', data: chunk.toString() }));

    child.on('error', (error) => {
      emit({ runId, type: 'error', data: error.message });
      cleanup(runId);
    });

    child.on('close', (code, signal) => {
      emit({ runId, type: 'exit', data: JSON.stringify({ code, signal }) });
      cleanup(runId);
    });

    return { runId, pid: child.pid ?? null };
  }

  function cancel(runId) {
    const child = runs.get(runId);
    if (!child || child.exitCode !== null || child.signalCode !== null) return { ok: false };
    killTree(child);
    return { ok: true };
  }

  /**
   * Run a command to completion and capture its combined output as a single
   * string, for the AI Agent to feed back to the model. Unlike start(), this
   * does not stream to the terminal panel and never throws: failures resolve
   * with a structured { output, code, error } so the agent loop can continue.
   * The working directory is confined to the workspace via pathGuard.
   */
  function runCapture({ root, cwd, command, profile, timeoutMs = 120000, maxBytes = 200000 } = {}) {
    return new Promise((resolve) => {
      if (typeof command !== 'string' || !command.trim()) {
        resolve({ output: '', code: 127, signal: null, error: 'A command is required.' });
        return;
      }
      let runCwd;
      try {
        runCwd = cwd ? resolveWithin(root, cwd) : resolveWithin(root, root);
      } catch (error) {
        resolve({ output: '', code: 127, signal: null, error: error.message });
        return;
      }

      const shell = resolveShell(process.platform, profile);
      let child;
      try {
        child = spawn(shell.file, shell.args(command), {
          cwd: runCwd,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        logger.error('terminal capture spawn failed', { error: error.message });
        resolve({ output: '', code: 127, signal: null, error: error.message });
        return;
      }

      let output = '';
      let truncated = false;
      let timedOut = false;
      const collect = (chunk) => {
        if (truncated) return;
        output += chunk.toString();
        if (output.length > maxBytes) {
          output = output.slice(0, maxBytes);
          truncated = true;
        }
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        killTree(child);
      }, timeoutMs);

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ output, code: 127, signal: null, error: error.message, truncated, timedOut });
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (timedOut) {
          resolve({ output, code: null, signal, error: `Command timed out after ${Math.round(timeoutMs / 1000)}s.`, truncated, timedOut });
          return;
        }
        resolve({ output, code, signal, truncated, timedOut });
      });
    });
  }

  function dispose() {
    for (const [runId, child] of runs) {
      try {
        killTree(child);
      } catch {
        /* best effort on shutdown */
      }
      cleanup(runId);
    }
  }

  return { start, cancel, runCapture, dispose, profiles, activeCount: () => runs.size };
}

module.exports = { createTerminalService, pickShell, profilesFor, resolveShell };
