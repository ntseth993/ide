import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fsService from '../electron/services/fsService';

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'novacode-fs-'));
}

describe('fsService (against a real temp workspace)', () => {
  it('creates, reads, and lists files inside the workspace', async () => {
    const root = makeWorkspace();
    await fsService.createFolder(root, root, 'src');
    const { path: filePath } = await fsService.createFile(root, path.join(root, 'src'), 'index.js');
    await fsService.writeFile(root, filePath, 'console.log(1);\n');

    const content = await fsService.readFile(root, filePath);
    expect(content).toBe('console.log(1);\n');

    const tree = await fsService.readTree(root, root);
    const src = tree.find((node) => node.name === 'src');
    expect(src.type).toBe('folder');
    expect(src.children.map((child) => child.name)).toEqual(['index.js']);
  });

  it('ignores dependency and build folders in the tree', async () => {
    const root = makeWorkspace();
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), 'x');
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, 'keep.txt'), 'keep');
    const tree = await fsService.readTree(root, root);
    expect(tree.map((node) => node.name)).toEqual(['keep.txt']);
  });

  it('refuses to read or write outside the workspace', async () => {
    const root = makeWorkspace();
    const outside = path.join(path.dirname(root), 'outside.txt');
    await expect(fsService.readFile(root, outside)).rejects.toThrow(/Access outside/);
    await expect(fsService.writeFile(root, '../escape.txt', 'no')).rejects.toThrow(/Access outside/);
    await expect(fsService.remove(root, path.join(root, '..'))).rejects.toThrow(/Access outside/);
  });

  it('refuses to delete the workspace root', async () => {
    const root = makeWorkspace();
    await expect(fsService.remove(root, root)).rejects.toThrow(/workspace folder itself/);
  });

  it('rejects oversized files when reading', async () => {
    const root = makeWorkspace();
    const { path: bigPath } = await fsService.createFile(root, root, 'big.txt');
    await fsService.writeFile(root, bigPath, 'x'.repeat(fsService.MAX_READ_BYTES + 1));
    await expect(fsService.readFile(root, bigPath)).rejects.toThrow(/too large/);
  });

  it('renames with a safe new name and refuses unsafe ones', async () => {
    const root = makeWorkspace();
    const { path: filePath } = await fsService.createFile(root, root, 'a.txt');
    const { path: renamed } = await fsService.rename(root, filePath, 'b.txt');
    expect(renamed).toBe(path.join(root, 'b.txt'));
    await expect(fsService.rename(root, renamed, 'x/y')).rejects.toThrow(/not allowed in file names/);
  });

  it('fails when creating a file that already exists', async () => {
    const root = makeWorkspace();
    await fsService.createFile(root, root, 'dup.txt');
    await expect(fsService.createFile(root, root, 'dup.txt')).rejects.toThrow();
  });

  it('searches file contents across the workspace', async () => {
    const root = makeWorkspace();
    await fsService.writeFile(root, path.join(root, 'one.txt'), 'alpha beta\nnothing here\n');
    await fsService.writeFile(root, path.join(root, 'two.txt'), 'BETA gamma\n');
    const result = await fsService.search(root, { query: 'beta' });
    expect(result.results).toHaveLength(2);
    expect(result.results[0].line).toBe(1);

    const caseSensitive = await fsService.search(root, { query: 'BETA', caseSensitive: true });
    expect(caseSensitive.results).toHaveLength(1);
    expect(caseSensitive.results[0].path).toBe(path.join(root, 'two.txt'));
  });

  it('rejects invalid regular expressions with a clear error', async () => {
    const root = makeWorkspace();
    await expect(fsService.search(root, { query: '([unclosed', isRegex: true })).rejects.toThrow(/Invalid search pattern/);
  });

  it('mkdirp creates nested folders and refuses to escape the workspace', async () => {
    const root = makeWorkspace();
    const { path: made } = await fsService.mkdirp(root, path.join('src', 'components', 'layout'));
    expect(fs.existsSync(made)).toBe(true);
    // Creating the root itself is a no-op, not an error.
    await expect(fsService.mkdirp(root, root)).resolves.toMatchObject({ path: path.resolve(root) });
    await expect(fsService.mkdirp(root, '../escape')).rejects.toThrow(/Access outside/);
  });

  it('move relocates an item inside the workspace and keeps it confined', async () => {
    const root = makeWorkspace();
    await fsService.mkdirp(root, path.join(root, 'components'));
    const { path: file } = await fsService.createFile(root, root, 'Navbar.jsx');
    const { path: moved } = await fsService.move(root, file, path.join(root, 'components'));
    expect(moved).toBe(path.join(root, 'components', 'Navbar.jsx'));
    expect(fs.existsSync(moved)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    // A move that would land outside the workspace is rejected before any rename.
    await expect(fsService.move(root, moved, '..')).rejects.toThrow(/Access outside/);
    // The workspace root itself can never be moved.
    await expect(fsService.move(root, root, root)).rejects.toThrow(/workspace folder itself/);
  });
});
