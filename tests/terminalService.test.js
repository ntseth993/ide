/**
 * terminalService tests: shell-profile resolution (pure) plus the runCapture
 * primitive used by the AI Agent (real spawn, workspace-confined).
 */
import { describe, it, expect, vi } from 'vitest';
import os from 'os';
import path from 'path';
import {
  createTerminalService,
  profilesFor,
  resolveShell,
  pickShell,
} from '../electron/services/terminalService';

const logger = { info: () => {}, warn: () => {}, error: () => {} };

describe('terminal shell profiles', () => {
  it('offers PowerShell by default on Windows, with cmd / git-bash / wsl', () => {
    const ids = profilesFor('win32').map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['powershell', 'cmd', 'git-bash', 'wsl']));
    expect(resolveShell('win32', null).id).toBe('powershell');
    expect(resolveShell('win32', 'cmd').file).toBe('cmd.exe');
  });

  it('falls back to the platform default for an unknown profile id', () => {
    expect(resolveShell('win32', 'does-not-exist').id).toBe('powershell');
    expect(resolveShell('darwin', 'nope').id).toBe('zsh');
    expect(resolveShell('linux', 'nope').id).toBe('bash');
  });

  it('wraps commands with the shell-specific argument form', () => {
    expect(resolveShell('win32', 'powershell').args('npm run dev')).toEqual(['-NoLogo', '-NoProfile', '-Command', 'npm run dev']);
    expect(resolveShell('linux', 'bash').args('ls')).toEqual(['-lc', 'ls']);
  });

  it('pickShell returns the platform default shell (back-compat)', () => {
    const shell = pickShell('win32');
    expect(typeof shell.file).toBe('string');
    expect(shell.args('x')).toContain('x');
  });

  it('createTerminalService().profiles() reports the current platform', () => {
    const service = createTerminalService({ onEvent: () => {}, logger });
    const result = service.profiles();
    expect(result.platform).toBe(process.platform);
    expect(Array.isArray(result.profiles)).toBe(true);
    expect(result.profiles.length).toBeGreaterThan(0);
    expect(result.profiles.some((p) => p.id === result.defaultId && p.default)).toBe(true);
  });
});

function makeService() {
  return createTerminalService({
    onEvent: vi.fn(),
    logger: { info: vi.fn(), error: vi.fn() },
  });
}

describe('terminalService.runCapture', () => {
  it('resolves with a structured error for an empty command (never throws)', async () => {
    const term = makeService();
    const res = await term.runCapture({ root: os.tmpdir(), command: '   ' });
    expect(res.code).toBe(127);
    expect(res.error).toMatch(/command is required/i);
  });

  it('refuses to run outside the workspace root', async () => {
    const term = makeService();
    const root = path.resolve(os.tmpdir(), 'nova-capture-root');
    const res = await term.runCapture({ root, cwd: '..', command: 'echo hi' });
    expect(res.code).toBe(127);
    expect(res.error).toMatch(/outside the workspace/i);
  });

  it('requires a workspace root', async () => {
    const term = makeService();
    const res = await term.runCapture({ command: 'echo hi' });
    expect(res.error).toMatch(/workspace root/i);
  });

  it('runs a command to completion and captures its output', async () => {
    const term = makeService();
    const marker = `nova-capture-${process.pid}`;
    const res = await term.runCapture({ root: os.tmpdir(), command: `echo ${marker}` });
    expect(res.error).toBeUndefined();
    expect(res.code).toBe(0);
    expect(res.output).toContain(marker);
    expect(res.timedOut).toBe(false);
  }, 15000);

  it('honours a timeout and reports it', async () => {
    const term = makeService();
    // A command that outlives a tiny timeout must be killed, not hang forever.
    const slow = process.platform === 'win32'
      ? 'Start-Sleep -Seconds 5'
      : 'sleep 5';
    const res = await term.runCapture({ root: os.tmpdir(), command: slow, timeoutMs: 200 });
    expect(res.timedOut).toBe(true);
    expect(res.error).toMatch(/timed out/i);
  }, 15000);
});
