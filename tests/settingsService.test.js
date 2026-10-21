import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettingsService, DEFAULTS } from '../electron/services/settingsService';

function tempPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novacode-set-')), 'settings.json');
}

describe('settingsService', () => {
  it('returns defaults when no file exists', async () => {
    const service = createSettingsService(tempPath());
    const settings = await service.load();
    expect(settings.theme).toBe('dark');
    expect(settings.ai.baseUrl).toBe('https://api.openai.com/v1');
    expect(settings.layout.terminalVisible).toBe(true);
  });

  it('saves and reloads sanitized settings', async () => {
    const settingsPath = tempPath();
    const service = createSettingsService(settingsPath);
    await service.save({ theme: 'light', fontSize: 18 });
    const reloaded = createSettingsService(settingsPath);
    const settings = await reloaded.load();
    expect(settings.theme).toBe('light');
    expect(settings.fontSize).toBe(18);
  });

  it('clamps out-of-range numbers and rejects bad values', async () => {
    const service = createSettingsService(tempPath());
    const settings = await service.save({ fontSize: 999, theme: 'neon', ai: { baseUrl: 'ftp://nope' } });
    expect(settings.fontSize).toBe(28);
    expect(settings.theme).toBe('dark');
    expect(settings.ai.baseUrl).toBe(DEFAULTS.ai.baseUrl);
  });

  it('preserves untouched keys across partial saves', async () => {
    const service = createSettingsService(tempPath());
    await service.save({ tabSize: 4 });
    const settings = await service.save({ wordWrap: false });
    expect(settings.tabSize).toBe(4);
    expect(settings.wordWrap).toBe(false);
  });

  it('rejects non-object patches', async () => {
    const service = createSettingsService(tempPath());
    await expect(service.save('dark')).rejects.toThrow(/object/);
  });
});
