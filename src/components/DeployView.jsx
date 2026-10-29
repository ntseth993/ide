/**
 * Deploy — build & ship the opened project from inside NovaCode.
 *
 * A guided front-end over three real, workspace-confined operations backed by
 * the main process (client.deployDetect / deployBuild / deployExport and the
 * loopback preview server):
 *   1. Detect   — read package.json / index.html and infer the build command,
 *                 package manager and static output folder.
 *   2. Build    — run the build through the terminal runner and show its output.
 *   3. Preview  — serve the built folder on http://127.0.0.1:<port> and open it.
 *   4. Export   — copy the build output to `.novacode/deploy/` as a portable
 *                 static bundle.
 *
 * Publishing to a real host (Vercel / Netlify / GitHub Pages / S3) is surfaced
 * as ready-to-run terminal commands rather than baked in: those need third-party
 * CLIs and the user's own account token, which we never store or embed. The
 * component stays presentational — no Node, fs, or child_process here.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { client, isDesktop, toUserMessage } from '../services/novaClient';
import { RocketIcon, PlayIcon, RefreshIcon, TrashIcon } from './Icons';

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// Copy-paste publish recipes. Each is just a command to run in the terminal
// (or the Agent) — NovaCode does not execute or authorize them for you.
const PROVIDERS = [
  { id: 'vercel', label: 'Vercel', command: 'npx vercel --prod', note: 'Links to your Vercel account on first run.' },
  { id: 'netlify', label: 'Netlify', command: 'npx netlify deploy --build --prod', note: 'Needs a netlify.toml with the build output.' },
  { id: 'gh-pages', label: 'GitHub Pages', command: 'npx gh-pages -d dist', note: 'Pushes the output folder to the gh-pages branch.' },
  { id: 'surge', label: 'Surge', command: 'npx surge ./dist', note: 'Static hosting with a free *.surge.sh domain.' },
];

export default function DeployView({ root, onNotify, asTab = false }) {
  const [profile, setProfile] = useState(null);
  const [detecting, setDetecting] = useState(false);
  const [buildCommand, setBuildCommand] = useState('');
  const [outputDir, setOutputDir] = useState('dist');
  const [building, setBuilding] = useState(false);
  const [buildLog, setBuildLog] = useState(null); // { output, code, error }
  const [preview, setPreview] = useState({ running: false, url: null });
  const [previewBusy, setPreviewBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(null); // { dest, files, bytes }
  const [error, setError] = useState('');

  const hasRoot = Boolean(root);

  const detect = useCallback(async () => {
    if (!hasRoot || !isDesktop) return;
    setDetecting(true);
    try {
      const p = await client.deployDetect(root);
      setProfile(p);
      if (p?.buildCommand) setBuildCommand((cur) => cur || p.buildCommand);
      else setBuildCommand((cur) => cur || 'npm run build');
      if (p?.outputDir) setOutputDir((cur) => (cur === 'dist' && p.outputDir ? p.outputDir : cur));
      setError('');
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setDetecting(false);
    }
  }, [hasRoot, root]);

  // Detect on open, and refresh the preview state (the server lives in main).
  useEffect(() => { detect(); }, [detect]);
  useEffect(() => {
    if (!isDesktop) return;
    let active = true;
    client.deployPreviewStatus().then((s) => { if (active) setPreview(s); }).catch(() => {});
    return () => { active = false; };
  }, []);

  async function handleBuild() {
    if (!buildCommand.trim()) { setError('Enter a build command first.'); return; }
    setBuilding(true);
    setBuildLog(null);
    setError('');
    try {
      const result = await client.deployBuild({ root, command: buildCommand.trim(), timeoutMs: 300000 });
      setBuildLog(result);
      if (result && result.code === 0) {
        onNotify?.('Build finished', 'ok');
        detect(); // output folder may have just appeared
      } else {
        onNotify?.(`Build exited with code ${result?.code ?? '?'}`, 'error');
      }
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBuilding(false);
    }
  }

  async function handlePreviewStart() {
    setPreviewBusy(true);
    setError('');
    try {
      const s = await client.deployPreviewStart({ root, dir: outputDir.trim() || '.' });
      setPreview(s);
      if (s?.url) client.openExternal(s.url);
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setPreviewBusy(false);
    }
  }

  async function handlePreviewStop() {
    setPreviewBusy(true);
    try { setPreview(await client.deployPreviewStop()); } catch (err) { setError(toUserMessage(err)); }
    finally { setPreviewBusy(false); }
  }

  async function handleExport() {
    setExporting(true);
    setError('');
    try {
      const r = await client.deployExport({ root, outputDir: outputDir.trim() });
      setExported(r);
      onNotify?.(`Exported ${r.files} file(s) to .novacode/deploy`, 'ok');
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setExporting(false);
    }
  }

  const kindLabel = useMemo(() => {
    if (!profile) return '';
    if (profile.kind === 'static') return 'Static site';
    if (profile.kind === 'node') return profile.framework ? profile.framework : 'Node project';
    return 'Unknown';
  }, [profile]);

  const buildOk = buildLog && buildLog.code === 0 && !buildLog.error;
  const canBuild = hasRoot && isDesktop && !building && Boolean(buildCommand.trim());
  const canPreview = hasRoot && isDesktop && !previewBusy;
  const canExport = hasRoot && isDesktop && !exporting && Boolean(outputDir.trim());

  return (
    <div className={`deploy-panel${asTab ? ' dp-tab' : ''}`} aria-label="Deploy workspace">
      <header className="dp-header">
        <div className="dp-title">
          <RocketIcon size={18} />
          <span>Deploy</span>
          <span className="dp-badge">Project</span>
        </div>
        <button type="button" className="small" onClick={detect} disabled={detecting || !hasRoot || !isDesktop}>
          <RefreshIcon size={13} /> {detecting ? 'Detecting…' : 'Re-detect'}
        </button>
      </header>

      {!isDesktop && (
        <div className="dp-notice">Deploy runs in the desktop app — launch it with “npm run dev” or the installed build.</div>
      )}
      {isDesktop && !hasRoot && (
        <div className="dp-notice">Open a project folder to detect a buildable target.</div>
      )}
      {error && <div className="dp-error" role="alert">{error}</div>}

      <div className="dp-body">
        {/* ---- 1 · detected profile ---- */}
        <section className="dp-card">
          <div className="dp-card-head"><span className="dp-step">1</span> Detected project</div>
          {profile ? (
            <dl className="dp-facts">
              <div><dt>Project</dt><dd>{profile.projectName || '(unnamed)'}</dd></div>
              <div><dt>Type</dt><dd>{kindLabel}{profile.ssr ? ' · SSR' : ''}</dd></div>
              <div><dt>Package manager</dt><dd>{profile.packageManager}</dd></div>
              <div>
                <dt>Build script</dt>
                <dd>{profile.scripts && Object.keys(profile.scripts).length ? Object.keys(profile.scripts).join(', ') : '—'}</dd>
              </div>
              <div>
                <dt>Output folder</dt>
                <dd>{profile.outputDir || '—'} {profile.outputExists ? <span className="dp-tag ok">exists</span> : <span className="dp-tag">missing</span>}</dd>
              </div>
            </dl>
          ) : (
            <p className="dp-muted">{hasRoot && isDesktop ? 'Detecting…' : 'Nothing detected yet.'}</p>
          )}
          {profile?.warnings?.length > 0 && (
            <ul className="dp-warnings">{profile.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          )}
        </section>

        {/* ---- 2 · build ---- */}
        <section className="dp-card">
          <div className="dp-card-head"><span className="dp-step">2</span> Build</div>
          <div className="dp-field-row">
            <label className="dp-field">
              <span className="dp-field-label">Command</span>
              <input value={buildCommand} placeholder="npm run build" disabled={!isDesktop}
                onChange={(e) => setBuildCommand(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && canBuild && handleBuild()} />
            </label>
            <label className="dp-field dp-field-sm">
              <span className="dp-field-label">Output folder</span>
              <input value={outputDir} placeholder="dist" disabled={!isDesktop}
                onChange={(e) => setOutputDir(e.target.value)} />
            </label>
          </div>
          <div className="dp-actions">
            <button type="button" className="small primary" onClick={handleBuild} disabled={!canBuild}>
              {building ? <RefreshIcon size={13} /> : <PlayIcon size={13} />} {building ? 'Building…' : 'Run build'}
            </button>
            {buildLog && (
              <span className={`dp-status ${buildOk ? 'ok' : 'fail'}`}>
                {buildOk ? 'exit 0 · success' : `exit ${buildLog.code ?? '?'}${buildLog.timedOut ? ' · timed out' : ''}${buildLog.error ? ` · ${buildLog.error}` : ''}`}
              </span>
            )}
          </div>
          {buildLog && (
            <pre className="dp-log">{`${buildLog.output || ''}${buildLog.error ? `\n${buildLog.error}` : ''}`.trim() || '(no output)'}</pre>
          )}
        </section>

        {/* ---- 3 · preview ---- */}
        <section className="dp-card">
          <div className="dp-card-head"><span className="dp-step">3</span> Preview</div>
          <p className="dp-muted">Serve <code>{outputDir || '.'}</code> locally over loopback (127.0.0.1) and open it in your browser.</p>
          <div className="dp-actions">
            {preview.running ? (
              <>
                <button type="button" className="small" onClick={() => preview.url && client.openExternal(preview.url)} disabled={!preview.url}>
                  <RocketIcon size={13} /> Open {preview.url}
                </button>
                <button type="button" className="small" onClick={handlePreviewStop} disabled={!canPreview}>
                  <TrashIcon size={13} /> Stop preview
                </button>
              </>
            ) : (
              <button type="button" className="small primary" onClick={handlePreviewStart} disabled={!canPreview}>
                <PlayIcon size={13} /> {previewBusy ? 'Starting…' : 'Start preview'}
              </button>
            )}
          </div>
        </section>

        {/* ---- 4 · export bundle ---- */}
        <section className="dp-card">
          <div className="dp-card-head"><span className="dp-step">4</span> Export deployable bundle</div>
          <p className="dp-muted">Copy the build output into <code>.novacode/deploy/</code> — a portable static folder you can upload anywhere.</p>
          <div className="dp-actions">
            <button type="button" className="small" onClick={handleExport} disabled={!canExport}>
              {exporting ? 'Exporting…' : 'Export bundle'}
            </button>
            {exported && (
              <span className="dp-status ok">{exported.files} file(s) · {formatBytes(exported.bytes)} → {exported.dest}</span>
            )}
          </div>
        </section>

        {/* ---- publish to a real host (transparent commands) ---- */}
        <section className="dp-card dp-providers">
          <div className="dp-card-head"><span className="dp-step">5</span> Publish to a host</div>
          <p className="dp-muted">
            NovaCode builds and previews locally. Actual hosting is done by the provider&apos;s own CLI with
            <em> your</em> account token — we never store or embed credentials. Run any of these in the terminal:
          </p>
          <ul className="dp-provider-list">
            {PROVIDERS.map((p) => (
              <li key={p.id} className="dp-provider">
                <div className="dp-provider-head">
                  <span className="dp-provider-name">{p.label}</span>
                  <code className="dp-cmd">{p.command}</code>
                  <button type="button" className="small" onClick={() => navigator.clipboard?.writeText(p.command)}>Copy</button>
                </div>
                <span className="dp-provider-note">{p.note}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
