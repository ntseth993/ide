/**
 * Deploy failure diagnostics.
 *
 * The behaviour that matters here is not the prose — it is what is allowed to
 * leave the machine, and what may never be claimed. So most of this file pushes a
 * credential through the pipeline and asserts it comes out masked, plus a couple of
 * tests that pin the honesty rules in the prompt itself.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildEvidence,
  createDeployDiagnostics,
  diagnosisMessages,
  matchKnownFailure,
  redactSensitive,
  KNOWN_FAILURES,
  MAX_EVIDENCE_CHARS,
  LOG_TAIL_LINES,
} from '../electron/services/deploy/deployDiagnostics';

/** A token of each shape a real build log can echo back. */
const VERCEL_TOKEN = 'vcu_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c';
const NETLIFY_TOKEN = 'nfp_personal_access_token_shape_9f8a7b';
const OPENAI_KEY = 'sk-proj-abcdef0123456789ABCDEF0123456789';
const GEMINI_KEY = 'AIzaSyD-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OPAQUE_SECRET = 'hunter2hunter2';

function runFixture(overrides = {}) {
  return {
    runId: 'run_1',
    provider: 'vercel',
    providerLabel: 'Vercel',
    teamId: 'team_acme',
    projectId: 'acme-site',
    phase: 'deploying',
    state: 'error',
    target: 'production',
    deploymentId: 'dpl_1',
    message: 'Vercel reported the deployment as errored.',
    fileCount: 12,
    totalBytes: 4096,
    upload: 'dist',
    log: ['packing dist', 'uploading 12 files'],
    error: { message: 'Not authorized', code: 'PROJECT_BLOCKED', status: 401 },
    ...overrides,
  };
}

/** Minimal stand-in for the controller: status + host logs, nothing else used. */
function hostingFixture({ run = runFixture(), logs, logThrows } = {}) {
  return {
    status: vi.fn(() => run),
    deployLogs: vi.fn(async () => {
      if (logThrows) throw new Error('host log unavailable');
      return typeof logs === 'string' ? { text: logs, deploymentId: 'dpl_1' } : { text: '', deploymentId: 'dpl_1' };
    }),
  };
}

const settingsFixture = {
  load: async () => ({ ai: { provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' } }),
};

describe('redactSensitive', () => {
  it('masks a bearer header once, without chewing up the scheme word', () => {
    const out = redactSensitive(`Authorization: Bearer ${VERCEL_TOKEN}`);
    expect(out).not.toContain(VERCEL_TOKEN);
    expect(out).toBe('Authorization: Bearer [redacted]');
  });

  it('masks a raw authorization value that has no scheme', () => {
    const out = redactSensitive(`authorization=${VERCEL_TOKEN}`);
    expect(out).not.toContain(VERCEL_TOKEN);
    expect(out.toLowerCase()).toContain('authorization=[redacted]');
  });

  it.each([
    ['vercel token shape', `using ${VERCEL_TOKEN} to deploy`],
    ['netlify token shape', `using ${NETLIFY_TOKEN} to deploy`],
    ['openai key', `export OPENAI_KEY=${OPENAI_KEY}`],
    ['gemini key', `gemini responded with ${GEMINI_KEY}`],
  ])('masks the %s', (_label, line) => {
    const out = redactSensitive(line);
    for (const secret of [VERCEL_TOKEN, NETLIFY_TOKEN, OPENAI_KEY, GEMINI_KEY]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('[redacted');
  });

  it('masks a private key block and keeps the line readable', () => {
    const out = redactSensitive([
      'loading credentials',
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ',
      '-----END PRIVATE KEY-----',
      'continuing',
    ].join('\n'));
    expect(out).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ');
    expect(out).toContain('[redacted-private-key]');
    expect(out).toContain('continuing');
  });

  it('masks a signed query parameter but leaves its name for context', () => {
    const out = redactSensitive('GET https://uploads.example.com/f?X-Amz-Signature=abc123def456&size=12');
    expect(out).not.toContain('abc123def456');
    expect(out).toContain('X-Amz-Signature=[redacted]');
    expect(out).toContain('size=12');
  });

  it('masks any NAME=value whose name says secret, echoing only the name', () => {
    const out = redactSensitive(`DATABASE_URL_PASSWORD: ${OPAQUE_SECRET} and more text`);
    expect(out).not.toContain(OPAQUE_SECRET);
    expect(out).toContain('PASSWORD');
  });

  it('masks an opaque literal handed in as never-send, matching no shape', () => {
    const out = redactSensitive(`retrying with ${'zz-44-qq-11-ww-ee-rr-tt-yy'} now`, ['zz-44-qq-11-ww-ee-rr-tt-yy']);
    expect(out).not.toContain('zz-44-qq-11-ww-ee-rr-tt-yy');
    expect(out).toContain('[redacted]');
  });

  it('leaves an ordinary build line alone', () => {
    const line = 'vite v5.2.0 building for production... 142 modules transformed.';
    expect(redactSensitive(line)).toBe(line);
  });

  it('tolerates empty and non-string input', () => {
    expect(redactSensitive(null)).toBe('');
    expect(redactSensitive(undefined)).toBe('');
    expect(redactSensitive(42)).toBe('42');
  });
});

describe('matchKnownFailure', () => {
  it('names a refused token as an account problem', () => {
    const hits = matchKnownFailure('Not authorized (401) — the stored token was rejected');
    expect(hits.map((h) => h.id)).toContain('auth');
  });

  it('does not read a byte count as an HTTP status', () => {
    // Guards the bounded digits: "14012 bytes" must not become "your token was refused".
    expect(matchKnownFailure('uploaded 14012 bytes in 3s').map((h) => h.id)).not.toContain('auth');
  });

  it.each([
    ['command "npm run build" failed with exit code 1', 'build-command'],
    ['Cannot find module \'react\'', 'missing-deps'],
    ['ENOENT: no such file or directory, scandir dist', 'no-output-dir'],
    ['Missing environment variable: API_URL', 'missing-env'],
    ['fetch failed: connect ETIMEDOUT 1.2.3.4:443', 'network'],
    ['Deployment was cancelled by user', 'cancelled'],
    ['429 Too Many Requests — rate limit exceeded', 'rate-limit'],
  ])('maps %s to %s', (line, expected) => {
    expect(matchKnownFailure(line).map((h) => h.id)).toContain(expected);
  });

  it('returns nothing rather than inventing a cause', () => {
    expect(matchKnownFailure('everything looks fine so far')).toEqual([]);
  });

  it('gives every known cause both a reason and an action', () => {
    for (const entry of KNOWN_FAILURES) {
      expect(entry.cause.length).toBeGreaterThan(10);
      expect(entry.fix.length).toBeGreaterThan(10);
      expect(entry.id).toMatch(/^[a-z-]+$/);
    }
  });
});

describe('buildEvidence', () => {
  it('reports the facts a diagnosis needs, with no secret in them', () => {
    const evidence = buildEvidence({
      run: runFixture({
        message: `rejected: bearer ${VERCEL_TOKEN}`,
        log: ['starting', `token ${VERCEL_TOKEN} accepted? no`],
      }),
      providerLog: `npm error command failed\nAuthorization: Bearer ${VERCEL_TOKEN}`,
      neverSend: [VERCEL_TOKEN],
    });
    expect(evidence.text).not.toContain(VERCEL_TOKEN);
    expect(evidence.text).toContain('Vercel');
    expect(evidence.text).toContain('phase: deploying');
    expect(evidence.text).toContain('deployment id: dpl_1');
    expect(evidence.text).toContain('files uploaded: 12 (4096 bytes)');
    expect(evidence.text).toContain('PROVIDER BUILD LOG');
    expect(evidence.hintIds).toContain('auth');
  });

  it('tails the logs instead of shipping the whole build', () => {
    const many = Array.from({ length: LOG_TAIL_LINES * 3 }, (_, i) => `line ${i}`);
    const evidence = buildEvidence({ run: runFixture({ log: many }) });
    expect(evidence.text).toContain(`line ${many.length - 1}`);
    expect(evidence.text).not.toContain('line 0\n');
    expect(evidence.text.split('\n').filter((l) => /^line \d+$/.test(l)).length).toBeLessThanOrEqual(LOG_TAIL_LINES);
  });

  it('stays inside the evidence budget', () => {
    const evidence = buildEvidence({
      run: runFixture({ message: 'x'.repeat(40000) }),
      providerLog: 'y'.repeat(40000),
    });
    expect(evidence.text.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS + 40);
    expect(evidence.text).toContain('evidence truncated');
  });

  it('says so when no deployment id exists yet', () => {
    const evidence = buildEvidence({ run: runFixture({ deploymentId: null }) });
    expect(evidence.text).toContain('deployment id: (not created)');
  });
});

describe('diagnosisMessages', () => {
  it('forbids claiming a deployment is live or inventing a URL', () => {
    const [{ content: system }] = diagnosisMessages(buildEvidence({ run: runFixture() }));
    expect(system).toMatch(/[Nn]ever invent a URL/);
    expect(system).toMatch(/Do not state that anything is live/);
    expect(system).toMatch(/\[redacted\]/);
  });

  it('carries the evidence, not the project source', () => {
    const messages = diagnosisMessages(buildEvidence({ run: runFixture() }));
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain('A deployment failed.');
    expect(messages[1].content).toContain('DEPLOYMENT FACTS');
  });
});

describe('createDeployDiagnostics', () => {
  it('refuses to exist without the controller', () => {
    expect(() => createDeployDiagnostics()).toThrow(/deploy controller/i);
    expect(() => createDeployDiagnostics({ hosting: {} })).toThrow(/deploy controller/i);
  });

  it('refuses to diagnose a run that did not fail', () => {
    const hosting = hostingFixture({ run: runFixture({ state: 'ready' }) });
    const svc = createDeployDiagnostics({ hosting });
    return expect(svc.diagnose({ runId: 'run_1' })).rejects.toThrow(/Only a failed deployment/);
  });

  it('asks the configured assistant, on redacted evidence only', async () => {
    const complete = vi.fn(async () => ({ text: 'Your token was refused. Reconnect the account.', provider: 'openai', model: 'gpt-4o-mini' }));
    const hosting = hostingFixture({
      logs: [
        'error: request failed',
        `> curl -H "Authorization: Bearer ${VERCEL_TOKEN}" https://api.vercel.com`,
        `env OPENAI_API_KEY=${OPENAI_KEY} leaked by a plugin`,
      ].join('\n'),
    });
    const getSecret = vi.fn(async () => VERCEL_TOKEN);
    const svc = createDeployDiagnostics({
      hosting,
      ai: { complete },
      settings: settingsFixture,
      secretStore: { getSecret },
      logger: { warn: vi.fn() },
    });

    const result = await svc.diagnose({ runId: 'run_1' });

    expect(getSecret).toHaveBeenCalledWith('hosting-vercel-token');
    const sent = complete.mock.calls[0][0];
    expect(sent.provider).toBe('openai');
    expect(sent.model).toBe('gpt-4o-mini');
    expect(sent.baseUrl).toBe('https://api.openai.com/v1');
    expect(sent.timeoutMs).toBeGreaterThan(12000); // not the ghost-text budget
    const wire = JSON.stringify(sent.messages);
    expect(wire).not.toContain(VERCEL_TOKEN);
    expect(wire).not.toContain(OPENAI_KEY);
    expect(wire).toContain('[redacted');
    expect(result.text).toBe('Your token was refused. Reconnect the account.');
    expect(result.provider).toBe('openai');
    expect(result.hints.map((h) => h.id)).toContain('auth');
  });

  it('masks a secret the model echoes back', async () => {
    const hosting = hostingFixture({ logs: 'build failed' });
    const svc = createDeployDiagnostics({
      hosting,
      ai: { complete: async () => ({ text: `Try again with ${NETLIFY_TOKEN} set properly.` }) },
      settings: settingsFixture,
      secretStore: { getSecret: async () => NETLIFY_TOKEN },
    });
    const result = await svc.diagnose({ runId: 'run_1' });
    expect(result.text).not.toContain(NETLIFY_TOKEN);
    expect(JSON.stringify(result)).not.toContain(NETLIFY_TOKEN);
  });

  it('still answers from local causes when no assistant is configured', async () => {
    const hosting = hostingFixture({ logs: 'Missing environment variable: API_URL' });
    const svc = createDeployDiagnostics({ hosting, settings: settingsFixture });
    const result = await svc.diagnose({ runId: 'run_1' });
    expect(result.text).toBe('');
    expect(result.reason).toBe('no-ai-service');
    expect(result.hints.map((h) => h.id)).toContain('missing-env');
    expect(result.evidence.text).toContain('PROVIDER BUILD LOG');
  });

  it('passes the assistant\'s own excuse through when it cannot answer', async () => {
    const hosting = hostingFixture({ logs: '401 Unauthorized' });
    const svc = createDeployDiagnostics({
      hosting,
      ai: { complete: async () => ({ text: '', reason: 'You are signed out. Sign in to use the assistant.' }) },
      settings: settingsFixture,
    });
    const result = await svc.diagnose({ runId: 'run_1' });
    expect(result.text).toBe('');
    expect(result.reason).toBe('You are signed out. Sign in to use the assistant.');
    expect(result.hints.map((h) => h.id)).toContain('auth');
  });

  it('diagnoses without the host log when the provider cannot supply it', async () => {
    const hosting = hostingFixture({ logThrows: true });
    const svc = createDeployDiagnostics({
      hosting,
      ai: { complete: async () => ({ text: 'Reconnect the account.' }) },
      settings: settingsFixture,
    });
    const result = await svc.diagnose({ runId: 'run_1' });
    expect(result.logError).toBe('host log unavailable');
    expect(result.text).toBe('Reconnect the account.');
    expect(result.evidence.text).not.toContain('PROVIDER BUILD LOG');
  });

  it('reads settings without a token stored, and never asks for one it does not have', async () => {
    const hosting = hostingFixture({ logs: '' });
    const getSecret = vi.fn(async () => null);
    const svc = createDeployDiagnostics({
      hosting,
      ai: { complete: async () => ({ text: 'ok' }) },
      settings: settingsFixture,
      secretStore: { getSecret },
    });
    const result = await svc.diagnose({ runId: 'run_1' });
    expect(getSecret).toHaveBeenCalledWith('hosting-vercel-token');
    expect(result.text).toBe('ok');
  });

  it('survives a settings store that cannot be read', async () => {
    const svc = createDeployDiagnostics({
      hosting: hostingFixture({ logs: 'npm ERR! code 1' }),
      ai: { complete: async () => ({ text: 'Fix the build script first.' }) },
      settings: { load: async () => { throw new Error('settings unreadable'); } },
    });
    const result = await svc.diagnose({ runId: 'run_1' });
    expect(result.text).toBe('Fix the build script first.');
    expect(result.hints.map((h) => h.id)).toContain('build-command');
  });
});
