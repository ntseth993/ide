/**
 * Sign-in dialog with two modes:
 *
 * - "browser" (Electron): the default browser was opened at a loopback sign-in
 *   page. This is the hand-off screen — it shows the page URL, lets you reopen
 *   it, and waits. The session arrives via the main process (App onAuthSession)
 *   and closes this dialog automatically.
 * - "form" (browser preview / no bridge): there is no separate browser to open,
 *   so we collect the email here and sign in against the renderer-side account
 *   store.
 */
import { useEffect, useRef, useState } from 'react';
import { SparkleIcon, CloseIcon } from './Icons';
import { formatExact } from '../utils/tokens';

const STARTER_BUDGET = 1_000_000_000;

function Perks() {
  return (
    <div className="signin-perks">
      <div className="perk">
        <strong>{formatExact(STARTER_BUDGET)}</strong>
        <span className="muted tiny">starter tokens</span>
      </div>
      <div className="perk">
        <strong>Personal</strong>
        <span className="muted tiny">API token issued per email</span>
      </div>
      <div className="perk">
        <strong>Local-first</strong>
        <span className="muted tiny">nothing leaves this device</span>
      </div>
    </div>
  );
}

function BrowserMode({ url, error, onOpen, onCancel }) {
  return (
    <>
      <div className="signin-brand">
        <span className="signin-logo"><SparkleIcon size={22} /></span>
        <h2>Continue in your browser</h2>
        <p className="muted">We opened your default browser. Sign in there with your email to get your token.</p>
      </div>

      <div className="signin-waiting">
        <span className="signin-spinner" role="status" aria-label="Waiting for sign-in" />
        <div className="signin-waiting-text">
          <strong>Waiting for you to finish…</strong>
          <p className="muted tiny">This window closes on its own once you&rsquo;ve signed in.</p>
        </div>
      </div>

      {url ? (
        <div className="signin-url" title={url}>
          <span className="muted tiny">If the browser didn&rsquo;t open, go to:</span>
          <code>{url}</code>
        </div>
      ) : null}

      {error && <p className="signin-error" role="alert">{error}</p>}

      <div className="signin-actions">
        <button type="button" className="primary signin-submit" onClick={onOpen}>
          Open sign-in page
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>

      <Perks />
      <p className="signin-note muted tiny">
        Your token and budget are created on this device — no account server is contacted.
      </p>
    </>
  );
}

function FormMode({ error, onSubmit, onCancel }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const emailRef = useRef(null);

  useEffect(() => {
    const timer = setTimeout(() => emailRef.current?.focus?.(), 40);
    return () => clearTimeout(timer);
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) return;
    const clean = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      setLocalError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    setLocalError('');
    try {
      await onSubmit(clean, name.trim());
      setEmail('');
      setName('');
    } catch (submitError) {
      setLocalError(submitError?.message || 'Sign in failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const shown = localError || error;

  return (
    <>
      <div className="signin-brand">
        <span className="signin-logo"><SparkleIcon size={22} /></span>
        <h2>Welcome to NovaCode</h2>
        <p className="muted">Sign in to power the AI assistant.</p>
      </div>

      <form onSubmit={handleSubmit} className="signin-form">
        <label htmlFor="signin-email">Email</label>
        <input
          id="signin-email"
          ref={emailRef}
          type="email"
          value={email}
          autoComplete="email"
          placeholder="you@example.com"
          onChange={(event) => setEmail(event.target.value)}
        />

        <label htmlFor="signin-name">Display name <span className="muted">(optional)</span></label>
        <input
          id="signin-name"
          type="text"
          value={name}
          autoComplete="name"
          placeholder="Ada Lovelace"
          onChange={(event) => setName(event.target.value)}
        />

        {shown && <p className="signin-error" role="alert">{shown}</p>}

        <div className="signin-actions">
          <button type="submit" className="primary signin-submit" disabled={busy || !email.trim()}>
            {busy ? 'Signing in…' : 'Sign in & get started'}
          </button>
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>

      <Perks />
      <p className="signin-note muted tiny">
        You&rsquo;re in browser preview mode, so your token and budget are created on this device — no account server is contacted.
      </p>
    </>
  );
}

export default function SignInDialog({ open, mode = 'browser', url, error, onOpen, onSubmit, onCancel }) {
  useEffect(() => {
    if (!open) return undefined;
    function onKey(event) {
      if (event.key === 'Escape') onCancel?.();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="overlay signin-overlay" role="dialog" aria-modal="true" aria-label="Sign in to NovaCode">
      <div className="signin-card">
        <button type="button" className="icon-button signin-close" aria-label="Cancel sign-in" onClick={onCancel}>
          <CloseIcon size={16} />
        </button>
        {mode === 'form'
          ? <FormMode error={error} onSubmit={onSubmit} onCancel={onCancel} />
          : <BrowserMode url={url} error={error} onOpen={onOpen} onCancel={onCancel} />}
      </div>
    </div>
  );
}
