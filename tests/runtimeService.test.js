/**
 * Runtime detection service tests.
 *
 * Detection is fully injectable: these tests stub execFile so results are
 * deterministic, plus one live smoke test for `node` (present in the test
 * environment) to prove the real probe path works on this machine.
 */
import { describe, expect, it } from 'vitest';
import { createRuntimeService } from '../electron/services/runtimeService';

function fakeExec(responses) {
  const calls = [];
  return {
    calls,
    execFileFn(command, args, options, callback) {
      calls.push({ command, args });
      const response = responses[command] || { error: new Error('not found'), stdout: '', stderr: '' };
      setImmediate(() => callback(response.error, response.stdout, response.stderr));
    },
  };
}

const NODE_TOOL = {
  id: 'node', label: 'Node.js', command: 'node', versionArgs: ['--version'],
  versionPattern: /v(\d+[.\d]*)/, installHint: 'https://nodejs.org',
};

// The service resolves PATH with the platform's lookup tool; key the fake by it.
const LOOKUP = process.platform === 'win32' ? 'where' : 'which';

describe('createRuntimeService', () => {
  it('reports a found tool with its version and path', async () => {
    const fake = fakeExec({
      [LOOKUP]: { error: null, stdout: 'C:\\tools\\node.exe\n', stderr: '' },
      'C:\\tools\\node.exe': { error: null, stdout: 'v24.16.0\n', stderr: '' },
    });
    const service = createRuntimeService({ tools: [NODE_TOOL], execFileFn: fake.execFileFn });
    const { runtimes } = await service.detectAll();
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]).toMatchObject({
      id: 'node', found: true, version: '24.16.0', path: 'C:\\tools\\node.exe',
    });
    // Probe order: PATH lookup first, then version.
    expect(fake.calls[0].args).toEqual(['node']);
    expect(fake.calls[1].command).toBe('C:\\tools\\node.exe');
  });

  it('reads versions printed on stderr (java -version style)', async () => {
    const fake = fakeExec({
      [LOOKUP]: { error: null, stdout: '/usr/bin/java\n', stderr: '' },
      '/usr/bin/java': { error: null, stdout: '', stderr: 'openjdk version "21.0.2" 2024-01-16\n' },
    });
    const service = createRuntimeService({
      tools: [{ ...NODE_TOOL, id: 'java', label: 'Java (JDK)', versionPattern: /version\s+"([^"]+)"/ }],
      execFileFn: fake.execFileFn,
    });
    const { runtimes } = await service.detectAll();
    expect(runtimes[0].found).toBe(true);
    expect(runtimes[0].version).toBe('21.0.2');
  });

  it('reports missing tools with an install hint and never throws', async () => {
    const fake = fakeExec({}); // everything 404s
    const service = createRuntimeService({ tools: [NODE_TOOL], execFileFn: fake.execFileFn });
    const { runtimes } = await service.detectAll();
    expect(runtimes[0].found).toBe(false);
    expect(runtimes[0].version).toBeNull();
    expect(runtimes[0].installHint).toBe('https://nodejs.org');
  });

  it('handles a tool on PATH whose version cannot be parsed', async () => {
    const fake = fakeExec({
      [LOOKUP]: { error: null, stdout: '/opt/tool\n', stderr: '' },
      '/opt/tool': { error: null, stdout: 'gibberish', stderr: '' },
    });
    const service = createRuntimeService({ tools: [NODE_TOOL], execFileFn: fake.execFileFn });
    const { runtimes } = await service.detectAll();
    expect(runtimes[0].found).toBe(true);
    expect(runtimes[0].version).toBeNull();
    expect(runtimes[0].note).toMatch(/version unknown/);
  });

  it('detects the real Node.js toolchain in this environment', async () => {
    const service = createRuntimeService({ tools: [NODE_TOOL], timeoutMs: 8000 });
    const { runtimes } = await service.detectAll();
    expect(runtimes[0].found).toBe(true);
    expect(runtimes[0].version).toMatch(/^\d+\.\d+/);
  });
});
