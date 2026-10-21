// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { signInLocal, getAccountLocal, signOutLocal } from '../src/services/localAccount';

beforeEach(() => {
  localStorage.clear();
});

describe('localAccount (browser-mode sign-in fallback)', () => {
  it('mints a per-email token and the 1,000M starter budget on first sign-in', () => {
    const account = signInLocal({ email: 'Ada@Example.com' });
    expect(account.email).toBe('ada@example.com');
    expect(account.name).toBe('Ada'); // default name from the raw local part
    expect(account.token).toMatch(/^nova_/);
    expect(account.tokensQuota).toBe(1_000_000_000);
    expect(account.tokensRemaining).toBe(1_000_000_000);
  });

  it('reuses the same token for a returning email and tracks the current account', () => {
    const first = signInLocal({ email: 'a@b.com', name: 'A' });
    expect(getAccountLocal().token).toBe(first.token);
    signInLocal({ email: 'c@d.com' });
    expect(getAccountLocal().email).toBe('c@d.com');
    const again = signInLocal({ email: 'a@b.com' });
    expect(again.token).toBe(first.token);
  });

  it('rejects an invalid email', () => {
    expect(() => signInLocal({ email: 'not-an-email' })).toThrow(/valid email/i);
  });

  it('signs out without deleting the stored account', () => {
    const account = signInLocal({ email: 'a@b.com' });
    expect(signOutLocal()).toEqual({ ok: true });
    expect(getAccountLocal()).toBeNull();
    // Same token is reissued on the next sign-in because the record is kept.
    expect(signInLocal({ email: 'a@b.com' }).token).toBe(account.token);
  });
});
