/**
 * terminalService shell-profile tests: per-platform profile lists, profile
 * resolution with a default fallback, and the profiles() summary shape.
 */
import { describe, it, expect } from 'vitest';
import { createTerminalService, profilesFor, resolveShell, pickShell } from '../electron/services/terminalService';

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
