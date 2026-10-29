'use strict';
/**
 * Deploy service — build & package the user's project from inside the IDE.
 *
 * Scope (deliberately honest, no fake hosting):
 *   - detect(): read the workspace's package.json (or a bare index.html) and
 *     infer the framework, package manager, build command and static output
 *     directory. Pure inspection — nothing is executed.
 *   - build(): run a build command to completion through the terminal service's
 *     runCapture (workspace-confined) and hand back its output + exit code.
 *   - exportBundle(): copy the build output into `.novacode/deploy/` inside the
 *     workspace, producing a portable static bundle (file count + byte size).
 *
 * Real hosting (Vercel/Netlify/GitHub Pages/S3/…) is intentionally NOT baked in
 * here: it needs third-party CLIs and the user's own account tokens, which we
 * never store or embed. The UI surfaces those as ready-to-run terminal commands
 * instead, so the actual publish step is transparent and owned by the user.
 *
 * Every path is resolved through pathGuard.resolveWithin first, so a crafted
 * target can never escape the opened workspace folder.
 */
const fsp = require('fs').promises;
const path = require('path');
const { resolveWithin } = require('../pathGuard');

const BUNDLE_DIR = path.join('.novacode', 'deploy');
const COMMON_OUTPUTS = ['dist', 'build', 'out', 'public', '_site', 'docs/_build'];

// Framework fingerprints keyed on a dependency name. `ssr` means the output is
// NOT a folder of static files (needs a server), so preview/export are limited.
const FRAMEWORKS = [
  { dep: 'vite', id: 'vite', output: 'dist' },
  { dep: 'react-scripts', id: 'create-react-app', output: 'build' },
  { dep: '@angular/cli', id: 'angular', output: 'dist' },
  { dep: 'astro', id: 'astro', output: 'dist' },
  { dep: '@sveltejs/kit', id: 'sveltekit', output: 'build', ssr: true },
  { dep: 'svelte', id: 'svelte', output: 'public' },
  { dep: 'vue', id: 'vue', output: 'dist' },
  { dep: '@11ty/eleventy', id: 'eleventy', output: '_site' },
  { dep: 'nuxt', id: 'nuxt', output: 'dist' },
  { dep: 'next', id: 'next', output: '.next', ssr: true },
  { dep: 'gatsby', id: 'gatsby', output: 'public' },
  { dep: 'gridsome', id: 'gridsome', output: 'dist' },
];

const LOCKFILES = [
  { file: 'pnpm-lock.yaml', pm: 'pnpm' },
  { file: 'yarn.lock', pm: 'yarn' },
  { file: 'bun.lockb', pm: 'bun' },
  { file: 'package-lock.json', pm: 'npm' },
];

async function exists(p) {
  try { await fsp.stat(p); return true; } catch { return false; }
}

async function isDirectory(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

/** Recursively copy `src` into `dest`, counting files and bytes. */
async function copyTree(src, dest) {
  let files = 0;
  let bytes = 0;
  async function walk(from, to) {
    await fsp.mkdir(to, { recursive: true });
    const entries = await fsp.readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      const fromPath = path.join(from, entry.name);
      const toPath = path.join(to, entry.name);
      if (entry.isDirectory()) {
        await walk(fromPath, toPath);
      } else if (entry.isFile()) {
        const buf = await fsp.readFile(fromPath);
        await fsp.writeFile(toPath, buf);
        files += 1;
        bytes += buf.length;
      }
    }
  }
  await walk(src, dest);
  return { files, bytes };
}

/**
 * @param {{
 *   runCapture?: (opts: { root: string, command: string, timeoutMs?: number }) => Promise<Object>,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 * }} [options] runCapture is injected from the terminal service (main process);
 *   tests pass a fake. It stays optional so detect/export work without it.
 */
function createDeployService({ runCapture, logger = console } = {}) {
  /** Inspect the workspace and infer a deploy profile. Executes nothing. */
  async function detect(root) {
    const abs = resolveWithin(root, root);
    const profile = {
      kind: 'unknown',
      hasPackageJson: false,
      framework: null,
      ssr: false,
      buildCommand: null,
      devCommand: null,
      scripts: {},
      packageManager: 'npm',
      projectName: null,
      outputDir: null,
      outputExists: false,
      warnings: [],
    };

    const pkgPath = path.join(abs, 'package.json');
    if (await exists(pkgPath)) {
      let pkg;
      try {
        pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8'));
        profile.hasPackageJson = true;
      } catch (error) {
        profile.warnings.push(`package.json could not be parsed: ${error.message}`);
        return profile;
      }

      profile.projectName = typeof pkg.name === 'string' ? pkg.name : null;
      profile.scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

      const match = FRAMEWORKS.find((f) => Object.prototype.hasOwnProperty.call(deps, f.dep));
      if (match) {
        profile.framework = match.id;
        profile.ssr = Boolean(match.ssr);
      }

      // Package manager from the lockfile actually present.
      for (const lf of LOCKFILES) {
        if (await exists(path.join(abs, lf.file))) { profile.packageManager = lf.pm; break; }
      }

      if (profile.scripts.build) profile.buildCommand = `${profile.packageManager} run build`;
      if (profile.scripts.dev) profile.devCommand = `${profile.packageManager} run dev`;
      if (profile.scripts.start && !profile.devCommand) profile.devCommand = `${profile.packageManager} run start`;

      // Resolve the output dir: framework default, else the first common dir
      // that exists, else the framework default (flagged as missing).
      const candidates = match
        ? [match.output, ...COMMON_OUTPUTS.filter((c) => c !== match.output)]
        : COMMON_OUTPUTS;
      let chosen = null;
      for (const c of candidates) {
        if (await isDirectory(path.join(abs, c))) { chosen = c; break; }
      }
      profile.outputDir = chosen || (match ? match.output : 'dist');
      profile.outputExists = await isDirectory(path.join(abs, profile.outputDir));

      if (!profile.scripts.build && !profile.outputExists) {
        profile.warnings.push('No "build" script and no known output folder found.');
      }
      profile.kind = 'node';
      if (profile.ssr) {
        profile.warnings.push(`${profile.framework} targets a server runtime; static preview/export only covers the client bundle.`);
      }
      return profile;
    }

    // No package.json: a static site is any root index.html.
    if (await exists(path.join(abs, 'index.html'))) {
      profile.kind = 'static';
      profile.outputDir = '.';
      profile.outputExists = true;
      return profile;
    }

    profile.warnings.push('No package.json or index.html found — nothing deployable at the workspace root.');
    return profile;
  }

  /** Run a build command to completion, confined to the workspace. */
  async function build(root, { command, timeoutMs = 300000 } = {}) {
    const abs = resolveWithin(root, root);
    if (typeof command !== 'string' || !command.trim()) {
      throw new Error('A build command is required.');
    }
    if (typeof runCapture !== 'function') {
      throw new Error('Deploy build is unavailable (terminal runner not wired).');
    }
    logger.info?.('deploy build start', { cwd: abs, command });
    const result = await runCapture({ root: abs, command: command.trim(), timeoutMs });
    logger.info?.('deploy build done', { command, code: result && result.code });
    return result;
  }

  /** Copy the build output into `.novacode/deploy/` (workspace-confined). */
  async function exportBundle(root, { outputDir } = {}) {
    const abs = resolveWithin(root, root);
    if (typeof outputDir !== 'string' || !outputDir.trim()) throw new Error('An output directory is required.');
    const src = resolveWithin(abs, outputDir.trim());
    if (!(await isDirectory(src))) throw new Error(`Build output folder not found: ${outputDir}. Run a build first.`);

    const dest = resolveWithin(abs, BUNDLE_DIR);
    // Start from a clean bundle so removed files do not linger.
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(dest), { recursive: true });

    const { files, bytes } = await copyTree(src, dest);
    logger.info?.('deploy export done', { dest, files, bytes });
    return { dest, files, bytes, sourceDir: src };
  }

  return { detect, build, exportBundle };
}

module.exports = { createDeployService, BUNDLE_DIR, FRAMEWORKS, COMMON_OUTPUTS };
