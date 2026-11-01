/**
 * Build-time endpoint baking + runtime reader.
 *
 * Two modules are under test:
 *   - scripts/generate-live-config.js  (writes liveConfig.generated.js at
 *     packaging time; hard-fails on a placeholder / empty / non-https URL
 *     when NODE_ENV=production)
 *   - electron/services/novalink/liveConfig.js  (reads the generated file
 *     at main-process boot; falls back to process.env.NOVALINK_LIVE_URL)
 *
 * Together they are the enforcement behind acceptance test #11 ("no
 * placeholder URLs in production builds") and the mechanism that lets an
 * ordinary user install NovaCode without ever seeing a server URL field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The generator module writes to a hardcoded path under the repo. We give
// every test a fresh temp dir by monkey-patching fs.writeFileSync / existsSync
// / mkdirSync for the duration of the run so no test dirties the real tree.
function withTempOut(fn) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'novalink-live-config-'));
  const realExists = fs.existsSync;
  const realWrite = fs.writeFileSync;
  const realMkdir = fs.mkdirSync;
  const calls = [];
  fs.existsSync = (p) => (String(p).startsWith(tmpRoot) ? true : realExists(p));
  fs.writeFileSync = (p, body, enc) => {
    if (String(p).includes('liveConfig.generated.js')) {
      calls.push({ p: String(p), body: String(body), enc });
      return realWrite(path.join(tmpRoot, 'liveConfig.generated.js'), body, enc);
    }
    return realWrite(p, body, enc);
  };
  fs.mkdirSync = (p, opts) => {
    if (String(p).startsWith(tmpRoot)) return realMkdir(p, opts);
    return realMkdir(p, opts);
  };
  try {
    return fn({ tmpRoot, calls });
  } finally {
    fs.existsSync = realExists;
    fs.writeFileSync = realWrite;
    fs.mkdirSync = realMkdir;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

describe('scripts/generate-live-config.js classify()', () => {
  const { classify } = require('../scripts/generate-live-config.js');

  it('flags missing / non-string / whitespace-only input as empty', () => {
    expect(classify(undefined)).toMatchObject({ ok: false, reason: 'empty' });
    expect(classify(null)).toMatchObject({ ok: false, reason: 'empty' });
    expect(classify('')).toMatchObject({ ok: false, reason: 'empty' });
    expect(classify('   ')).toMatchObject({ ok: false, reason: 'empty' });
    expect(classify(42)).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('flags unparseable input as malformed', () => {
    expect(classify('not a url')).toMatchObject({ ok: false, reason: 'malformed' });
    expect(classify('https://')).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('flags non-http(s) protocols', () => {
    expect(classify('ftp://link.test/')).toMatchObject({ ok: false, reason: 'protocol' });
    expect(classify('ws://link.test/')).toMatchObject({ ok: false, reason: 'protocol' });
  });

  it('accepts a real https host and normalises it via URL', () => {
    const result = classify('  https://link.novacode.app/  ');
    expect(result).toMatchObject({ ok: true, protocol: 'https:', host: 'link.novacode.app' });
    expect(result.value).toBe('https://link.novacode.app/');
  });

  it('accepts http with a port (dev-loopback path)', () => {
    const result = classify('http://127.0.0.1:8790');
    expect(result.ok).toBe(true);
    expect(result.protocol).toBe('http:');
  });
});

describe('scripts/generate-live-config.js PLACEHOLDER_PATTERNS', () => {
  const { PLACEHOLDER_PATTERNS } = require('../scripts/generate-live-config.js');

  const isPlaceholder = (url) => PLACEHOLDER_PATTERNS.some((p) => p.test(url));

  it('matches the documented placeholder hosts', () => {
    expect(isPlaceholder('https://link.example.com/')).toBe(true);
    expect(isPlaceholder('https://example.org/')).toBe(true);
    expect(isPlaceholder('http://localhost:8790/')).toBe(true);
    expect(isPlaceholder('http://127.0.0.1:8790/')).toBe(true);
    expect(isPlaceholder('http://0.0.0.0:8790/')).toBe(true);
    expect(isPlaceholder('http://[::1]:8790/')).toBe(true);
    expect(isPlaceholder('https://your.host/link')).toBe(true);
    expect(isPlaceholder('https://change-me.fly.dev/')).toBe(true);
  });

  it('does NOT match real looking hosts', () => {
    expect(isPlaceholder('https://link.novacode.app/')).toBe(false);
    expect(isPlaceholder('https://my-app.fly.dev/')).toBe(false);
    expect(isPlaceholder('https://novacode-link.onrender.com/')).toBe(false);
    // A domain that merely contains "example" as a substring should not trip.
    expect(isPlaceholder('https://foo-example.bar/')).toBe(false);
  });
});

describe('scripts/generate-live-config.js main()', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  function freshGenerator() {
    // Re-require under a different cache key so `require.main === module`
    // stays false and nothing runs on import. We only invoke main() directly.
    const key = require.resolve('../scripts/generate-live-config.js');
    delete require.cache[key];
    return require('../scripts/generate-live-config.js');
  }

  it('throws on production build with empty URL', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.NOVA_PACK;
    process.env.NOVALINK_LIVE_URL = '';
    const { main } = freshGenerator();
    expect(main).toThrow(/NOVALINK_LIVE_URL is required/);
  });

  it('throws on production build with malformed URL', () => {
    process.env.NODE_ENV = 'production';
    process.env.NOVALINK_LIVE_URL = 'nonsense';
    const { main } = freshGenerator();
    expect(main).toThrow(/not a valid absolute http\(s\) URL/);
  });

  it('throws on production build with a placeholder-looking URL', () => {
    process.env.NODE_ENV = 'production';
    process.env.NOVALINK_LIVE_URL = 'https://link.example.com';
    const { main } = freshGenerator();
    expect(main).toThrow(/looks like a placeholder/);
  });

  it('throws on production build using http (not https)', () => {
    process.env.NODE_ENV = 'production';
    process.env.NOVALINK_LIVE_URL = 'http://link.novacode.app';
    const { main } = freshGenerator();
    expect(main).toThrow(/must use https/);
  });

  it('writes the generated file when production URL is real and https', () => {
    process.env.NODE_ENV = 'production';
    process.env.NOVALINK_LIVE_URL = 'https://link.novacode.app';
    withTempOut(({ calls }) => {
      const { main } = freshGenerator();
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      main();
      writeSpy.mockRestore();
      expect(calls).toHaveLength(1);
      const body = calls[0].body;
      expect(body).toMatch(/module\.exports = \{ baseUrl: "https:\/\/link\.novacode\.app\/" \}/);
      expect(body).toMatch(/GENERATED by scripts\/generate-live-config\.js/);
      expect(body).toMatch(/NODE_ENV=production/);
    });
  });

  it('dev build with empty URL writes an unconfigured file rather than throwing', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.NOVA_PACK;
    process.env.NOVALINK_LIVE_URL = '';
    withTempOut(({ calls }) => {
      const { main } = freshGenerator();
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      expect(() => main()).not.toThrow();
      // The stdout summary calls out "(unconfigured — dev only)" so a human
      // running `npm run dev` notices immediately in the build log.
      expect(writeSpy.mock.calls.map((c) => String(c[0])).join('')).toMatch(/unconfigured/);
      writeSpy.mockRestore();
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toMatch(/baseUrl: ""/);
    });
  });

  it('dev build tolerates a localhost URL', () => {
    process.env.NODE_ENV = 'development';
    process.env.NOVALINK_LIVE_URL = 'http://127.0.0.1:8790';
    withTempOut(({ calls }) => {
      const { main } = freshGenerator();
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      expect(() => main()).not.toThrow();
      writeSpy.mockRestore();
      expect(calls[0].body).toMatch(/baseUrl: "http:\/\/127\.0\.0\.1:8790\/"/);
    });
  });
});

describe('electron/services/novalink/liveConfig.js', () => {
  const key = require.resolve('../electron/services/novalink/liveConfig.js');
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete require.cache[key];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns empty string when neither the generated file nor the env is set', () => {
    delete process.env.NOVALINK_LIVE_URL;
    // No liveConfig.generated.js exists on a clean checkout (gitignored).
    const liveConfig = require(key);
    liveConfig.__resetForTests();
    expect(liveConfig.getBaseUrl()).toBe('');
  });

  it('falls back to process.env.NOVALINK_LIVE_URL when the generated file is absent', () => {
    process.env.NOVALINK_LIVE_URL = '  https://from-env.test/  ';
    const liveConfig = require(key);
    liveConfig.__resetForTests();
    expect(liveConfig.getBaseUrl()).toBe('https://from-env.test/');
  });

  it('memoizes across calls and resets via __resetForTests', () => {
    process.env.NOVALINK_LIVE_URL = 'https://first.test/';
    const liveConfig = require(key);
    liveConfig.__resetForTests();
    expect(liveConfig.getBaseUrl()).toBe('https://first.test/');
    process.env.NOVALINK_LIVE_URL = 'https://second.test/';
    // Still the first value — proves caching.
    expect(liveConfig.getBaseUrl()).toBe('https://first.test/');
    liveConfig.__resetForTests();
    expect(liveConfig.getBaseUrl()).toBe('https://second.test/');
  });

  it('prefers the generated file when it exists', () => {
    // Synthesize a liveConfig.generated.js next to liveConfig.js, then
    // require fresh; assert the loader reads it before consulting the env.
    const generatedPath = path.join(
      path.dirname(require.resolve(key)),
      'liveConfig.generated.js',
    );
    const preExisting = fs.existsSync(generatedPath);
    if (preExisting) {
      // Should never happen in CI (file is gitignored), but do not stomp a
      // developer's local build artifact.
      return;
    }
    try {
      fs.writeFileSync(
        generatedPath,
        `'use strict';\nmodule.exports = { baseUrl: 'https://from-generated.test/' };\n`,
        'utf8',
      );
      delete require.cache[key];
      const liveConfig = require(key);
      liveConfig.__resetForTests();
      process.env.NOVALINK_LIVE_URL = 'https://ignored-env.test/';
      expect(liveConfig.getBaseUrl()).toBe('https://from-generated.test/');
    } finally {
      try { fs.rmSync(generatedPath, { force: true }); } catch { /* best effort */ }
    }
  });
});
