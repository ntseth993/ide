/**
 * oauthProviders unit tests: PKCE challenge, authorize-URL building, config
 * resolution from env, and the token-exchange / userinfo fetch shapes (mocked).
 */
import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import {
  OAUTH_PROVIDERS,
  providerList,
  getOAuthConfig,
  createPkce,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserInfo,
} from '../electron/services/oauthProviders';

describe('oauthProviders catalog', () => {
  it('exposes Google, GitHub and Microsoft', () => {
    expect(providerList().map((p) => p.id).sort()).toEqual(['github', 'google', 'microsoft']);
  });

  it('requires a client secret only for GitHub', () => {
    expect(getOAuthConfig('github', {})).toBeNull();
    expect(getOAuthConfig('github', { NOVACODE_GITHUB_CLIENT_ID: 'cid' })).toBeNull();
    expect(getOAuthConfig('github', { NOVACODE_GITHUB_CLIENT_ID: 'cid', NOVACODE_GITHUB_CLIENT_SECRET: 'sec' })).toMatchObject({ clientId: 'cid', clientSecret: 'sec' });
    expect(getOAuthConfig('google', { NOVACODE_GOOGLE_CLIENT_ID: 'cid' })).toMatchObject({ clientId: 'cid', clientSecret: null });
    expect(getOAuthConfig('google', {})).toBeNull();
    expect(getOAuthConfig('nope', { NOVACODE_NOPE_CLIENT_ID: 'cid' })).toBeNull();
  });
});

describe('PKCE + authorize URL', () => {
  it('creates an S256 challenge that hashes to the verifier', () => {
    const { verifier, challenge, method } = createPkce();
    expect(method).toBe('S256');
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
  });

  it('builds an authorize URL with the loopback redirect and challenge', () => {
    const url = buildAuthorizeUrl({
      def: OAUTH_PROVIDERS.google,
      clientId: 'cid',
      redirectUri: 'http://127.0.0.1:5000/callback',
      state: 'st-123',
      codeChallenge: 'chal',
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://accounts.google.com');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('cid');
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5000/callback');
    expect(parsed.searchParams.get('state')).toBe('st-123');
    expect(parsed.searchParams.get('code_challenge')).toBe('chal');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('scope')).toContain('email');
  });
});

describe('token exchange + userinfo', () => {
  it('posts the code + verifier and returns the access token', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'tok-9' }) }));
    const token = await exchangeCode({
      def: OAUTH_PROVIDERS.google,
      clientId: 'cid',
      clientSecret: null,
      code: 'auth-code',
      redirectUri: 'http://127.0.0.1/callback',
      codeVerifier: 'ver',
      fetchImpl,
    });
    expect(token).toBe('tok-9');
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe(OAUTH_PROVIDERS.google.tokenUrl);
    expect(opts.method).toBe('POST');
    expect(opts.body).toMatch('code_verifier=ver');
    expect(opts.body).toMatch('code=auth-code');
  });

  it('throws when the provider returns an OAuth error', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ error: 'invalid_grant' }) }));
    await expect(exchangeCode({
      def: OAUTH_PROVIDERS.google, clientId: 'cid', code: 'c', redirectUri: 'r', codeVerifier: 'v', fetchImpl,
    })).rejects.toThrow(/invalid_grant/);
  });

  it('maps provider profile fields to email + name', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ login: 'octocat', name: 'The Octocat', avatar_url: 'a.png' }) }));
    const profile = await fetchUserInfo({ def: OAUTH_PROVIDERS.github, accessToken: 'tok', fetchImpl });
    expect(profile.email).toBe('octocat@users.noreply.github.com');
    expect(profile.name).toBe('The Octocat');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('errors when the profile has no usable email', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    await expect(fetchUserInfo({ def: OAUTH_PROVIDERS.github, accessToken: 'tok', fetchImpl })).rejects.toThrow(/no usable email/i);
  });
});
