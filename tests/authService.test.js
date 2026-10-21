/**
 * authService tests: local email sign-in mints a per-email token + a 1000M
 * starter budget, quota is metered by consume(), and state survives reloads.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthService, STARTING_QUOTA } from '../electron/services/authService';

const logger = { info: () => {}, warn: () => {}, error: () => {} };

function tempPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-auth-')), 'accounts.json');
}

describe('authService.signIn', () => {
  it('rejects invalid emails', async () => {
    const auth = createAuthService({ filePath: tempPath(), logger });
    await expect(auth.signIn({ email: 'nope' })).rejects.toThrow(/valid email/i);
    await expect(auth.signIn({})).rejects.toThrow(/valid email/i);
  });

  it('grants a token and the 1000M starter budget, and normalizes the email', async () => {
    const auth = createAuthService({ filePath: tempPath(), logger });
    const account = await auth.signIn({ email: '  Ada@Example.COM ' });
    expect(account.email).toBe('ada@example.com');
    expect(account.tokensQuota).toBe(STARTING_QUOTA);
    expect(account.tokensRemaining).toBe(1_000_000_000);
    expect(account.token).toMatch(/^nova_/);
    expect(account.name).toBe('Ada');
  });

  it('re-signing with the same email keeps the token and budget', async () => {
    const filePath = tempPath();
    const auth = createAuthService({ filePath, logger });
    const first = await auth.signIn({ email: 'ada@example.com' });
    await auth.consume({ tokens: 500 });
    const second = createAuthService({ filePath, logger });
    const again = await second.signIn({ email: 'ada@example.com' });
    expect(again.token).toBe(first.token);
    expect(again.tokensUsed).toBe(500);
  });
});

describe('authService quota', () => {
  it('meters usage down from the budget', async () => {
    const auth = createAuthService({ filePath: tempPath(), logger });
    await auth.signIn({ email: 'ada@example.com' });
    const result = await auth.consume({ tokens: 1200 });
    expect(result.ok).toBe(true);
    expect(result.remaining).toBe(1_000_000_000 - 1200);
    const account = await auth.getAccount();
    expect(account.tokensUsed).toBe(1200);
  });

  it('refuses to overdraw the budget', async () => {
    const auth = createAuthService({ filePath: tempPath(), logger, startingQuota: 100 });
    await auth.signIn({ email: 'ada@example.com' });
    expect((await auth.hasQuota()).ok).toBe(true);
    const tooBig = await auth.consume({ tokens: 150 });
    expect(tooBig.ok).toBe(false);
    expect(tooBig.error).toMatch(/exhausted/i);
    const exact = await auth.consume({ tokens: 100 });
    expect(exact.ok).toBe(true);
    expect(exact.remaining).toBe(0);
    expect((await auth.hasQuota()).ok).toBe(false);
  });

  it('reports signed-out state', async () => {
    const auth = createAuthService({ filePath: tempPath(), logger });
    expect(await auth.getAccount()).toBeNull();
    expect((await auth.consume({ tokens: 5 })).ok).toBe(false);
    await auth.signIn({ email: 'ada@example.com' });
    await auth.signOut();
    expect(await auth.getAccount()).toBeNull();
  });
});

describe('authService.listAccounts', () => {
  it('returns display-safe emails (no tokens), most recently used first', async () => {
    const auth = createAuthService({ filePath: tempPath(), logger });
    expect(await auth.listAccounts()).toEqual([]);
    await auth.signIn({ email: 'ada@example.com', name: 'Ada' });
    await auth.consume({ tokens: 1 });
    await new Promise((r) => setTimeout(r, 5));
    await auth.signIn({ email: 'grace@example.com', name: 'Grace' });
    const list = await auth.listAccounts();
    expect(list.map((a) => a.email)).toEqual(['grace@example.com', 'ada@example.com']);
    expect(list[1]).toEqual({ email: 'ada@example.com', name: 'Ada' });
    expect(JSON.stringify(list)).not.toMatch(/nova_/);
  });
});
