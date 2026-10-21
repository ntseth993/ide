/**
 * Account widget for the top-right of the menu bar (the "person" button in the
 * screenshot). Shows a sign-in prompt when signed out; when signed in it reveals
 * the email, plan, remaining token budget, and the per-account API token.
 */
import { useEffect, useRef, useState } from 'react';
import { UserIcon, SignOutIcon } from './Icons';
import { formatTokens, formatExact, maskToken } from '../utils/tokens';

export default function AccountMenu({ account, onSignIn, onSignOut }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    }
    function onKey(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function copyToken() {
    try {
      await navigator.clipboard?.writeText(account.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  }

  const initials = (account?.name || account?.email || '?')
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || '?';

  return (
    <div className="account-menu" ref={ref}>
      <button
        type="button"
        className={open ? 'account-trigger open' : 'account-trigger'}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Account"
        title={account ? `Signed in as ${account.email}` : 'Sign in'}
        onClick={() => setOpen((value) => !value)}
      >
        {account ? <span className="account-avatar">{initials}</span> : <UserIcon size={17} />}
      </button>

      {open && (
        <div className="account-dropdown" role="menu" aria-label="Account">
          {account ? (
            <>
              <div className="account-head">
                <span className="account-avatar lg">{initials}</span>
                <div className="account-id">
                  <strong>{account.name}</strong>
                  <span className="muted tiny">{account.email}</span>
                </div>
              </div>

              <div className="account-quota">
                <div className="quota-row">
                  <span className="muted">Plan</span>
                  <span className="quota-plan">{account.plan}</span>
                </div>
                <div className="quota-row">
                  <span className="muted">Tokens left</span>
                  <strong title={`${formatExact(account.tokensRemaining)} of ${formatExact(account.tokensQuota)}`}>
                    {formatTokens(account.tokensRemaining)}
                  </strong>
                </div>
                <div className="quota-bar" aria-hidden="true">
                  <span
                    className="quota-bar-fill"
                    style={{ width: `${Math.min(100, (account.tokensRemaining / (account.tokensQuota || 1)) * 100)}%` }}
                  />
                </div>
              </div>

              <button type="button" className="account-token" onClick={copyToken} title="Copy your API token">
                <span className="muted">API token</span>
                <code>{copied ? 'Copied!' : maskToken(account.token)}</code>
              </button>

              <div className="menu-sep" role="separator" />
              <button
                type="button"
                className="account-action"
                onClick={() => { setOpen(false); onSignOut?.(); }}
              >
                <SignOutIcon size={15} /> Sign out
              </button>
            </>
          ) : (
            <div className="account-signed-out">
              <p className="tiny muted">Sign in to get a personal API token and a 1,000M-token starter budget for the assistant.</p>
              <button
                type="button"
                className="primary account-signin"
                onClick={() => { setOpen(false); onSignIn?.(); }}
              >
                <UserIcon size={15} /> Sign in
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
