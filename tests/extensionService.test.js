/**
 * Extension manager service tests.
 *
 * Uses a real temp directory so install/uninstall exercise the actual
 * state file, with the bundled sample catalog. Pins the security posture:
 * declarative manifests only, engine ranges enforced, unknown ids refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createExtensionService,
  validateManifest,
  compareVersions,
  satisfiesEngine,
} from '../electron/services/extensionService';
import { CATALOG } from '../electron/services/extensionCatalog';

let tmpDir;
let service;

const THEME_ID = CATALOG[0].manifest.id;
const SNIPPETS_ID = CATALOG[1].manifest.id;
const FORMATTER_ID = CATALOG[2].manifest.id;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ext-'));
  service = createExtensionService({ userDataDir: tmpDir, appVersion: '0.2.0', logger: { info() {} } });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('validateManifest', () => {
  it('accepts a well-formed catalog manifest', () => {
    expect(() => validateManifest(CATALOG[0].manifest)).not.toThrow();
  });

  it('rejects missing required fields', () => {
    expect(() => validateManifest({ id: 'a.b' })).toThrow(/"name" is required/);
    expect(() => validateManifest(null)).toThrow(/must be an object/);
  });

  it('rejects malformed ids and versions', () => {
    expect(() => validateManifest({
      ...CATALOG[0].manifest, id: 'not-an-id',
    })).toThrow(/publisher\.name/);
    expect(() => validateManifest({
      ...CATALOG[0].manifest, version: 'one.two',
    })).toThrow(/semver/);
  });

  it('rejects unknown categories and bad engine ranges', () => {
    expect(() => validateManifest({
      ...CATALOG[0].manifest, categories: ['crypto-miner'],
    })).toThrow(/Unknown extension category/);
    expect(() => validateManifest({
      ...CATALOG[0].manifest, engines: { nova: 'latest' },
    })).toThrow(/>=x\.y\.z/);
  });
});

describe('version helpers', () => {
  it('compares dotted versions numerically', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.1.0', '1.0.9')).toBe(1);
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1);
  });

  it('evaluates >= engine ranges', () => {
    expect(satisfiesEngine('>=0.2.0', '0.2.0')).toBe(true);
    expect(satisfiesEngine('>=0.2.0', '0.3.1')).toBe(true);
    expect(satisfiesEngine('>=0.2.0', '0.1.9')).toBe(false);
    expect(satisfiesEngine('latest', '9.9.9')).toBe(false);
  });
});

describe('createExtensionService', () => {
  it('lists the sample catalog as available with the example flag', async () => {
    const state = await service.list();
    expect(state.exampleCatalog).toBe(true);
    expect(state.installed).toEqual([]);
    expect(state.available.map((entry) => entry.manifest.id)).toEqual([THEME_ID, SNIPPETS_ID, FORMATTER_ID]);
  });

  it('installs an extension, enabled by default, and persists state', async () => {
    await service.install(THEME_ID);
    let state = await service.list();
    expect(state.installed).toHaveLength(1);
    expect(state.installed[0].enabled).toBe(true);
    expect(state.installed[0].source).toBe('bundled-catalog');
    expect(state.available).toHaveLength(2);
    // State survives a fresh service instance (real file on disk).
    const reopened = createExtensionService({ userDataDir: tmpDir, appVersion: '0.2.0' });
    state = await reopened.list();
    expect(state.installed).toHaveLength(1);
  });

  it('refuses unknown catalog ids and duplicate installs', async () => {
    await expect(service.install('ghost.nonexistent')).rejects.toThrow(/not in the catalog/);
    await service.install(FORMATTER_ID);
    await expect(service.install(FORMATTER_ID)).rejects.toThrow(/already installed/);
  });

  it('refuses installs whose engine range exceeds the running version', async () => {
    const strict = createExtensionService({ userDataDir: tmpDir, appVersion: '0.1.0', logger: { info() {} } });
    await expect(strict.install(THEME_ID)).rejects.toThrow(/requires NovaCode >=0\.2\.0/);
  });

  it('disables and re-enables without uninstalling', async () => {
    await service.install(SNIPPETS_ID);
    await service.setEnabled(SNIPPETS_ID, false);
    expect((await service.list()).installed[0].enabled).toBe(false);
    await service.setEnabled(SNIPPETS_ID, true);
    expect((await service.list()).installed[0].enabled).toBe(true);
    await expect(service.setEnabled('ghost.nonexistent', true)).rejects.toThrow(/not installed/);
  });

  it('uninstalls and returns the extension to the available list', async () => {
    await service.install(THEME_ID);
    await service.uninstall(THEME_ID);
    const state = await service.list();
    expect(state.installed).toEqual([]);
    expect(state.available.some((entry) => entry.manifest.id === THEME_ID)).toBe(true);
    await expect(service.uninstall(THEME_ID)).rejects.toThrow(/not installed/);
  });

  it('reports up-to-date extensions instead of fake updates', async () => {
    await service.install(SNIPPETS_ID);
    const result = await service.update(SNIPPETS_ID);
    expect(result.updated).toBe(false);
    expect(result.version).toBe('1.1.0');
    await expect(service.update('ghost.nonexistent')).rejects.toThrow(/not in the catalog/);
  });

  it('installs a registry manifest as declarative, re-install updates in place', async () => {
    const manifest = {
      id: 'openai.chat',
      name: 'Chat',
      publisher: 'openai',
      version: '1.2.3',
      description: 'Marketplace snippets',
      categories: ['snippets'],
      engines: { nova: '>=0.2.0' },
      permissions: [],
      contributes: { snippets: { javascript: [{ prefix: 'log', body: 'console.log($1)', description: 'log' }] } },
    };
    await service.installRemote(manifest);
    let state = await service.list();
    expect(state.installed).toHaveLength(1);
    expect(state.installed[0].source).toBe('registry');
    expect(state.installed[0].enabled).toBe(true);
    expect(state.installed[0].manifest.contributes.snippets.javascript[0].prefix).toBe('log');
    // Re-installing the same id updates rather than duplicating.
    await service.installRemote({ ...manifest, version: '1.2.4' });
    state = await service.list();
    expect(state.installed).toHaveLength(1);
    expect(state.installed[0].manifest.version).toBe('1.2.4');
  });

  it('rejects an invalid registry manifest', async () => {
    await expect(service.installRemote({ id: 'bad id', name: 'x' })).rejects.toThrow();
  });
});
