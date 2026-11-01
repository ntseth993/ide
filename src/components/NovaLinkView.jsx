/**
 * NovaLink Live — entry surface used by App.jsx.
 *
 * The real implementation lives in `src/components/NovaLinkLive/*`. This
 * module is a thin wrapper whose only job is to decide whether to mount the
 * developer diagnostics panel, based on the current settings blob and an env
 * override the packaged build can bake in. Ordinary users see only the chat
 * workspace (or, when signed out, the auth screen).
 *
 * Gate: `settings.developer.novalinkDiagnostics === true` OR
 *       `window.__novaEnv?.NOVALINK_DEV === '1'` (dev-mode build flag).
 */
import NovaLinkLiveRoot from './NovaLinkLive/NovaLinkLiveRoot';

function diagnosticsEnabled() {
  try {
    if (typeof window !== 'undefined' && window.__novaEnv?.NOVALINK_DEV === '1') return true;
  } catch {
    // jsdom or CSP-blocked access — treat as off.
  }
  try {
    // settings are also mirrored into localStorage by useSettings so we can
    // read the flag synchronously at mount time without prop-drilling the
    // whole tree. The Root re-renders whenever the store emits, but the gate
    // is stable enough to read once per mount.
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('novacode-settings') : null;
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return Boolean(parsed?.developer?.novalinkDiagnostics);
  } catch {
    return false;
  }
}

export default function NovaLinkView(props) {
  const showDiagnostics = diagnosticsEnabled();
  return <NovaLinkLiveRoot {...props} showDiagnostics={showDiagnostics} />;
}
