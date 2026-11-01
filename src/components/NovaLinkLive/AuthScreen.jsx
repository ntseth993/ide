/**
 * NovaLink Live sign-in / registration card.
 *
 * Ordinary entry surface for the chat workspace. Two tabs (Sign in and Create
 * account) so the user has one mental model: this is a chat identity, separate
 * from the NovaCode AI account. Errors come back from the main process already
 * humanised by `toUserMessage`, and the password field is wiped on every
 * submit — the credential that survives lives in the OS secret store, not here.
 */
import { useState } from 'react';
import { client, toUserMessage } from '../../services/novaClient';

const TABS = [
  { id: 'signin', label: 'Sign in' },
  { id: 'register', label: 'Create account' },
];

export default function AuthScreen({ status, onSignedIn, onNotify }) {
  const [tab, setTab] = useState('signin');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const configured = Boolean(status?.configured);
  const trimmedUser = username.trim();
  const canSubmit = !busy && trimmedUser.length > 0 && password.length > 0;

  async function submit(event) {
    event?.preventDefault?.();
    if (!canSubmit) return;
    if (!configured) {
      setError('NovaLink is not configured. Start the link-server (npm run link:dev) or set NOVALINK_LIVE_URL before building.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const payload = { username: trimmedUser, password };
      if (tab === 'register') {
        payload.displayName = displayName.trim() || undefined;
      }
      const result = tab === 'register'
        ? await client.novalinkLiveRegister(payload)
        : await client.novalinkLiveLogin(payload);
      setPassword('');
      onNotify?.({ tone: 'ok', message: tab === 'register' ? 'NovaLink account created.' : 'Signed in to NovaLink.' });
      onSignedIn?.(result);
    } catch (caught) {
      setError(toUserMessage(caught, tab === 'register' ? 'Registration failed.' : 'Sign in failed.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="novalink-auth">
      <div className="novalink-auth-card">
        <h2 className="novalink-auth-title">NovaLink</h2>
        <p className="novalink-auth-subtitle" id="novalink-auth-warning">
          {configured
            ? 'Sign in to chat with other NovaCode users.'
            : 'NovaLink is not configured on this build. An administrator needs to set the server URL before accounts can be created.'}
        </p>
        <div className="novalink-auth-tabs" role="tablist">
          {TABS.map((entry) => (
            <button
              type="button"
              key={entry.id}
              role="tab"
              aria-selected={tab === entry.id}
              className={`novalink-auth-tab ${tab === entry.id ? 'active' : ''}`}
              onClick={() => setTab(entry.id)}
              disabled={busy}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <form className="novalink-auth-form" onSubmit={submit}>
          <label className="field">
            <span>username</span>
            <input
              type="text"
              id="novalink-auth-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="alice"
              autoComplete="username"
              disabled={busy}
              aria-describedby={!configured ? 'novalink-auth-warning' : undefined}
              autoFocus
            />
          </label>
          {tab === 'register' ? (
            <label className="field">
              <span>display name (optional)</span>
              <input
                type="text"
                id="novalink-auth-displayname"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Alice"
                autoComplete="name"
                disabled={busy}
              />
            </label>
          ) : null}
          <label className="field">
            <span>password</span>
            <input
              type="password"
              id="novalink-auth-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
              disabled={busy}
              aria-describedby={!configured ? 'novalink-auth-warning' : undefined}
            />
          </label>
          {tab === 'register' ? (
            <p className="hint">Password is stored only as a hashed verifier on the server. Your session token lives in the OS credential vault.</p>
          ) : null}
          {error ? <p className="novalink-auth-error" role="alert">{error}</p> : null}
          <button
            type="submit"
            className="primary"
            disabled={!canSubmit}
          >
            {busy ? 'Please wait…' : tab === 'register' ? 'Create account' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
