/** Settings state backed by the Electron settings service (localStorage fallback). */
import { useCallback, useEffect, useState } from 'react';
import { client, toUserMessage } from '../services/novaClient';

export const DEFAULT_SETTINGS = {
  theme: 'dark',
  accent: '#7c5cff',
  fontSize: 14,
  tabSize: 2,
  wordWrap: true,
  minimap: true,
  autosave: false,
  reduceAnimations: false,
  lineNumbers: 'on',
  cursorBlinking: 'smooth',
  renderWhitespace: 'none',
  fontLigatures: false,
  bracketPairColorization: true,
  autoClosingBrackets: true,
  inlineAI: true,
  layout: {
    sidebarWidth: 260,
    aiPanelWidth: 460,
    terminalHeight: 220,
    terminalVisible: true,
    aiPanelVisible: true,
  },
  ai: {
    provider: 'pollinations',
    baseUrl: 'https://text.pollinations.ai/v1',
    model: 'openai-fast',
    temperature: 0.2,
    inlineProvider: '',
    inlineModel: '',
  },
};

function mergeDefaults(stored) {
  const storedAi = { ...(stored?.ai || {}) };
  // Mirror the main-process migration: an untouched default provider (never
  // customized) yields to the free, no-key out-of-the-box default so the cached
  // view matches the settings the main process returns.
  const isDefaultTriple = (provider, baseUrl, model) =>
    storedAi.provider === provider
    && (storedAi.baseUrl === undefined || storedAi.baseUrl === baseUrl)
    && (storedAi.model === undefined || storedAi.model === model);
  const untouchedDefault =
    isDefaultTriple('openai', 'https://api.openai.com/v1', 'gpt-4o-mini')
    || isDefaultTriple('ollama', 'http://localhost:11434', 'llama3.2')
    || isDefaultTriple('pollinations', 'https://text.pollinations.ai/v1', 'openai');
  if (untouchedDefault) {
    delete storedAi.provider;
    delete storedAi.baseUrl;
    delete storedAi.model;
  }
  return {
    ...DEFAULT_SETTINGS,
    ...(stored || {}),
    layout: { ...DEFAULT_SETTINGS.layout, ...(stored?.layout || {}) },
    ai: { ...DEFAULT_SETTINGS.ai, ...storedAi },
  };
}

const LOCAL_KEY = 'novacode-settings';

export function useSettings() {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await client.getSettings();
        if (cancelled) return;
        if (stored) {
          setSettings(mergeDefaults(stored));
        } else {
          const local = localStorage.getItem(LOCAL_KEY);
          setSettings(mergeDefaults(local ? JSON.parse(local) : null));
        }
      } catch (loadError) {
        if (!cancelled) {
          setSettings(mergeDefaults(null));
          setError(toUserMessage(loadError));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (patch) => {
    let next;
    setSettings((current) => {
      next = mergeDefaults({
        ...current,
        ...patch,
        layout: { ...current.layout, ...(patch.layout || {}) },
        ai: { ...current.ai, ...(patch.ai || {}) },
      });
      return next;
    });
    try {
      const saved = await client.saveSettings(patch);
      if (saved) setSettings(mergeDefaults(saved));
    } catch (saveError) {
      // Desktop persistence failed (e.g. browser mode): keep localStorage.
      try {
        localStorage.setItem(LOCAL_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      setError(toUserMessage(saveError));
    }
  }, []);

  return { settings: settings || DEFAULT_SETTINGS, update, ready: Boolean(settings), error };
}
