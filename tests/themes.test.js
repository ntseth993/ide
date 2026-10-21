import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, THEME_IDS, THEMES, getTheme, monacoThemeFor } from '../src/themes';
import { createSettingsService } from '../electron/services/settingsService';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PALETTE_KEYS = ['bg', 'panel', 'surface', 'surface2', 'surface3', 'text', 'muted', 'border'];

describe('theme registry', () => {
  it('ships the built-in palettes including the decorative ones', () => {
    for (const id of ['dark', 'light', 'high-contrast', 'dragon', 'flowers', 'ocean', 'forest', 'synthwave', 'sunset']) {
      expect(THEME_IDS).toContain(id);
    }
  });

  it('keeps every entry complete and uniquely identified', () => {
    const seen = new Set();
    for (const theme of THEMES) {
      expect(theme.id).toMatch(/^[a-z0-9-]+$/);
      expect(seen.has(theme.id)).toBe(false);
      seen.add(theme.id);
      expect(theme.label).toBeTruthy();
      expect(theme.blurb).toBeTruthy();
      expect(['dark', 'light']).toContain(theme.kind);
      expect(theme.accent).toMatch(/^#[0-9a-f]{6}$/i);
      for (const key of PALETTE_KEYS) expect(theme.palette[key]).toBeTruthy();
      expect(theme.swatch).toHaveLength(3);
    }
  });

  it('never hands back a missing theme', () => {
    expect(getTheme('nope').id).toBe(DEFAULT_THEME);
    expect(getTheme(undefined).id).toBe(DEFAULT_THEME);
    expect(getTheme('dragon').label).toBe('Dragon');
  });

  it('names Monaco themes after the registry so both stay in sync', () => {
    expect(monacoThemeFor('dragon')).toBe('nova-dragon');
    expect(monacoThemeFor('nope')).toBe(`nova-${DEFAULT_THEME}`);
  });

  it('lets the main process persist exactly the registry ids', async () => {
    const settingsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novacode-theme-')), 'settings.json');
    const service = createSettingsService(settingsPath);
    for (const theme of THEMES) {
      const saved = await service.save({ theme: theme.id });
      expect(saved.theme).toBe(theme.id);
    }
    const rejected = await service.save({ theme: 'dragon-x' });
    expect(rejected.theme).toBe(DEFAULT_THEME);
  });
});
