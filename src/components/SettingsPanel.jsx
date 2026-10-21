/** Settings panel: appearance, editor behavior, code shortcuts, and AI config. */
import { useEffect, useMemo, useState } from 'react';
import { client, isDesktop, toUserMessage } from '../services/novaClient';
import { THEMES } from '../themes';
import { listSnippetShortcutEntries } from '../services/builtinSnippets';

const OAUTH_SETUP_URLS = {
  google: 'https://console.cloud.google.com/apis/credentials',
  github: 'https://github.com/settings/developers',
  microsoft: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
};

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

export default function SettingsPanel({ settings, update, runtimes }) {
  const [appInfo, setAppInfo] = useState(null);
  const [connState, setConnState] = useState({ state: 'idle', message: '' });
  const [oauthProviders, setOauthProviders] = useState([]);
  const [oauthDraft, setOauthDraft] = useState({});
  const [oauthMsg, setOauthMsg] = useState({ state: 'idle', text: '' });
  const [snippetQuery, setSnippetQuery] = useState('');

  // Code shortcuts are just snippet prefixes, so the list is generated from the
  // registry itself — it can never drift from what the editor actually offers.
  const snippetGroups = useMemo(() => {
    const needle = snippetQuery.trim().toLowerCase();
    const grouped = new Map();
    for (const entry of listSnippetShortcutEntries()) {
      if (needle && !entry.prefix.includes(needle) && !entry.language.includes(needle)
        && !(entry.description || '').toLowerCase().includes(needle)) continue;
      if (!grouped.has(entry.language)) grouped.set(entry.language, []);
      grouped.get(entry.language).push(entry);
    }
    return [...grouped.entries()];
  }, [snippetQuery]);

  // Picking a theme also adopts its accent, which is what makes a switch to
  // "Dragon" or "Flowers" feel complete instead of half-applied.
  function pickTheme(theme) {
    update({ theme: theme.id, accent: theme.accent });
  }

  useEffect(() => {
    client.appInfo().then(setAppInfo).catch(() => setAppInfo(null));
  }, []);

  useEffect(() => {
    if (!isDesktop) return;
    client.oauthStatus().then(setOauthProviders).catch(() => setOauthProviders([]));
  }, []);

  function setDraft(key, value) {
    setOauthDraft((draft) => ({ ...draft, [key]: value }));
  }

  async function refreshOauth() {
    setOauthProviders(await client.oauthStatus());
  }

  async function saveOauth(provider) {
    const payload = { provider };
    if (oauthDraft[`${provider}:id`] !== undefined) payload.clientId = oauthDraft[`${provider}:id`];
    if (oauthDraft[`${provider}:secret`] !== undefined) payload.clientSecret = oauthDraft[`${provider}:secret`];
    try {
      await client.setOauthConfig(payload);
      setOauthDraft((draft) => {
        const next = { ...draft };
        delete next[`${provider}:id`];
        delete next[`${provider}:secret`];
        return next;
      });
      await refreshOauth();
      setOauthMsg({ state: 'ok', text: 'Saved.' });
    } catch (error) {
      setOauthMsg({ state: 'error', text: toUserMessage(error) });
    }
  }

  async function removeOauth(provider) {
    try {
      await client.setOauthConfig({ provider, clientId: '', clientSecret: '' });
      await refreshOauth();
      setOauthMsg({ state: 'ok', text: 'Removed.' });
    } catch (error) {
      setOauthMsg({ state: 'error', text: toUserMessage(error) });
    }
  }

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
                <span className="theme-name">{theme.label}</span>
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
          <h4>Code shortcuts</h4>
          <p className="muted tiny">
            Type a prefix in the editor and accept it from the autocomplete list — the skeleton is inserted with
            tab stops, so <kbd>Tab</kbd> walks the placeholders. <kbd>Ctrl+Space</kbd> opens the list on demand.
          </p>
          <input
            className="snippet-search"
            type="search"
            value={snippetQuery}
            onChange={(e) => setSnippetQuery(e.target.value)}
            placeholder="Filter shortcuts (fn, def, flex, …)"
            aria-label="Filter code shortcuts"
            spellCheck="false"
          />
          {snippetGroups.length === 0 && <p className="muted tiny">No shortcut matches “{snippetQuery}”.</p>}
          {snippetGroups.map(([language, entries]) => (
            <div className="snippet-group" key={language}>
              <span className="snippet-language">{language}</span>
              <div className="snippet-list">
                {entries.map((entry) => (
                  <span className="snippet-chip" key={`${language}:${entry.prefix}`} title={entry.description || entry.prefix}>
                    <code>{entry.prefix}</code>
                    {entry.description && <em>{entry.description}</em>}
                  </span>
                ))}
              </div>
            </div>
          ))}
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
            managed in the AI panel and stored with OS-level encryption.
          </p>
        </section>

        <section className="settings-group">
          <h4>Sign-in providers</h4>
          {!isDesktop && (
            <p className="muted tiny">Provider sign-in (Google, GitHub, Microsoft) is configured in the desktop app.</p>
          )}
          {isDesktop && (
            <>
              <p className="muted tiny">
                Let people sign in with an existing account instead of an email. Register an OAuth app with the
                provider, then paste its Client ID below. Values are stored with OS-level encryption and never
                sent to the renderer. Redirect / callback URI to register:
                <code className="oauth-cb"> http://127.0.0.1/callback</code>
              </p>
              {oauthProviders.length === 0 && <p className="muted tiny">Loading providers…</p>}
              {oauthProviders.map((provider) => {
                const idDraft = oauthDraft[`${provider.id}:id`] || '';
                const secretDraft = oauthDraft[`${provider.id}:secret`] || '';
                const dirty = Boolean(idDraft) || Boolean(secretDraft);
                return (
                  <div key={provider.id} className="oauth-provider">
                    <div className="oauth-provider-head">
                      <span className="oauth-provider-name">{provider.label}</span>
                      <span className={`conn-result ${provider.live ? 'ok' : ''}`}>
                        {provider.live ? 'Ready' : provider.fromEnv ? 'Ready (from env)' : 'Not set up'}
                      </span>
                    </div>
                    <label>
                      Client ID
                      <input
                        type="text"
                        spellCheck="false"
                        placeholder={provider.hasClientId && !provider.fromEnv ? 'Configured — enter to replace' : 'e.g. 1234-abc.apps.googleusercontent.com'}
                        value={idDraft}
                        onChange={(e) => setDraft(`${provider.id}:id`, e.target.value)}
                      />
                    </label>
                    {provider.requiresSecret && (
                      <label>
                        Client secret
                        <input
                          type="password"
                          spellCheck="false"
                          placeholder={provider.hasSecret ? 'Configured — enter to replace' : 'GitHub requires a client secret'}
                          value={secretDraft}
                          onChange={(e) => setDraft(`${provider.id}:secret`, e.target.value)}
                        />
                      </label>
                    )}
                    <div className="conn-row">
                      <button type="button" className="secondary small" disabled={!dirty} onClick={() => saveOauth(provider.id)}>
                        Save
                      </button>
                      {provider.hasClientId && !provider.fromEnv && (
                        <button type="button" className="danger small" onClick={() => removeOauth(provider.id)}>
                          Remove
                        </button>
                      )}
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => client.openExternal(OAUTH_SETUP_URLS[provider.id])}
                      >
                        How to get this
                      </button>
                    </div>
                  </div>
                );
              })}
              {oauthMsg.text && <p className={`conn-result ${oauthMsg.state}`}>{oauthMsg.text}</p>}
              <p className="muted tiny">
                GitHub also needs a fixed loopback port: set <code className="oauth-cb">NOVACODE_AUTH_PORT</code>{' '}
                before launching and register the callback with that port.
              </p>
            </>
          )}
        </section>

        <section className="settings-group">
          <h4>Language runtimes</h4>
          {!runtimes && <p className="muted tiny runtime-probing">Detecting installed runtimes…</p>}
          {runtimes ? (
            <ul className="runtime-list">
              {runtimes.runtimes.map((runtime) => (
                <li key={runtime.id} className={`runtime-row ${runtime.found ? 'found' : 'missing'}`}>
                  <span className="runtime-dot" aria-hidden="true" />
                  <span className="runtime-label">{runtime.label}</span>
                  <span className="muted tiny">
                    {runtime.found
                      ? `found${runtime.version ? ` · ${runtime.version}` : ''}`
                      : 'not installed'}
                  </span>
                  {!runtime.found && runtime.installHint && (
                    <span className="muted tiny runtime-hint">{runtime.installHint}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted tiny">Detecting installed toolchains…</p>
          )}
          <p className="muted tiny">
            Syntax highlighting works for all listed languages out of the box. Diagnostics, autocomplete,
            formatting, and debugging beyond the editor defaults require the matching language server or
            compiler — languages without their runtime installed run in highlighting-only mode.
          </p>
        </section>

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
