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

  function profiles() {
    const list = profilesFor(process.platform);
    const defaultId = (list.find((p) => p.default) || list[0]).id;
    return {
      platform: process.platform,
      defaultId,
      profiles: list.map((p) => ({ id: p.id, label: p.label, default: Boolean(p.default) })),
    };
  }

  function start({ root, cwd, command, profile }) {
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
      onEvent({ runId, type: 'error', data: error.message });
      onEvent({ runId, type: 'exit', data: JSON.stringify({ code: 127, signal: null }) });
      return { runId };
    }

    runs.set(runId, child);
    logger.info('terminal start', { runId, cwd: runCwd });

    child.stdout?.on('data', (chunk) => onEvent({ runId, type: 'stdout', data: chunk.toString() }));
    child.stderr?.on('data', (chunk) => onEvent({ runId, type: 'stderr', data: chunk.toString() }));

    child.on('error', (error) => {
      onEvent({ runId, type: 'error', data: error.message });
      cleanup(runId);
    });

    child.on('close', (code, signal) => {
      onEvent({ runId, type: 'exit', data: JSON.stringify({ code, signal }) });
      cleanup(runId);
    });

    return { runId, pid: child.pid ?? null };
  }

  function cancel(runId) {
    const child = runs.get(runId);
    if (!child || child.exitCode !== null || child.signalCode !== null) return { ok: false };
    if (process.platform === 'win32') {
      // Windows kill() does not terminate child trees; taskkill does.
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 3000).unref();
    }
    return { ok: true };
  }

  function dispose() {
    for (const [runId, child] of runs) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        /* best effort on shutdown */
      }
      cleanup(runId);
    }
  }

  return { start, cancel, dispose, profiles, activeCount: () => runs.size };
}

module.exports = { createTerminalService, pickShell, profilesFor, resolveShell };
