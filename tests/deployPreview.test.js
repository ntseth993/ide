/**
 * Preview server tests — a REAL loopback HTTP server over a temp build folder.
 * Verifies serving, content types, SPA fallback, 404s and — critically — that
 * path traversal and dotfiles can never be served.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { createPreviewServer } from '../electron/services/deploy/previewServer';

const quiet = { info() {}, warn() {}, error() {} };
let root;      // acts as the workspace root
let buildDir;  // the folder we serve (root/dist)
let server;

function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function get(url, encoding = 'utf8') {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(encoding) }));
    }).on('error', reject);
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-test-'));
  buildDir = path.join(root, 'dist');
  write(buildDir, 'index.html', '<html><body>home</body></html>');
  write(buildDir, 'style.css', 'body{color:red}');
  write(buildDir, '.hidden', 'secret-dotfile');
  // A file OUTSIDE the served folder that traversal must not reach.
  write(root, 'secret.txt', 'TOP-SECRET');
  server = createPreviewServer({ logger: quiet });
});

afterEach(async () => {
  await server.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('preview server — static serving over loopback', () => {
  it('starts, reports a loopback URL, and serves index.html at /', async () => {
    const st = await server.start({ root, dir: 'dist' });
    expect(st.running).toBe(true);
    expect(st.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const res = await get(st.url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('home');
  });

  it('assigns the right content type per extension', async () => {
    const st = await server.start({ root, dir: 'dist' });
    const res = await get(`${st.url}style.css`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/css/);
  });

  it('falls back to index.html for extension-less routes (SPA)', async () => {
    const st = await server.start({ root, dir: 'dist' });
    const res = await get(`${st.url}some/client/route`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('home');
  });

  it('404s a genuinely missing asset file', async () => {
    const st = await server.start({ root, dir: 'dist' });
    const res = await get(`${st.url}missing.js`);
    expect(res.status).toBe(404);
  });

  it('refuses path traversal outside the served folder', async () => {
    const st = await server.start({ root, dir: 'dist' });
    // %2e%2e = '..' so the raw request path is not normalised by the client.
    // Whether the guard 403s it or the collapsed path just misses inside the
    // served folder, the secret file above the root must NEVER be served.
    const res = await get(`${st.url}%2e%2e/secret.txt`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(200);
    expect(res.body).not.toContain('TOP-SECRET');
  });

  it('never serves dotfiles from inside the folder', async () => {
    const st = await server.start({ root, dir: 'dist' });
    const res = await get(`${st.url}.hidden`);
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('secret-dotfile');
  });

  it('stop() releases the server and updates status', async () => {
    await server.start({ root, dir: 'dist' });
    const stopped = await server.stop();
    expect(stopped.running).toBe(false);
    expect(server.status().url).toBeNull();
  });

  it('start() rejects a folder that does not exist', async () => {
    await expect(server.start({ root, dir: 'nope' })).rejects.toThrow(/does not exist/i);
  });
});
