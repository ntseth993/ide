/** Settings panel: appearance, editor behavior, and AI config. */
import { useEffect, useMemo, useState } from 'react';
import { client, isDesktop, toUserMessage } from '../services/novaClient';
import { THEMES, resolveSystemTheme } from '../themes';

/** Toggle row: label + one-line explanation + switch (used across the panel). */
function SwitchRow({ label, hint, checked, onChange }) {
  return (
    <label className={`switch-row${checked ? ' on' : ''}`}>
      <span className="switch-copy">
        <span className="switch-label">{label}</span>
        {hint && <span className="switch-hint">{hint}</span>}
      </span>
      <input type="checkbox" checked={Boolean(checked)} onChange={(event) => onChange(event.target.checked)} />
      <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
    </label>
  );
}

/** Range row with a live value badge. */
function SliderRow({ label, value, min, max, step = 1, display, onChange }) {
  return (
    <label className="slider-row">
      <span className="slider-head">
        <span>{label}</span>
        <span className="slider-value">{display ?? value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

/** Classroom enrollment section: join code input + status + unenroll. */
function ClassroomSection() {
  const [classroomStatus, setClassroomStatus] = useState(null);
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!isDesktop) return;
    client.novalinkLiveClassroomStatus?.().then(setClassroomStatus).catch(() => {});
  }, []);

  async function handleJoin(event) {
    event.preventDefault();
    if (!joinCode.trim()) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await client.novalinkLiveClassroomEnroll({ joinCode: joinCode.trim() });
      setMessage(`Enrolled in "${result.className || 'class'}".`);
      setJoinCode('');
      setClassroomStatus({ enrolled: true, status: result });
    } catch (error) {
      setMessage(toUserMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleUnenroll() {
    setBusy(true);
    try {
      await client.novalinkLiveClassroomUnenroll();
      setClassroomStatus({ enrolled: false });
      setMessage('Unenrolled successfully.');
    } catch (error) {
      setMessage(toUserMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const enrolled = classroomStatus?.enrolled;
  const enrollment = classroomStatus?.status;

  return (
    <section className="settings-group">
      <h4>Classroom</h4>
      {enrolled ? (
        <div>
          <p className="muted tiny">
            Enrolled in <strong>{enrollment?.className || 'a class'}</strong>.
            Your teacher can see your editor, terminal, and AI activity in real time.
          </p>
          <button type="button" className="btn-small" onClick={handleUnenroll} disabled={busy}>
            {busy ? 'Working...' : 'Unenroll'}
          </button>
        </div>
      ) : (
        <form onSubmit={handleJoin} className="classroom-join-form">
          <p className="muted tiny">
            Enter a join code from your teacher to enable classroom monitoring.
          </p>
          <div className="classroom-join-row">
            <input
              type="text"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="ABC123"
              maxLength={6}
              disabled={busy}
              aria-label="Class join code"
            />
            <button type="submit" disabled={busy || joinCode.trim().length !== 6}>
              {busy ? 'Joining...' : 'Join'}
            </button>
          </div>
          {message ? <p className="classroom-message" role="alert">{message}</p> : null}
        </form>
      )}
    </section>
  );
}

export default function SettingsPanel({ settings, update }) {
  const [appInfo, setAppInfo] = useState(null);
  const [connState, setConnState] = useState({ state: 'idle', message: '' });
  const [aiProviders, setAiProviders] = useState([]);
  const [systemTheme, setSystemTheme] = useState('dark');

  // Inline model picker options follow whichever inline provider is chosen.
  const inlineProviderObj = useMemo(
    () => aiProviders.find((p) => p.id === settings.ai.inlineProvider) || null,
    [aiProviders, settings.ai.inlineProvider],
  );
  const inlineModels = inlineProviderObj?.models?.length ? inlineProviderObj.models : [];

  // Picking a theme also adopts its accent, which is what makes a switch to
  // "Dragon" or "Flowers" feel complete instead of half-applied.
  function pickTheme(theme) {
    update({ theme: theme.id, accent: theme.accent });
  }

  useEffect(() => {
    client.appInfo().then(setAppInfo).catch(() => setAppInfo(null));
  }, []);

  // Listen for system theme changes to update the display
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      setSystemTheme(mediaQuery.matches ? 'dark' : 'light');
    };
    
    // Initial value
    handleChange();
    
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // Provider descriptors come from the main-process registry, so the Settings
  // model pickers can never drift from what the assistant actually supports.
  useEffect(() => {
    client.listAiProviders().then((list) => setAiProviders(list || [])).catch(() => setAiProviders([]));
  }, []);

  async function checkConnection() {
    setConnState({ state: 'checking', message: '' });
    try {
      const result = await client.checkAiConnection(settings.ai.baseUrl);
      if (result.ok) {
        setConnState({ state: 'ok', message: `Connected. ${result.models.length} models available.` });
      } else {
        setConnState({ state: 'error', message: result.error || 'Connection failed.' });
      }
    } catch (error) {
      setConnState({ state: 'error', message: toUserMessage(error) });
    }
  }

  return (
    <aside className="settings-panel side-right" aria-label="Settings">
      <header className="panel-header settings-header">
        <h3>Settings</h3>
        <p className="settings-header-sub">Saved to your profile as you type.</p>
      </header>
      <div className="settings-scroll">
        <section className="settings-group">
          <h4>Appearance</h4>
          <div className="theme-grid" role="group" aria-label="Theme">
            {THEMES.map((theme) => (
              <button
                type="button"
                key={theme.id}
                className={`theme-card${settings.theme === theme.id ? ' active' : ''}`}
                onClick={() => pickTheme(theme)}
                aria-pressed={settings.theme === theme.id}
                title={theme.blurb}
              >
                <span
                  className="theme-swatch"
                  style={{
                    background: `linear-gradient(120deg, ${theme.swatch[0]} 0 48%, ${theme.swatch[1]} 48% 76%, ${theme.swatch[2]} 76%)`,
                  }}
                >
                  <span className="theme-swatch-line" />
                  <span className="theme-swatch-line short" />
                </span>
                <span className="theme-name">
                  {theme.label}
                  {theme.id === 'system' && settings.theme === 'system' && (
                    <span className="theme-badge">({systemTheme})</span>
                  )}
                </span>
                <span className="theme-blurb">{theme.blurb}</span>
              </button>
            ))}
          </div>
          <label className="color-row">
            <span>Accent color</span>
            <span className="color-input">
              <input type="color" value={settings.accent} onChange={(e) => update({ accent: e.target.value })} />
              <code>{settings.accent}</code>
            </span>
          </label>
          <SwitchRow
            label="Reduce decorative animations"
            hint="Turns off theme backdrops and motion effects"
            checked={Boolean(settings.reduceAnimations)}
            onChange={(checked) => update({ reduceAnimations: checked })}
          />
        </section>

        <section className="settings-group">
          <h4>Editor</h4>
          <SliderRow
            label="Font size"
            display={`${settings.fontSize}px`}
            min={10}
            max={28}
            value={settings.fontSize}
            onChange={(value) => update({ fontSize: value })}
          />
          <SliderRow
            label="Tab size"
            min={1}
            max={8}
            value={settings.tabSize}
            onChange={(value) => update({ tabSize: value })}
          />
          <SwitchRow label="Word wrap" checked={settings.wordWrap} onChange={(checked) => update({ wordWrap: checked })} />
          <SwitchRow label="Minimap" checked={settings.minimap} onChange={(checked) => update({ minimap: checked })} />
          <SwitchRow label="Autosave" hint="Writes the file shortly after you stop typing" checked={settings.autosave} onChange={(checked) => update({ autosave: checked })} />
        </section>

        <section className="settings-group">
          <h4>Editor behavior</h4>
          <label>
            Line numbers
            <select value={settings.lineNumbers} onChange={(e) => update({ lineNumbers: e.target.value })}>
              <option value="on">On</option>
              <option value="off">Off</option>
              <option value="relative">Relative</option>
            </select>
          </label>
          <label>
            Cursor blinking
            <select value={settings.cursorBlinking} onChange={(e) => update({ cursorBlinking: e.target.value })}>
              <option value="smooth">Smooth</option>
              <option value="blink">Blink</option>
              <option value="phase">Phase</option>
              <option value="solid">Solid</option>
            </select>
          </label>
          <label>
            Render whitespace
            <select value={settings.renderWhitespace} onChange={(e) => update({ renderWhitespace: e.target.value })}>
              <option value="none">None</option>
              <option value="selection">Selection</option>
              <option value="boundary">Boundary</option>
              <option value="trailing">Trailing</option>
              <option value="all">All</option>
            </select>
          </label>
          <SwitchRow label="Font ligatures" checked={Boolean(settings.fontLigatures)} onChange={(checked) => update({ fontLigatures: checked })} />
          <SwitchRow
            label="Bracket pair colorization"
            checked={settings.bracketPairColorization !== false}
            onChange={(checked) => update({ bracketPairColorization: checked })}
          />
          <SwitchRow
            label="Auto-close brackets"
            checked={settings.autoClosingBrackets !== false}
            onChange={(checked) => update({ autoClosingBrackets: checked })}
          />
        </section>

        <section className="settings-group">
          <h4>AI assistant</h4>
          <SwitchRow
            label="Inline AI suggestions"
            hint="Ghost text while you type; Tab inserts it into your code"
            checked={settings.inlineAI !== false}
            onChange={(checked) => update({ inlineAI: checked })}
          />
          <p className="muted tiny">
            The assistant answers in <strong>Agent</strong> mode (rewrites the file, shows a diff to review) or
            <strong> Ask</strong> mode (explains, never edits). Both modes and inline suggestions are signed-in
            features, and every answer is tuned to be short, idiomatic code — no boilerplate, no invented APIs.
          </p>
          <label>
            Assistant provider
            <select
              value={settings.ai.provider}
              onChange={(e) => {
                const p = aiProviders.find((x) => x.id === e.target.value);
                const ai = { ...settings.ai, provider: e.target.value };
                if (p) { ai.model = p.defaultModel || ai.model; if (p.baseUrl) ai.baseUrl = p.baseUrl; }
                update({ ai });
              }}
            >
              {!aiProviders.some((x) => x.id === settings.ai.provider) && (
                <option value={settings.ai.provider}>{settings.ai.provider}</option>
              )}
              {aiProviders.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <label>
            Base URL (OpenAI-compatible)
            <input
              type="text"
              value={settings.ai.baseUrl}
              onChange={(e) => update({ ai: { ...settings.ai, baseUrl: e.target.value } })}
              spellCheck="false"
            />
          </label>
          <label>
            Model
            <input
              type="text"
              value={settings.ai.model}
              onChange={(e) => update({ ai: { ...settings.ai, model: e.target.value } })}
              spellCheck="false"
            />
          </label>
          <label>
            Inline AI provider (optional)
            <select
              value={settings.ai.inlineProvider || ''}
              onChange={(e) => update({ ai: { ...settings.ai, inlineProvider: e.target.value, inlineModel: '' } })}
            >
              <option value="">Follow assistant provider</option>
              {aiProviders.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <label>
            Inline AI model (optional)
            <select
              value={settings.ai.inlineModel || ''}
              onChange={(e) => update({ ai: { ...settings.ai, inlineModel: e.target.value } })}
            >
              <option value="">Follow assistant model</option>
              {inlineModels.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <p className="muted tiny">
            Ghost text is latency-critical: point the two inline pickers at a fast model (for example Google Gemini
            Flash or Groq) to make suggestions feel instant while the assistant keeps a stronger model. Leave both on
            “Follow” to use one model everywhere.
          </p>
          <SliderRow
            label="Temperature"
            display={settings.ai.temperature}
            min={0}
            max={2}
            step={0.1}
            value={settings.ai.temperature}
            onChange={(value) => update({ ai: { ...settings.ai, temperature: value } })}
          />
          <div className="conn-row">
            <button type="button" className="secondary small" onClick={checkConnection} disabled={connState.state === 'checking'}>
              {connState.state === 'checking' ? 'Checking…' : 'Test connection'}
            </button>
            {connState.message && (
              <span className={`conn-result ${connState.state}`}>{connState.message}</span>
            )}
          </div>
          <p className="muted tiny">
            Any OpenAI-compatible endpoint works here, including local runtimes that expose /v1. Your API key is
            managed in the AI panel and stored with OS-level encryption. With the <strong>NovaCode Gateway</strong>
            provider there is no per-user key: set the Base URL to your gateway (for example
            <code className="oauth-cb"> https://ai.example.com/v1</code>) and sign-in users get chat and inline AI out
            of the box — the keys live on your server.
          </p>
        </section>

        <ClassroomSection />

        {appInfo && (
          <section className="settings-group">
            <h4>About</h4>
            <p className="muted tiny">
              NovaCode {appInfo.version} · Electron {appInfo.electron} · Node {appInfo.node} · {appInfo.platform}
            </p>
          </section>
        )}
      </div>
    </aside>
  );
}
