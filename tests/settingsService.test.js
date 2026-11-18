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
    expect(settings.ai.provider).toBe('groq');
    expect(settings.ai.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(settings.layout.terminalVisible).toBe(true);
  });

  it('migrates an untouched legacy OpenAI default to the new default provider', async () => {
    const settingsPath = tempPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      theme: 'dark',
      ai: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', temperature: 0.5 },
    }), 'utf8');
    const settings = await createSettingsService(settingsPath).load();
    // Provider triple resets to the new default; unrelated fields survive.
    expect(settings.ai.provider).toBe('groq');
    expect(settings.ai.model).toBe('openai/gpt-oss-120b');
    expect(settings.ai.temperature).toBe(0.5);
  });

  it('migrates an untouched Ollama default to the new default provider', async () => {
    const settingsPath = tempPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      ai: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3.2' },
    }), 'utf8');
    const settings = await createSettingsService(settingsPath).load();
    expect(settings.ai.provider).toBe('groq');
  });

  it('migrates an untouched Pollinations default to the new default provider', async () => {
    const settingsPath = tempPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      ai: { provider: 'pollinations', baseUrl: 'https://text.pollinations.ai/v1', model: 'openai-fast', temperature: 0.7 },
    }), 'utf8');
    const settings = await createSettingsService(settingsPath).load();
    expect(settings.ai.provider).toBe('groq');
    expect(settings.ai.model).toBe('openai/gpt-oss-120b');
    expect(settings.ai.temperature).toBe(0.7);
  });

  it('migrates the retired Groq default model to the current one', async () => {
    const settingsPath = tempPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      ai: { provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', temperature: 0.3 },
    }), 'utf8');
    const settings = await createSettingsService(settingsPath).load();
    // The dead free model resets to the new gpt-oss default; temperature survives.
    expect(settings.ai.provider).toBe('groq');
    expect(settings.ai.model).toBe('openai/gpt-oss-120b');
    expect(settings.ai.temperature).toBe(0.3);
  });

  it('keeps a deliberately customized provider', async () => {
    const settingsPath = tempPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      ai: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
    }), 'utf8');
    const settings = await createSettingsService(settingsPath).load();
    expect(settings.ai.provider).toBe('openai');
    expect(settings.ai.model).toBe('gpt-4o');
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

  it('persists the inline AI provider/model overrides', async () => {
    const service = createSettingsService(tempPath());
    const settings = await service.save({ ai: { ...DEFAULTS.ai, inlineProvider: 'gemini', inlineModel: 'gemini-1.5-flash' } });
    expect(settings.ai.inlineProvider).toBe('gemini');
    expect(settings.ai.inlineModel).toBe('gemini-1.5-flash');
    // Defaults keep both empty so inline follows the assistant provider/model.
    expect(DEFAULTS.ai.inlineProvider).toBe('');
    expect(DEFAULTS.ai.inlineModel).toBe('');
  });
});
