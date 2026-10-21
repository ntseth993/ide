/**
 * OAuth 2.0 identity providers (Authorization Code + PKCE).
 *
 * NovaCode's sign-in runs a loopback HTTP server (see authFlow.js) that opens
 * the system browser. For a real provider sign-in we redirect that same browser
 * to the provider's authorize endpoint with a PKCE code_challenge; the provider
 * sends the user back to our /callback with an authorization code, which we
 * exchange for an access token and use to read the account's email/profile.
 *
 * A provider is "live" only when its client id is configured via env:
 *   NOVACODE_GOOGLE_CLIENT_ID       (+ NOVACODE_GOOGLE_CLIENT_SECRET, optional)
 *   NOVACODE_GITHUB_CLIENT_ID       + NOVACODE_GITHUB_CLIENT_SECRET   (required)
 *   NOVACODE_MICROSOFT_CLIENT_ID    (+ NOVACODE_MICROSOFT_CLIENT_SECRET, optional)
 * When unconfigured, authFlow falls back to a local demo account so the UI
 * still completes.
 */
const crypto = require('crypto');

const OAUTH_PROVIDERS = {
  google: {
    id: 'google',
    label: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    requiresSecret: false,
    extraAuthorizeParams: { access_type: 'online', prompt: 'select_account' },
    mapUser: (u) => ({ email: u.email, name: u.name || u.given_name || u.email, picture: u.picture }),
  },
  github: {
    id: 'github',
    label: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userInfoUrl: 'https://api.github.com/user',
    scope: 'read:user user:email',
    requiresSecret: true, // GitHub's token endpoint requires the client secret.
    mapUser: (u) => ({
      email: u.email || (u.login ? `${u.login}@users.noreply.github.com` : null),
      name: u.name || u.login,
      picture: u.avatar_url,
    }),
  },
  microsoft: {
    id: 'microsoft',
    label: 'Microsoft',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
    scope: 'openid email profile User.Read',
    requiresSecret: false,
    mapUser: (u) => ({ email: u.mail || u.userPrincipalName, name: u.displayName || u.mail || u.userPrincipalName }),
  },
};

function providerList() {
  return Object.values(OAUTH_PROVIDERS).map((def) => ({ id: def.id, label: def.label }));
}

function envKey(providerId) {
  return String(providerId).toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** Resolve a provider's client credentials from env, or null if not live. */
function getOAuthConfig(providerId, env = process.env) {
  const def = OAUTH_PROVIDERS[providerId];
  if (!def) return null;
  const key = envKey(providerId);
  const clientId = env[`NOVACODE_${key}_CLIENT_ID`];
  const clientSecret = env[`NOVACODE_${key}_CLIENT_SECRET`];
  if (!clientId) return null;
  if (def.requiresSecret && !clientSecret) return null;
  return { def, clientId, clientSecret: clientSecret || null };
}

function createPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

function buildAuthorizeUrl({ def, clientId, redirectUri, state, codeChallenge }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: def.scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    ...(def.extraAuthorizeParams || {}),
  });
  return `${def.authorizeUrl}?${params.toString()}`;
}

async function exchangeCode({ def, clientId, clientSecret, code, redirectUri, codeVerifier, fetchImpl }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  if (clientSecret) body.set('client_secret', clientSecret);
  const doFetch = fetchImpl || fetch;
  const res = await doFetch(def.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`${def.label} token exchange failed (${res.status}).`);
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);
  if (!data.access_token) throw new Error(`${def.label} returned no access token.`);
  return data.access_token;
}

async function fetchUserInfo({ def, accessToken, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const res = await doFetch(def.userInfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Could not read your ${def.label} profile (${res.status}).`);
  const data = await res.json();
  const mapped = def.mapUser(data) || {};
  if (!mapped.email) throw new Error(`Your ${def.label} account has no usable email address.`);
  return { email: mapped.email, name: mapped.name || mapped.email, picture: mapped.picture || null };
}

module.exports = {
  OAUTH_PROVIDERS,
  providerList,
  getOAuthConfig,
  createPkce,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserInfo,
};
