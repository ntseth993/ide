/**
 * Application settings service.
 *
 * Persists user preferences as JSON inside the Electron userData directory.
 * Every write is validated against a whitelist so a compromised renderer
 * cannot smuggle unexpected keys or value types into the settings file.
 * API keys deliberately do NOT live here (see secretStore.js).
 */
const fsp = require('fs').promises;

// Must stay in sync with src/themes.js — the renderer registry is the
// product surface, this whitelist is the persistence gate.
const THEMES = ['dark', 'light', 'high-contrast', 'dragon', 'flowers', 'ocean', 'forest', 'synthwave', 'sunset'];
const LINE_NUMBERS = ['on', 'off', 'relative'];
const CURSOR_BLINKING = ['smooth', 'blink', 'phase', 'solid'];
const RENDER_WHITESPACE = ['none', 'all', 'selection', 'boundary', 'trailing'];

const DEFAULTS = {
  theme: 'dark',
  accent: '#7c5cff',
  fontSize: 14,
  tabSize: 2,
  wordWrap: true,
  minimap: true,
  autosave: false,
  lineNumbers: 'on',
  cursorBlinking: 'smooth',
  renderWhitespace: 'none',
  fontLigatures: false,
  bracketPairColorization: true,
  autoClosingBrackets: true,
  reduceAnimations: false,
  inlineAI: true,
  layout: {
    sidebarWidth: 260,
    aiPanelWidth: 460,
    terminalHeight: 220,
    terminalVisible: true,
    aiPanelVisible: true,
  },
  ai: {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    temperature: 0.2,
  },
};

function clamp(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function sanitize(patch) {
  const next = {};
  if (patch.theme !== undefined) {
    next.theme = THEMES.includes(patch.theme) ? patch.theme : DEFAULTS.theme;
  }
  if (patch.accent !== undefined) {
    next.accent = /^#[0-9a-fA-F]{6}$/.test(patch.accent) ? patch.accent : DEFAULTS.accent;
  }
  if (patch.fontSize !== undefined) next.fontSize = clamp(patch.fontSize, 10, 28, DEFAULTS.fontSize);
  if (patch.tabSize !== undefined) next.tabSize = clamp(patch.tabSize, 1, 8, DEFAULTS.tabSize);
  if (patch.wordWrap !== undefined) next.wordWrap = Boolean(patch.wordWrap);
  if (patch.minimap !== undefined) next.minimap = Boolean(patch.minimap);
  if (patch.autosave !== undefined) next.autosave = Boolean(patch.autosave);
  if (patch.lineNumbers !== undefined) {
    next.lineNumbers = LINE_NUMBERS.includes(patch.lineNumbers) ? patch.lineNumbers : DEFAULTS.lineNumbers;
  }
  if (patch.cursorBlinking !== undefined) {
    next.cursorBlinking = CURSOR_BLINKING.includes(patch.cursorBlinking) ? patch.cursorBlinking : DEFAULTS.cursorBlinking;
  }
  if (patch.renderWhitespace !== undefined) {
    next.renderWhitespace = RENDER_WHITESPACE.includes(patch.renderWhitespace)
      ? patch.renderWhitespace
      : DEFAULTS.renderWhitespace;
  }
  if (patch.fontLigatures !== undefined) next.fontLigatures = Boolean(patch.fontLigatures);
  if (patch.bracketPairColorization !== undefined) next.bracketPairColorization = Boolean(patch.bracketPairColorization);
  if (patch.autoClosingBrackets !== undefined) next.autoClosingBrackets = Boolean(patch.autoClosingBrackets);
  if (patch.reduceAnimations !== undefined) next.reduceAnimations = Boolean(patch.reduceAnimations);
  if (patch.inlineAI !== undefined) next.inlineAI = Boolean(patch.inlineAI);
  if (patch.layout !== undefined && typeof patch.layout === 'object') {
    next.layout = {
      sidebarWidth: clamp(patch.layout.sidebarWidth ?? DEFAULTS.layout.sidebarWidth, 180, 480, DEFAULTS.layout.sidebarWidth),
      aiPanelWidth: clamp(patch.layout.aiPanelWidth ?? DEFAULTS.layout.aiPanelWidth, 340, 720, DEFAULTS.layout.aiPanelWidth),
      terminalHeight: clamp(patch.layout.terminalHeight ?? DEFAULTS.layout.terminalHeight, 80, 480, DEFAULTS.layout.terminalHeight),
      terminalVisible: Boolean(patch.layout.terminalVisible ?? DEFAULTS.layout.terminalVisible),
      aiPanelVisible: Boolean(patch.layout.aiPanelVisible ?? DEFAULTS.layout.aiPanelVisible),
    };
  }
  if (patch.ai !== undefined && typeof patch.ai === 'object') {
    const baseUrl = String(patch.ai.baseUrl ?? DEFAULTS.ai.baseUrl);
    next.ai = {
      provider: String(patch.ai.provider ?? DEFAULTS.ai.provider).slice(0, 40) || DEFAULTS.ai.provider,
      baseUrl: /^https?:\/\//i.test(baseUrl) ? baseUrl : DEFAULTS.ai.baseUrl,
      model: String(patch.ai.model ?? DEFAULTS.ai.model).slice(0, 120) || DEFAULTS.ai.model,
      temperature: Math.min(2, Math.max(0, Number(patch.ai.temperature ?? DEFAULTS.ai.temperature))) || 0,
    };
  }
  return next;
}

function mergeDefaults(stored) {
  return {
    ...DEFAULTS,
    ...stored,
    layout: { ...DEFAULTS.layout, ...(stored.layout || {}) },
    ai: { ...DEFAULTS.ai, ...(stored.ai || {}) },
  };
}

function createSettingsService(settingsPath) {
  let cache = null;

  async function load() {
    if (cache) return cache;
    try {
      const raw = await fsp.readFile(settingsPath, 'utf8');
      cache = mergeDefaults(JSON.parse(raw));
    } catch {
      cache = { ...DEFAULTS, layout: { ...DEFAULTS.layout }, ai: { ...DEFAULTS.ai } };
    }
    return cache;
  }

  async function save(patch) {
    if (patch === null || typeof patch !== 'object') {
      throw new Error('Settings update must be an object.');
    }
    const current = await load();
    cache = mergeDefaults({ ...current, ...sanitize(patch) });
    // Re-apply sanitize to the merged object so defaults stay canonical.
    cache = mergeDefaults(sanitize({
      ...cache,
      layout: { ...cache.layout },
      ai: { ...cache.ai },
    }));
    await fsp.writeFile(settingsPath, JSON.stringify(cache, null, 2), 'utf8');
    return cache;
  }

  return { load, save, defaults: DEFAULTS };
}

module.exports = { createSettingsService, DEFAULTS };
