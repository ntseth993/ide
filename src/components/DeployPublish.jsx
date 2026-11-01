/**
 * Deploy › Publish — real one-click deployment to Vercel or Netlify.
 *
 * This is the dashboard half of the Deploy workspace: it connects the
 * developer's OWN hosting account, reviews what is about to be sent, runs the
 * deployment, and reports the provider's real answer.
 *
 * What it deliberately does not do:
 *   - hold a credential. The access token is typed once, sent to
 *     `deploy:connect`, and stored encrypted by the main process. Nothing here
 *     can read it back, and it never lands in localStorage.
 *   - invent a URL. The public address only appears when the provider's own
 *     status call reports `ready`; while a build is running or after a failure
 *     there is nothing to open, and the panel says so.
 *   - paper over a provider's limits. A host that cannot build the project's
 *     framework is reported as a blocker with the alternative, not deployed as
 *     a half-working static site.
 *
 * Every value goes through the named, argument-checked IPC channels in
 * electron/ipc/registerIpc.js; this file has no Node access at all.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { client, isDesktop, toUserMessage } from '../services/novaClient';
import { ConfirmDialog } from './Dialogs';
import {
  RocketIcon, RefreshIcon, CheckIcon, StopIcon, GlobeIcon,
  ExternalLinkIcon, KeyIcon, TrashIcon, SparkleIcon,
} from './Icons';

// Order the pipeline runs through, for the status timeline. `configuring`
// (env vars) and `canceled`/`failed` are reported by name but not steps.
const PHASE_ORDER = ['validating', 'configuring', 'building', 'packing', 'uploading', 'deploying', 'live'];
const PHASE_LABELS = {
  validating: 'Validate', configuring: 'Configure', building: 'Build', packing: 'Package',
  uploading: 'Upload', deploying: 'Deploy', live: 'Live', failed: 'Failed', canceled: 'Cancelled',
};
const STATE_LABELS = {
  queued: 'Queued', building: 'Building', ready: 'Live', error: 'Failed', canceled: 'Cancelled',
};
const MAX_LOG_LINES = 300;

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function timeAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * Why the assistant stayed silent, in the developer's terms. `reason` reaching the
 * panel can also be a full sentence from the account gate ("You are signed out…"),
 * which is shown verbatim rather than replaced by a guess.
 */
const DIAGNOSIS_REASONS = {
  'no-key': 'no API key is configured for your assistant',
  'no-ai-service': 'no assistant is available in this build',
  invalid: 'the request could not be prepared',
  empty: 'the assistant returned no text',
  error: 'the assistant could not be reached',
};

function diagnosisAttribution(d) {
  if (d.text) {
    const who = [d.provider, d.model].filter(Boolean).join(' · ');
    return who ? `Written by ${who}` : 'Written by your assistant';
  }
  return 'NovaCode built-in causes';
}

function diagnosisFallback(d) {
  const why = DIAGNOSIS_REASONS[d.reason] || (d.reason ? `the assistant said: ${d.reason}` : 'no answer was returned');
  return `Answered from NovaCode's own failure checks instead — ${why}.`;
}

/** Merge one streamed deploy:event into the run snapshot the panel renders. */
function applyEvent(prev, event) {
  if (!event || !event.runId) return prev;
  const base = prev && prev.runId === event.runId ? prev : { runId: event.runId, logLines: [] };
  const next = { ...base };
  if (event.type === 'start') {
    next.logLines = [];
    next.publicUrl = null;
    next.deploymentId = null;
    next.dashboardUrl = null;
  }
  for (const key of ['phase', 'state', 'message', 'publicUrl', 'deploymentId', 'dashboardUrl', 'progress', 'provider']) {
    if (event[key] !== undefined) next[key] = event[key];
  }
  if (event.type === 'log') {
    const lines = [...(base.logLines || []), event.line];
    next.logLines = lines.slice(-MAX_LOG_LINES);
  }
  return next;
}

export default function DeployPublish({ root, buildCommand, outputDir, onNotify }) {
  const [providers, setProviders] = useState([]);
  const [connections, setConnections] = useState([]);
  const [providerId, setProviderId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [project, setProject] = useState('');
  const [projects, setProjects] = useState([]);
  const [plan, setPlan] = useState(null);
  const [planning, setPlanning] = useState(false);
  const [connecting, setConnecting] = useState(null); // provider id whose form is open
  const [tokenDraft, setTokenDraft] = useState('');
  const [envValues, setEnvValues] = useState({});
  const [production, setProduction] = useState(true);
  const [approvedBuild, setApprovedBuild] = useState(false);
  const [approvedFrontendOnly, setApprovedFrontendOnly] = useState(false);
  const [run, setRun] = useState(null);
  const [history, setHistory] = useState([]);
  const [remoteLog, setRemoteLog] = useState('');
  const [domainInfo, setDomainInfo] = useState(null);
  const [error, setError] = useState('');
  const [clearOpen, setClearOpen] = useState(false);
  // Written explanation of the current failed run, plus whether one is being asked
  // for. Both are cleared the moment a new deploy starts, so an old diagnosis can
  // never sit under a newer result.
  const [diagnosis, setDiagnosis] = useState(null);
  const [diagnosing, setDiagnosing] = useState(false);

  const hasRoot = Boolean(root);
  const connection = useMemo(() => connections.find((c) => c.id === providerId) || null, [connections, providerId]);
  const descriptor = useMemo(() => providers.find((p) => p.id === providerId) || null, [providers, providerId]);
  const running = Boolean(run && !['ready', 'error', 'canceled'].includes(run.state));
  const failedRun = Boolean(run && !running && ['error', 'canceled'].includes(run.state) && run.runId);
  // An explanation belongs to the run it was written for. The panel can change runs
  // without a click (a redeploy from history, a re-attached live run), so this is
  // checked at render time rather than remembered by every code path that swaps `run`.
  const shownDiagnosis = diagnosis && run && diagnosis.runId === run.runId ? diagnosis : null;

  const loadConnections = useCallback(async () => {
    if (!isDesktop) return;
    try { setConnections(await client.deployConnections()); } catch { /* panel still renders the choice */ }
  }, []);

  const loadHistory = useCallback(async () => {
    if (!isDesktop || !hasRoot) return;
    try { setHistory(await client.deployHistory({ root })); } catch { /* history is optional */ }
  }, [hasRoot, root]);

  // Providers + remembered defaults + any run still going in the main process.
  useEffect(() => {
    if (!isDesktop) return;
    let active = true;
    (async () => {
      try {
        const [list, prefs, runs] = await Promise.all([
          client.deployProviders(), client.deployPreferences(), client.deployRuns(),
        ]);
        if (!active) return;
        setProviders(Array.isArray(list) ? list : []);
        const usable = (Array.isArray(list) ? list : []).filter((p) => p.available);
        const remembered = usable.find((p) => p.id === prefs.provider);
        const connectedFirst = usable.find((p) => p.id !== prefs.provider);
        setProviderId((cur) => cur || (remembered || connectedFirst || usable[0] || {}).id || '');
        if (prefs.provider && prefs.teams) setTeamId((cur) => cur || prefs.teams[prefs.provider] || '');
        const live = (Array.isArray(runs) ? runs : []).find((r) => !r.final);
        if (live) setRun(live);
      } catch (err) {
        if (active) setError(toUserMessage(err));
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => { loadConnections(); loadHistory(); }, [loadConnections, loadHistory]);

  // Streamed progress for the window that started the deploy.
  useEffect(() => {
    if (!isDesktop) return undefined;
    return client.onDeployEvent((event) => {
      setRun((prev) => applyEvent(prev, event));
      if (event && event.state === 'ready') onNotify?.('Deployment is live', 'ok');
      if (event && event.state === 'error') onNotify?.('Deployment failed', 'error');
    });
  }, [onNotify]);

  // The plan is the review screen's data: re-read it whenever the inputs that
  // change it move, so what is shown is what would actually be sent.
  const loadPlan = useCallback(async () => {
    if (!isDesktop || !hasRoot || !providerId) { setPlan(null); return; }
    setPlanning(true);
    try {
      setPlan(await client.deployPlan({ root, provider: providerId, teamId: teamId || undefined, project: project || undefined }));
      setError('');
    } catch (err) {
      setError(toUserMessage(err));
      setPlan(null);
    } finally {
      setPlanning(false);
    }
  }, [hasRoot, providerId, project, root, teamId]);

  useEffect(() => { loadPlan(); }, [loadPlan]);

  // Existing projects/sites on the connected account, so a deploy can reuse one.
  useEffect(() => {
    if (!isDesktop || !connection?.connected || !providerId) { setProjects([]); return; }
    let active = true;
    client.deployProjects({ provider: providerId, teamId: teamId || undefined })
      .then((list) => { if (active) setProjects(Array.isArray(list) ? list : []); })
      .catch(() => { if (active) setProjects([]); });
    return () => { active = false; };
  }, [connection?.connected, providerId, teamId]);

  async function handleConnect(event) {
    event?.preventDefault();
    if (!providerId || !tokenDraft.trim()) { setError('Paste the access token for the selected provider first.'); return; }
    setConnecting(providerId);
    setError('');
    try {
      const result = await client.deployConnect({ provider: providerId, token: tokenDraft.trim() });
      setTokenDraft('');
      setConnecting(null);
      setConnections((rows) => rows.map((row) => (row.id === providerId
        ? { ...row, connected: true, hasToken: true, storage: result.storage, account: result.account, teams: result.teams, error: null }
        : row)));
      // Never default a deploy into a team the developer did not pick.
      if (Array.isArray(result.teams) && result.teams.length === 1) setTeamId(result.teams[0].id);
      onNotify?.(`${result.provider === 'vercel' ? 'Vercel' : 'Netlify'} account connected`, 'ok');
      loadPlan();
    } catch (err) {
      setConnecting(null);
      setError(toUserMessage(err));
    }
  }

  async function handleDisconnect() {
    setError('');
    try {
      await client.deployDisconnect({ provider: providerId });
      setConnections((rows) => rows.map((row) => (row.id === providerId
        ? { ...row, connected: false, hasToken: false, storage: null, account: null, teams: [], error: null } : row)));
      setProjects([]);
      setRun(null);
      onNotify?.('Account disconnected', 'ok');
    } catch (err) { setError(toUserMessage(err)); }
  }

  function startDeploy() {
    setError('');
    const missingEnv = (plan?.env?.missing || []).filter((key) => !(envValues[key] || '').trim());
    if (production && missingEnv.length) {
      setError(`These variables have no value yet: ${missingEnv.join(', ')}. Values go to ${descriptor?.label} only, or deploy as a preview first.`);
      return;
    }
    if (plan?.blockers?.length) { setError(plan.blockers[0]); return; }
    const payload = {
      root,
      provider: providerId,
      teamId: teamId || undefined,
      project: project || undefined,
      buildCommand: plan?.build?.buildCommand || buildCommand || undefined,
      outputDir: plan?.build?.outputDir || outputDir || undefined,
      production,
      rebuild: true,
      confirmProduction: production,
      confirmBuild: plan?.needs?.confirmBuild ? approvedBuild : true,
      acknowledgeFrontendOnly: plan?.profile?.frontendOnly ? approvedFrontendOnly : true,
      envVars: Object.entries(envValues)
        .filter(([, value]) => String(value).trim())
        .map(([key, value]) => ({ key, value })),
    };
    setRun({ runId: null, phase: 'validating', state: 'queued', logLines: [], publicUrl: null });
    setDiagnosis(null);
    client.deployStart(payload)
      .then((snapshot) => {
        setRun(snapshot);
        setEnvValues({}); // values are handed to the host, then dropped here
        loadHistory();
      })
      .catch((err) => {
        setRun(null);
        setError(toUserMessage(err));
      });
  }

  async function redeploy(row) {
    setError('');
    try {
      const snapshot = await client.deployRedeploy({
        root,
        provider: row.provider,
        teamId: row.teamId || undefined,
        production: row.target !== 'preview',
        confirmProduction: row.target !== 'preview',
        confirmBuild: true,
        acknowledgeFrontendOnly: true,
        rebuild: true,
      });
      setRun({ ...snapshot, logLines: [] });
      setDiagnosis(null);
      onNotify?.('Redeploy started', 'ok');
    } catch (err) { setError(toUserMessage(err)); }
  }

  async function handleCancel() {
    if (!run?.runId) return;
    try {
      const result = await client.deployCancel({ runId: run.runId });
      setRun((prev) => ({ ...prev, ...(result.run || {}), canceled: true }));
      onNotify?.(result.providerCancelled ? 'Deployment cancelled on the host' : 'NovaCode stopped the upload', 'ok');
    } catch (err) { setError(toUserMessage(err)); }
  }

  async function handleRefresh() {
    if (!run?.runId) return;
    try {
      const fresh = await client.deployRefresh({ runId: run.runId });
      setRun((prev) => ({ ...prev, ...fresh }));
    } catch (err) { setError(toUserMessage(err)); }
  }

  async function handleProviderLogs() {
    setError('');
    try {
      const result = await client.deployProviderLogs({
        provider: providerId,
        teamId: teamId || undefined,
        deploymentId: run?.deploymentId || undefined,
        project: project || undefined,
      });
      setRemoteLog(result.text || '(no output)');
    } catch (err) { setError(toUserMessage(err)); }
  }

  /**
   * Ask NovaCode why this deploy failed. Nothing is sent anywhere until the
   * developer clicks: the main process collects the run, the host's build log and
   * the local log, strips every credential out of them, and only then asks the
   * assistant already configured for the AI panel. If that assistant is not
   * usable, the same evidence is matched against known failure causes locally,
   * and the panel says which route was taken rather than passing hints off as AI.
   */
  async function handleDiagnose() {
    if (!run?.runId) return;
    const runId = run.runId;
    setError('');
    setDiagnosing(true);
    try {
      const result = await client.deployDiagnose({ runId });
      // Tag the answer here as well: the service echoes the run it read, and a
      // reply that names nothing else cannot be attributed to the visible run.
      setDiagnosis({ runId, ...(result || {}) });
    } catch (err) { setError(toUserMessage(err)); }
    finally { setDiagnosing(false); }
  }

  async function handleDomains() {
    setError('');
    try { setDomainInfo(await client.deployDomains({ provider: providerId, teamId: teamId || undefined, project: project || plan?.project || undefined })); }
    catch (err) { setError(toUserMessage(err)); }
  }

  async function rememberDefaults() {
    try {
      await client.deploySetPreferences({ provider: providerId, teamId: teamId || undefined });
      onNotify?.('Default host saved', 'ok');
    } catch (err) { setError(toUserMessage(err)); }
  }

  async function clearHistory() {
    try {
      await client.deployHistoryClear({ root, confirm: true });
      setHistory([]);
      onNotify?.('Deployment history cleared', 'ok');
    } catch (err) { setError(toUserMessage(err)); }
  }

  const missingEnv = plan?.env?.missing || [];
  const unapprovedGates = [
    plan?.needs?.confirmBuild && !approvedBuild ? 'approval to run the build command' : '',
    plan?.profile?.frontendOnly && !approvedFrontendOnly ? 'acknowledgement that the backend will not be deployed' : '',
  ].filter(Boolean);
  const canDeploy = hasRoot && isDesktop && Boolean(descriptor?.available)
    && Boolean(connection?.connected) && Boolean(plan) && !planning && !running
    && !(plan?.blockers || []).length
    && unapprovedGates.length === 0
    && (!production || missingEnv.every((key) => (envValues[key] || '').trim()));

  return (
    <section className="dp-card dp-publish" aria-label="Publish to a host">
      <div className="dp-card-head">
        <span className="dp-step">5</span> Publish to a host
        <span className="dp-plan-actions">
          <button type="button" className="small" onClick={loadPlan} disabled={!hasRoot || planning || !isDesktop}>
            <RefreshIcon size={13} /> {planning ? 'Reviewing…' : 'Re-review'}
          </button>
        </span>
      </div>

      {!isDesktop && (
        <p className="dp-muted">Publishing needs the desktop app: provider calls run in the main process, never in the renderer.</p>
      )}

      {error && <div className="dp-error" role="alert">{error}</div>}

      {/* ---- provider choice ---- */}
      <div className="dp-provider-grid">
        {providers.map((p) => (
          <button key={p.id} type="button"
            className={`dp-provider-card${p.id === providerId ? ' selected' : ''}${p.available ? '' : ' disabled'}`}
            onClick={() => p.available && setProviderId(p.id)} disabled={!p.available}>
            <span className="dp-provider-name">{p.label}</span>
            <span className={`dp-tag ${p.available ? 'ok' : ''}`}>
              {p.available ? (p.requiresGit ? 'needs Git' : 'no Git needed') : 'not implemented'}
            </span>
            <span className="dp-provider-note">
              {p.available
                ? `${p.supports.providerBuild ? 'Can build on the host' : 'Uploads pre-built output'} · ${p.supports.next ? 'Next.js supported' : 'static + SPA only'}`
                : p.reason}
            </span>
          </button>
        ))}
        {!providers.length && isDesktop && (
          <p className="dp-muted">Restart NovaCode to load the hosting providers.</p>
        )}
      </div>

      {/* ---- account connection ---- */}
      {descriptor?.available && (
        <div className="dp-account">
          <div className="dp-account-head">
            <KeyIcon size={14} />
            <span className="dp-account-title">{descriptor.label} account</span>
            {connection?.connected
              ? <span className="dp-tag ok">connected{connection.account?.handle ? ` as ${connection.account.handle}` : ''}</span>
              // A stored token the host no longer accepts is its own state: it is
              // not "not connected", and pretending otherwise hides the reason.
              : <span className={connection?.error ? 'dp-tag bad' : 'dp-tag'}>{connection?.error ? 'token rejected' : 'not connected'}</span>}
            {connection?.storage === 'plain' && (
              <span className="dp-tag warn">stored without OS encryption</span>
            )}
          </div>

          {connection?.connected ? (
            <div className="dp-actions">
              <button type="button" className="small" onClick={handleDisconnect}>Disconnect</button>
              <button type="button" className="small" onClick={rememberDefaults}>Use as default host</button>
              {connection.teams?.length > 0 && (
                <label className="dp-field dp-field-sm">
                  <span className="dp-field-label">Account / team</span>
                  <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                    <option value="">My personal account</option>
                    {connection.teams.map((team) => (
                      <option key={team.id} value={team.id}>{team.name || team.slug || team.id}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          ) : (
            <>
              {connection?.error && (
                <p className="dp-status fail" role="alert">
                  {connection.error} Paste a current token to reconnect.
                </p>
              )}
              <ol className="dp-instructions">
                {(descriptor.instructions || []).map((line, i) => <li key={i}>{line}</li>)}
              </ol>
              <form className="dp-token-form" onSubmit={handleConnect}>
                <input type="password" autoComplete="off" spellCheck="false"
                  aria-label={`${descriptor.label} access token`} placeholder="Paste access token"
                  value={tokenDraft} onChange={(e) => setTokenDraft(e.target.value)} />
                <button type="submit" className="small primary" disabled={connecting === descriptor.id}>
                  {connecting === descriptor.id ? 'Verifying…' : 'Connect'}
                </button>
                <button type="button" className="small" onClick={() => client.openExternal(descriptor.tokenUrl)}>
                  <ExternalLinkIcon size={13} /> Get a token
                </button>
              </form>
              <p className="dp-muted">
                NovaCode verifies the token against {descriptor.label} before storing it, keeps it in your OS key store,
                and never returns it to the interface or writes it to a log.
              </p>
            </>
          )}
        </div>
      )}

      {/* ---- review ---- */}
      {plan && (
        <div className="dp-review">
          <h4 className="dp-review-title">
            Review {planning ? '· updating…' : ''}
          </h4>
          <ul className="dp-checks">
            {plan.checks.map((check) => (
              <li key={check.id} className={`dp-check${check.ok ? ' ok' : ' bad'}`}>
                <span className="dp-check-mark">{check.ok ? <CheckIcon size={13} /> : '!'}</span>
                <span className="dp-check-label">{check.label}</span>
                <span className="dp-check-detail">{check.detail}</span>
              </li>
            ))}
          </ul>

          {plan.warnings?.length > 0 && (
            <ul className="dp-warnings">{plan.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          )}
          {plan.blockers?.length > 0 && (
            <ul className="dp-blockers">{plan.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
          )}

          <div className="dp-field-row">
            <label className="dp-field">
              <span className="dp-field-label">Build command</span>
              <input value={plan.build.buildCommand || ''} readOnly
                placeholder={plan.profile.deployMode === 'provider-build' ? 'runs on the host' : 'none'} />
            </label>
            <label className="dp-field dp-field-sm">
              <span className="dp-field-label">Upload folder</span>
              <input value={plan.build.outputDir || ''} readOnly
                placeholder={plan.profile.deployMode === 'provider-build' ? 'project source' : '.'} />
            </label>
            <label className="dp-field dp-field-sm">
              <span className="dp-field-label">Publish as</span>
              <select value={production ? 'production' : 'preview'}
                onChange={(e) => setProduction(e.target.value === 'production')}>
                <option value="production">Production</option>
                <option value="preview">Preview / draft</option>
              </select>
            </label>
            {projects.length > 0 && (
              <label className="dp-field dp-field-sm">
                <span className="dp-field-label">Existing project</span>
                <select value={project} onChange={(e) => setProject(e.target.value)}>
                  <option value="">Create a new one</option>
                  {projects.map((p) => (
                    <option key={p.id || p.name} value={p.id || p.name}>{p.name || p.id}</option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {/* ---- environment variables: names in, values out of the picture ---- */}
          <div className="dp-env">
            <div className="dp-env-head">
              <span className="dp-field-label">Environment variables</span>
              <span className="dp-muted">
                {plan.env.required.length} referenced · {plan.env.providerDefined.length} already on {descriptor?.label}
              </span>
            </div>
            {missingEnv.length > 0 && (
              <div className="dp-env-missing">
                <p className="dp-muted">
                  {production
                    ? 'Give these a value and NovaCode sends them to the host before publishing. They are not stored by NovaCode.'
                    : 'A preview can deploy without them; add values before the production publish.'}
                </p>
                {missingEnv.map((key) => (
                  <div className="dp-env-row" key={key}>
                    <code>{key}</code>
                    <input type="password" autoComplete="off" spellCheck="false" aria-label={`Value for ${key}`}
                      value={envValues[key] || ''} onChange={(e) => setEnvValues((v) => ({ ...v, [key]: e.target.value }))} />
                  </div>
                ))}
              </div>
            )}
            {!missingEnv.length && (
              <p className="dp-muted">Nothing missing. {plan.env.required.length ? plan.env.required.map((e) => e.key).join(', ') : 'No environment references found.'}</p>
            )}
          </div>

          {/* ---- explicit confirmations ---- */}
          {plan.needs.confirmBuild && (
            <label className="dp-consent">
              <input type="checkbox" checked={approvedBuild} onChange={(e) => setApprovedBuild(e.target.checked)} />
              <span>Allow NovaCode to run <code>{plan.build.buildCommand}</code> in this project folder.</span>
            </label>
          )}
          {plan.profile.frontendOnly && (
            <label className="dp-consent">
              <input type="checkbox" checked={approvedFrontendOnly} onChange={(e) => setApprovedFrontendOnly(e.target.checked)} />
              <span>I understand only the static frontend will be published — the server code will not exist at the new URL.</span>
            </label>
          )}

          <div className="dp-actions">
            <button type="button" className="primary" onClick={startDeploy} disabled={!canDeploy}>
              <RocketIcon size={14} /> {production ? 'Deploy to production' : 'Deploy preview'}
            </button>
            {!connection?.connected && <span className="dp-muted">Connect a {descriptor?.label} account to deploy.</span>}
            {plan.blockers?.length > 0 && <span className="dp-status fail">Blocked — fix the items above.</span>}
            {running && <span className="dp-status ok">Deployment in progress…</span>}
          </div>
        </div>
      )}

      {/* ---- live status ---- */}
      {run && (
        <div className={`dp-run state-${run.state || 'queued'}`}>
          <div className="dp-run-head">
            <span className="dp-run-title">Deployment status</span>
            <span className={`dp-tag ${run.state === 'ready' ? 'ok' : run.state === 'error' ? 'bad' : ''}`}>
              {STATE_LABELS[run.state] || run.state || 'queued'}
            </span>
            {run.target && <span className="dp-tag">{run.target}</span>}
          </div>

          <ol className="dp-timeline">
            {PHASE_ORDER.map((phase, index) => {
              const done = run.phase === 'live' ? true : index < PHASE_ORDER.indexOf(run.phase);
              const current = phase === run.phase;
              return (
                <li key={phase} className={`dp-tstep${done ? ' done' : ''}${current ? ' current' : ''}`}>
                  <span className="dp-tdot" />{PHASE_LABELS[phase]}
                </li>
              );
            })}
          </ol>
          {(run.phase === 'failed' || run.phase === 'canceled') && (
            <span className={`dp-tstep ${run.phase}`}>▸ {PHASE_LABELS[run.phase]}</span>
          )}

          {run.message && <p className="dp-run-message">{run.message}</p>}

          {failedRun && (
            <div className="dp-diagnose">
              <div className="dp-diagnose-head">
                <button type="button" className="small" onClick={handleDiagnose} disabled={diagnosing}>
                  <SparkleIcon size={13} /> {diagnosing ? 'Reading the logs…' : run.state === 'error' ? 'Explain this failure' : 'Explain what happened'}
                </button>
                {shownDiagnosis && !diagnosing && <span className="dp-muted">{diagnosisAttribution(shownDiagnosis)}</span>}
              </div>

              {shownDiagnosis?.text && <p className="dp-diagnose-text">{shownDiagnosis.text}</p>}
              {shownDiagnosis && !shownDiagnosis.text && (
                <p className="dp-diagnose-fallback">{diagnosisFallback(shownDiagnosis)}</p>
              )}

              {shownDiagnosis?.hints?.length > 0 && (
                <ul className="dp-diagnose-hints">
                  {shownDiagnosis.hints.map((hint) => (
                    <li key={hint.id}>
                      <strong>{hint.cause}</strong>
                      <span>{hint.fix}</span>
                    </li>
                  ))}
                </ul>
              )}

              {shownDiagnosis?.logError && (
                <p className="dp-muted">Host build log unavailable: {shownDiagnosis.logError}</p>
              )}
            </div>
          )}

          {run.progress?.total ? (
            <div className="dp-progress">
              <div className="dp-progress-bar" style={{ width: `${Math.min(100, Math.round((run.progress.uploaded / run.progress.total) * 100))}%` }} />
              <span className="dp-progress-text">
                {run.progress.uploaded}/{run.progress.total} files · {formatBytes(run.progress.bytes)}
              </span>
            </div>
          ) : null}

          {run.publicUrl ? (
            <div className="dp-url">
              <GlobeIcon size={14} />
              <a className="dp-url-link" href={run.publicUrl} target="_blank" rel="noreferrer">{run.publicUrl}</a>
              <button type="button" className="small" onClick={() => client.openExternal(run.publicUrl)}>
                <ExternalLinkIcon size={13} /> Open website
              </button>
              <button type="button" className="small" onClick={() => navigator.clipboard?.writeText(run.publicUrl)}>Copy</button>
            </div>
          ) : (
            <p className="dp-muted">
              {run.state === 'error'
                ? 'No URL: the host did not finish this deployment.'
                : 'The URL appears once the host reports the deployment as live.'}
            </p>
          )}

          <div className="dp-actions">
            {running && (
              <button type="button" className="small" onClick={handleCancel}>
                <StopIcon size={13} /> Cancel
              </button>
            )}
            {!running && run.deploymentId && (
              <button type="button" className="small" onClick={handleRefresh}>
                <RefreshIcon size={13} /> Check status
              </button>
            )}
            {run.dashboardUrl && (
              <button type="button" className="small" onClick={() => client.openExternal(run.dashboardUrl)}>
                <ExternalLinkIcon size={13} /> {descriptor?.label} dashboard
              </button>
            )}
            <button type="button" className="small" onClick={handleProviderLogs}>
              View host logs
            </button>
          </div>

          {(run.logLines?.length || run.log?.length) ? (
            <pre className="dp-log">{(run.logLines || run.log).join('\n')}</pre>
          ) : null}
          {remoteLog && <pre className="dp-log dp-log-remote">{remoteLog}</pre>}
        </div>
      )}

      {/* ---- custom domains ---- */}
      <div className="dp-domains">
        <div className="dp-env-head">
          <span className="dp-field-label">Custom domain</span>
          <button type="button" className="small" onClick={handleDomains}
            disabled={!connection?.connected || !isDesktop}>Check with {descriptor?.label || 'host'}</button>
        </div>
        {domainInfo && (
          <>
            {domainInfo.domains?.length ? (
              <ul className="dp-domain-list">
                {domainInfo.domains.map((d) => (
                  <li key={d.name}>
                    <code>{d.name}</code>
                    <span className={`dp-tag ${d.confirmed ? 'ok' : 'warn'}`}>{d.confirmed ? 'verified' : 'pending'}</span>
                    {d.misconfigured ? <span className="dp-tag bad">DNS misconfigured</span> : null}
                  </li>
                ))}
              </ul>
            ) : <p className="dp-muted">No custom domain on this {descriptor?.label} project yet.</p>}
            <ul className="dp-instructions">{(domainInfo.instructions || []).map((line, i) => <li key={i}>{line}</li>)}</ul>
          </>
        )}
        {!domainInfo && (
          <p className="dp-muted">
            A domain is only listed as active when {descriptor?.label || 'the host'} reports it verified — NovaCode never guesses.
          </p>
        )}
      </div>

      {/* ---- history ---- */}
      <div className="dp-history">
        <div className="dp-env-head">
          <span className="dp-field-label">Deployment history</span>
          {history.length > 0 && (
            <button type="button" className="small" onClick={() => setClearOpen(true)}>
              <TrashIcon size={13} /> Clear
            </button>
          )}
        </div>
        {!hasRoot && <p className="dp-muted">Open a folder to see its deploys.</p>}
        {hasRoot && !history.length && <p className="dp-muted">No deployments from this folder yet.</p>}
        {history.length > 0 && (
          <ul className="dp-history-list">
            {history.map((row) => (
              <li key={row.id} className="dp-history-row">
                <span className={`dp-tag ${row.state === 'ready' ? 'ok' : row.state === 'error' ? 'bad' : ''}`}>
                  {STATE_LABELS[row.state] || row.state}
                </span>
                <span className="dp-history-main">
                  <span className="dp-history-provider">{row.provider}{row.teamId ? ` · ${row.teamId}` : ''} · {row.target}</span>
                  {row.publicUrl
                    ? <a href={row.publicUrl} target="_blank" rel="noreferrer">{row.publicUrl}</a>
                    : <span className="dp-muted">{row.message || 'no public URL'}</span>}
                </span>
                <span className="dp-history-meta">
                  {row.fileCount ? `${row.fileCount} files · ${formatBytes(row.totalBytes)} · ` : ''}{timeAgo(row.createdAt)}
                </span>
                <span className="dp-history-actions">
                  {row.publicUrl && (
                    <button type="button" className="small" onClick={() => client.openExternal(row.publicUrl)}>
                      <GlobeIcon size={12} /> Open
                    </button>
                  )}
                  <button type="button" className="small" onClick={() => redeploy(row)} disabled={running || !isDesktop}>
                    <RefreshIcon size={12} /> Redeploy
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog open={clearOpen} title="Clear deployment history?"
        message="This removes NovaCode's local record of these deployments. It does not delete anything on the host — use the provider dashboard for that."
        confirmLabel="Clear history" onClose={() => setClearOpen(false)} onSubmit={clearHistory} />
    </section>
  );
}
