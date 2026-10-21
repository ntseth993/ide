/**
 * Remote registry (Open VSX) tests.
 *
 * Network is faked with an injected fetch, and a real (tiny) VSIX is built in
 * memory so the install path exercises the full flow: fetch detail -> download
 * package -> read package.json -> import only the declarative snippets. Asserts
 * NovaCode's stance holds — a marketplace install never carries executable code
 * into the manifest, only snippets we can render in Monaco.
 */
import { describe, it, expect, vi } from 'vitest';
import zlib from 'node:zlib';
import { createExtensionRegistry } from '../electron/services/extensionRegistry';

function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const uncompressed = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const method = file.method || 0;
    const data = method === 8 ? zlib.deflateRawSync(uncompressed) : uncompressed;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(uncompressed.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(uncompressed.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const body = Buffer.concat(locals);
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cd, eocd]);
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

/** Return a fetch response whose arrayBuffer() yields the given Buffer's bytes. */
function bufferResponse(buffer) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

describe('registry helpers', () => {
  const registry = createExtensionRegistry({ extensions: {} });

  it('coerces odd versions to semver', () => {
    expect(registry.safeSemver('1.2.3')).toBe('1.2.3');
    expect(registry.safeSemver('2024.1')).toBe('2024.1.0');
    expect(registry.safeSemver('latest')).toBe('0.0.0');
  });

  it('builds a publisher.name id that passes validation', () => {
    expect(registry.safeId('Ms-Python', 'python')).toBe('ms-python.python');
    expect(registry.safeId('a b', 'c.d')).toBe('a-b.c-d');
  });

  it('normalizes a raw search result', () => {
    const item = registry.normalizeSearchResult({
      namespace: 'ms-python', name: 'python', version: '2024.1.0',
      description: 'IntelliSense', downloadCount: 12345,
      files: { icon: 'https://i/x.png', download: 'https://d/x.vsix' },
    });
    expect(item).toMatchObject({
      id: 'ms-python.python', publisher: 'ms-python', displayName: 'python',
      downloadCount: 12345, iconUrl: 'https://i/x.png', downloadUrl: 'https://d/x.vsix',
    });
  });
});

describe('registry.search', () => {
  it('queries the registry and normalizes results', async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(url).toContain('/-/search');
      expect(url).toContain('query=python');
      return jsonResponse({
        total: 1,
        extensions: [{ namespace: 'ms-python', name: 'python', version: '1.0.0', description: 'd', downloadCount: 5 }],
      });
    });
    const registry = createExtensionRegistry({ extensions: {}, fetchImpl });
    const { results, total } = await registry.search({ query: 'python' });
    expect(total).toBe(1);
    expect(results[0]).toMatchObject({ id: 'ms-python.python', downloadCount: 5 });
  });

  it('surfaces a friendly message when the network fails', async () => {
    const registry = createExtensionRegistry({
      extensions: {},
      fetchImpl: async () => { throw new Error('ECONNRESET'); },
    });
    await expect(registry.search({ query: 'x' })).rejects.toThrow(/internet connection/i);
  });
});

describe('registry.install', () => {
  it('downloads a VSIX and imports only the declarative snippets', async () => {
    const pkg = {
      name: 'bar',
      displayName: 'Bar Snippets',
      version: '1.2.3',
      description: 'Handy JS snippets.',
      contributes: { snippets: [{ language: 'javascript', path: './snippets/js.json' }] },
    };
    const snippets = { log: { prefix: 'log', body: ['console.log($1)'], description: 'Log line' } };
    const vsix = makeZip([
      { name: '[Content_Types].xml', data: '<xml/>' },
      { name: 'extension/package.json', data: JSON.stringify(pkg), method: 8 },
      { name: 'extension/snippets/js.json', data: JSON.stringify(snippets), method: 8 },
    ]);
    const detail = {
      namespace: 'foo', name: 'bar', displayName: 'Bar', version: '1.2.3',
      description: 'desc', tags: ['snippets'],
      files: { download: 'https://registry/foo-bar-1.2.3.vsix' },
    };
    const fetchImpl = async (url) => (
      String(url).endsWith('.vsix') ? bufferResponse(vsix) : jsonResponse(detail)
    );

    const installRemote = vi.fn(async (manifest) => ({ ok: true, manifest }));
    const registry = createExtensionRegistry({ extensions: { installRemote }, fetchImpl });

    const result = await registry.install({ namespace: 'foo', name: 'bar' });
    expect(installRemote).toHaveBeenCalledTimes(1);
    const manifest = installRemote.mock.calls[0][0];
    expect(manifest.id).toBe('foo.bar');
    expect(manifest.categories).toContain('snippets');
    expect(manifest.contributes.snippets.javascript[0]).toEqual({
      prefix: 'log', body: 'console.log($1)', description: 'Log line',
    });
    // No executable surface is ever carried through.
    expect(manifest.permissions).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('installs a code-only extension as inert (no snippets, still valid)', async () => {
    const pkg = { name: 'x', publisher: 'foo', version: '1.0.0', description: 'a theme', contributes: { themes: [{ label: 't', path: './t.json' }] } };
    const vsix = makeZip([{ name: 'extension/package.json', data: JSON.stringify(pkg) }]);
    const detail = { namespace: 'foo', name: 'x', version: '1.0.0', description: 'a theme', tags: ['theme'], files: { download: 'https://r/x.vsix' } };
    const fetchImpl = async (url) => (
      String(url).endsWith('.vsix') ? bufferResponse(vsix) : jsonResponse(detail)
    );
    const installRemote = vi.fn(async (manifest) => ({ ok: true, manifest }));
    const registry = createExtensionRegistry({ extensions: { installRemote }, fetchImpl });
    await registry.install({ namespace: 'foo', name: 'x' });
    const manifest = installRemote.mock.calls[0][0];
    expect(manifest.contributes.snippets).toBeUndefined();
    expect(manifest.categories).toEqual(['themes']);
  });

  it('rejects when no package can be downloaded', async () => {
    const registry = createExtensionRegistry({
      extensions: { installRemote: vi.fn() },
      fetchImpl: async () => jsonResponse({ namespace: 'foo', name: 'bar', files: {} }),
    });
    await expect(registry.install({ namespace: 'foo', name: 'bar' })).rejects.toThrow(/no downloadable package/i);
  });
});
