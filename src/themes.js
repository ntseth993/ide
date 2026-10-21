/**
 * NovaCode theme registry — the single source of truth for every theme.
 *
 * App.jsx applies `palette` to the CSS custom properties, monacoSetup.js turns
 * each entry into a Monaco theme, settingsService.js validates `id`s, and the
 * Settings gallery / Welcome switch render them. Adding a theme therefore means
 * adding ONE entry here (plus its decorative layer in styles/themes.css).
 *
 * `kind` drives color-scheme and the Monaco base theme; `editorBase` can escape
 * that default when a theme needs high-contrast rendering instead.
 */
export const THEMES = [
  {
    id: 'dark',
    label: 'Midnight',
    kind: 'dark',
    blurb: 'Violet-cyan accents on deep navy',
    accent: '#7c5cff',
    accent2: '#22d3ee',
    accent3: '#3b82f6',
    swatch: ['#080c16', '#7c5cff', '#22d3ee'],
    palette: {
      bg: '#080c16',
      panel: '#0d1424',
      surface: '#121a2e',
      surface2: '#18233c',
      surface3: '#1f2c48',
      text: '#e6ebf4',
      muted: '#94a1b8',
      border: 'rgba(148,163,184,0.13)',
    },
  },
  {
    id: 'light',
    label: 'Daylight',
    kind: 'light',
    blurb: 'Bright, neutral and calm',
    accent: '#6d4aff',
    accent2: '#0891b2',
    accent3: '#2563eb',
    swatch: ['#ffffff', '#6d4aff', '#eef2f8'],
    palette: {
      bg: '#eef2f8',
      panel: '#ffffff',
      surface: '#f6f8fc',
      surface2: '#e9eef6',
      surface3: '#dde5f0',
      text: '#101828',
      muted: '#5a6474',
      border: 'rgba(16,24,40,0.12)',
    },
  },
  {
    id: 'high-contrast',
    label: 'High contrast',
    kind: 'dark',
    editorBase: 'hc-black',
    blurb: 'Maximum legibility, no decoration',
    accent: '#ffff00',
    accent2: '#00ffff',
    accent3: '#ffffff',
    swatch: ['#000000', '#ffff00', '#ffffff'],
    palette: {
      bg: '#000000',
      panel: '#0a0a0a',
      surface: '#141414',
      surface2: '#1d1d1d',
      surface3: '#262626',
      text: '#ffffff',
      muted: '#c8c8c8',
      border: 'rgba(255,255,255,0.4)',
    },
  },
  {
    id: 'dragon',
    label: 'Dragon',
    kind: 'dark',
    blurb: 'Molten obsidian with rising embers',
    accent: '#ff5a36',
    accent2: '#ffb347',
    accent3: '#e11d48',
    swatch: ['#160a07', '#ff5a36', '#ffb347'],
    palette: {
      bg: '#150a07',
      panel: '#1e0f0a',
      surface: '#281309',
      surface2: '#331a0e',
      surface3: '#412115',
      text: '#ffe8dc',
      muted: '#cf9880',
      border: 'rgba(255,122,74,0.18)',
    },
  },
  {
    id: 'flowers',
    label: 'Flowers',
    kind: 'light',
    blurb: 'Petal pink with drifting bloom',
    accent: '#d6468c',
    accent2: '#7cc36a',
    accent3: '#f284b0',
    swatch: ['#fff5f8', '#d6468c', '#f284b0'],
    palette: {
      bg: '#fff5f8',
      panel: '#ffffff',
      surface: '#fdedf3',
      surface2: '#f8dce7',
      surface3: '#f1cbdc',
      text: '#3f1e2d',
      muted: '#956577',
      border: 'rgba(190,90,140,0.18)',
    },
  },
  {
    id: 'ocean',
    label: 'Ocean',
    kind: 'dark',
    blurb: 'Abyssal blue with caustic shimmer',
    accent: '#22b8d6',
    accent2: '#5eead4',
    accent3: '#3b82f6',
    swatch: ['#04121b', '#22b8d6', '#5eead4'],
    palette: {
      bg: '#04121b',
      panel: '#071d29',
      surface: '#0b2634',
      surface2: '#103041',
      surface3: '#153b4f',
      text: '#dff5fa',
      muted: '#84b3c4',
      border: 'rgba(94,234,212,0.15)',
    },
  },
  {
    id: 'forest',
    label: 'Forest',
    kind: 'dark',
    blurb: 'Deep canopy with dappled light',
    accent: '#4fae6a',
    accent2: '#a3e635',
    accent3: '#2f9e6f',
    swatch: ['#07140d', '#4fae6a', '#a3e635'],
    palette: {
      bg: '#07140d',
      panel: '#0b1c12',
      surface: '#102418',
      surface2: '#162e1f',
      surface3: '#1d3826',
      text: '#e4f3e8',
      muted: '#93b39b',
      border: 'rgba(163,230,53,0.14)',
    },
  },
  {
    id: 'synthwave',
    label: 'Synthwave',
    kind: 'dark',
    blurb: 'Neon grid horizon, magenta sky',
    accent: '#ff4fd8',
    accent2: '#22d3ee',
    accent3: '#8b5cf6',
    swatch: ['#0b0418', '#ff4fd8', '#22d3ee'],
    palette: {
      bg: '#0b0418',
      panel: '#140828',
      surface: '#1b0d35',
      surface2: '#241244',
      surface3: '#2d1754',
      text: '#f2e6ff',
      muted: '#a68cd0',
      border: 'rgba(255,79,216,0.2)',
    },
  },
  {
    id: 'sunset',
    label: 'Sunset',
    kind: 'dark',
    blurb: 'Warm dusk plum with amber glow',
    accent: '#ff9f45',
    accent2: '#ff6b81',
    accent3: '#c084fc',
    swatch: ['#170a12', '#ff9f45', '#ff6b81'],
    palette: {
      bg: '#170a12',
      panel: '#21101a',
      surface: '#2a1622',
      surface2: '#351d2b',
      surface3: '#402434',
      text: '#ffeaf0',
      muted: '#c99aab',
      border: 'rgba(255,159,69,0.17)',
    },
  },
];

export const DEFAULT_THEME = 'dark';

const THEME_MAP = new Map(THEMES.map((theme) => [theme.id, theme]));

export const THEME_IDS = THEMES.map((theme) => theme.id);

/** Look up a theme, falling back to the default so callers never get null. */
export function getTheme(id) {
  return THEME_MAP.get(id) || THEME_MAP.get(DEFAULT_THEME);
}

/** Monaco theme id for a NovaCode theme. */
export function monacoThemeFor(id) {
  return `nova-${getTheme(id).id}`;
}
