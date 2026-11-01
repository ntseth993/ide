'use strict';
/**
 * Deploy service — build, package and ship the user's project from inside the IDE.
 *
 * Responsibilities:
 *   - detect(): read the workspace's package.json (or a bare index.html) and
 *     infer the framework, package manager, build command and output directory.
 *     Also reports the things a real deployment needs to know before it starts:
 *     whether dependencies are installed, what the provider's own config files
 *     say, whether the app has a backend that a static upload would silently
 *     drop, and whether the host has to build it. Pure inspection — nothing is
 *     executed.
 *   - build(): run a build command to completion through the terminal service's
 *     runCapture (workspace-confined) and hand back its output + exit code.
 *   - exportBundle(): copy the build output into `.novacode/deploy/` inside the
 *     workspace, producing a portable static bundle (file count + byte size).
 *
 * Publishing itself lives in ./providers (real Vercel + Netlify REST adapters)
 * and ./sourceFiles (what is allowed to leave the machine). This module stays
 * execution-free so it can be tested against plain temp folders.
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

// A server the static hosts will not run. Uploading only the frontend of one of
// these would produce a live URL that 404s on every API call, so detection has
// to say so out loud instead of letting the deploy look like a success.
const BACKEND_DEPS = [
  'express', 'fastify', 'koa', 'hapi', '@hapi/hapi', 'restify', 'hono', '@hono/hono',
  'socket.io', 'ws', '@nestjs/core', 'graphql-yoga', 'apollo-server', 'apollo-server-express',
  'body-parser', 'cors',
];

// Needs a runtime on the host: static file upload can never be a complete deploy.
const SERVER_FRAMEWORKS = new Set(['next', 'nuxt', 'sveltekit', 'remix']);

// A root entry point that is plainly a server. Deliberately narrow and anchored
// on the file name: `"main": "dist/index.js"` is a library, not a backend, and a
// false positive here would force the user to acknowledge a backend that does not
// exist. Ambiguous names (index.js) are left out on purpose.
const SERVER_ENTRY = /^(server|app|api|backend|bot)([._-][a-z0-9]+)?\.(js|mjs|cjs|ts)$/i;

async function exists(p) {
  try { await fsp.stat(p); return true; } catch { return false; }
}

async function isDirectory(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

async function readText(p) {
  try { return await fsp.readFile(p, 'utf8'); } catch { return null; }
}

/** `netlify.toml` -> { publish, buildCommand } (regex-level, no TOML dependency). */
function parseNetlifyToml(text) {
  if (!text) return null;
  const publish = /^\s*publish\s*=\s*["']([^"']+)["']/m.exec(text);
  const command = /^\s*command\s*=\s*["']([^"']+)["']/m.exec(text);
  const target = /^\s*target\s*=\s*["']([^"']+)["']/m.exec(text);
  return {
    publish: publish ? publish[1] : null,
    buildCommand: command ? command[1] : null,
    targetDir: target ? target[1] : null,
  };
}

/** `vercel.json` -> { outputDirectory, framework, buildCommand } when present. */
function parseVercelJson(text) {
  if (!text) return null;
  try {
    const json = JSON.parse(text);
    return {
      outputDirectory: json.outputDirectory || json.build && json.build.output || null,
      framework: json.framework === undefined ? null : json.framework,
      buildCommand: json.buildCommand === undefined ? null : json.buildCommand,
      installCommand: json.installCommand === undefined ? null : json.installCommand,
      functions: Boolean(json.functions || json.builds),
    };
  } catch {
    return null;
  }
}

/** `vite.config.*` -> the configured `build.outDir`, which overrides 'dist'. */
function parseViteOutDir(text) {
  if (!text) return null;
  const match = /outDir\s*:\s*["'`]([^"'`]+)["'`]/.exec(text);
  return match ? match[1].replace(/^\.\//, '') : null;
}

/** Does this Next.js config ask for a fully static export (deployable anywhere)? */
function parseNextStaticExport(text) {
  if (!text) return false;
  return /output\s*:\s*["']export["']/.test(text);
}

/**
 * Turn the raw inspection into a deployment decision.
 *
 * The important part is honesty about scope: an SSR framework (Next/Nuxt/SvelteKit)
 * needs a runtime, so uploading its `.next` folder as static files is not a
 * deployment — that case becomes `provider-build` and only a host that can build
 * is able to take it. A separate Express/API backend is reported as *excluded*
 * rather than quietly folded into "deployed".
 */
function applyDeployClassification(profile) {
  const needsServer = SERVER_FRAMEWORKS.has(profile.framework) && !profile.providerConfig.nextStaticExport;

  if (needsServer) {
    profile.targetKind = 'server';
    profile.deployMode = 'provider-build';
    profile.warnings.push(
      `${profile.framework} renders on the server. NovaCode uploads your source and lets ${profile.framework === 'next' ? 'the host run the build' : 'the host install and build it'} so the server side actually exists — a static file upload would only ship the client bundle.`,
    );
  } else if (profile.scripts.build) {
    profile.targetKind = 'static';
    profile.deployMode = 'prebuilt';
  } else if (profile.outputExists) {
    profile.targetKind = 'static';
    profile.deployMode = 'prebuilt';
  } else {
    profile.targetKind = 'static';
    profile.deployMode = 'prebuilt';
    profile.blockers.push('No build script and no output folder: add a build script or pick the folder to upload.');
    profile.deployable = false;
  }

  if (profile.backend.detected && profile.targetKind === 'static' && profile.deployMode === 'prebuilt') {
    profile.frontendOnly = true;
    profile.warnings.push(
      `Server-side code was detected (${profile.backend.evidence.filter(Boolean).slice(0, 3).join(', ')}). Only the static output will be published, so those endpoints will not exist at the new URL. Point the app at an already-deployed API, or choose a provider that runs servers.`,
    );
  }

  // Last, so it wins over the branches above: an Electron app's renderer only
  // works inside the desktop shell. Publishing it is not an incomplete deploy,
  // it is a deploy of something that cannot function at all, and the user
  // deserves to be told that before a single file is uploaded.
  if (profile.desktop && profile.desktop.detected) {
    profile.deployable = false;
    profile.blockers.push(
      `This is an Electron desktop app (${profile.desktop.evidence.join(', ')}). Its interface needs the main process, so a web host would publish a page that cannot open files, run a terminal or save anything. Package an installer to distribute the app, or open the folder that is meant to be the website instead.`,
    );
  }
  return profile;
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
      // ---- deployment planning -------------------------------------------
      nodeModulesInstalled: false,
      dependencies: {},
      providerConfig: { vercel: null, netlify: null, viteOutDir: null, nextStaticExport: false },
      backend: { detected: false, evidence: [] },
      // An Electron shell is not a web target; see applyDeployClassification.
      desktop: { detected: false, evidence: [] },
      // 'prebuilt'  = ship the local build output as static files
      // 'provider-build' = the host must install + build from uploaded source
      deployMode: 'prebuilt',
      targetKind: 'static',
      deployable: true,
      blockers: [],
      // True when a static upload will knowingly leave a backend behind.
      frontendOnly: false,
    };

    const pkgPath = path.join(abs, 'package.json');
    if (await exists(pkgPath)) {
      let pkg;
      try {
        pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8'));
        profile.hasPackageJson = true;
      } catch (error) {
        profile.warnings.push(`package.json could not be parsed: ${error.message}`);
        profile.blockers.push('package.json is not valid JSON — fix it before deploying.');
        profile.deployable = false;
        return profile;
      }

      profile.projectName = typeof pkg.name === 'string' ? pkg.name : null;
      profile.scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      profile.dependencies = deps;

      const match = FRAMEWORKS.find((f) => Object.prototype.hasOwnProperty.call(deps, f.dep));
      if (match) {
        profile.framework = match.id;
        profile.ssr = Boolean(match.ssr);
      }

      // Package manager from the lockfile actually present.
      for (const lf of LOCKFILES) {
        if (await exists(path.join(abs, lf.file))) { profile.packageManager = lf.pm; break; }
      }

      profile.nodeModulesInstalled = await isDirectory(path.join(abs, 'node_modules'))
        && (await fsp.readdir(path.join(abs, 'node_modules')).catch(() => ['x'])).length > 0;

      if (profile.scripts.build) profile.buildCommand = `${profile.packageManager} run build`;
      if (profile.scripts.dev) profile.devCommand = `${profile.packageManager} run dev`;
      if (profile.scripts.start && !profile.devCommand) profile.devCommand = `${profile.packageManager} run start`;

      // What the project's own config files say. These win over our guesses, and
      // we never rewrite them.
      profile.providerConfig.netlify = parseNetlifyToml(await readText(path.join(abs, 'netlify.toml')));
      profile.providerConfig.vercel = parseVercelJson(await readText(path.join(abs, 'vercel.json')));
      for (const viteFile of ['vite.config.js', 'vite.config.mjs', 'vite.config.ts', 'vite.config.cjs']) {
        const text = await readText(path.join(abs, viteFile));
        if (text) { profile.providerConfig.viteOutDir = parseViteOutDir(text); break; }
      }
      for (const nextFile of ['next.config.js', 'next.config.mjs', 'next.config.ts']) {
        if (await readText(path.join(abs, nextFile))) {
          profile.providerConfig.nextStaticExport = parseNextStaticExport(await readText(path.join(abs, nextFile)));
          break;
        }
      }

      // Resolve the output dir: provider config, then framework default, then the
      // first common dir that exists, then the framework default (flagged).
      const declared = profile.providerConfig.netlify?.publish
        || profile.providerConfig.vercel?.outputDirectory
        || profile.providerConfig.viteOutDir;
      const frameworkOutput = match ? match.output : null;
      const candidates = [
        declared,
        frameworkOutput,
        ...COMMON_OUTPUTS.filter((c) => c !== frameworkOutput && c !== declared),
      ].filter(Boolean);
      let chosen = null;
      for (const c of candidates) {
        if (await isDirectory(path.join(abs, c))) { chosen = c; break; }
      }
      profile.outputDir = chosen || declared || frameworkOutput || 'dist';
      profile.outputExists = await isDirectory(path.join(abs, profile.outputDir));

      if (!profile.scripts.build && !profile.outputExists) {
        profile.warnings.push('No "build" script and no known output folder found.');
      }
      profile.kind = 'node';
      if (profile.ssr) {
        profile.warnings.push(`${profile.framework} targets a server runtime; static preview/export only covers the client bundle.`);
      }

      // A backend that a static upload would silently drop.
      const backendDeps = BACKEND_DEPS.filter((d) => Object.prototype.hasOwnProperty.call(deps, d));
      if (backendDeps.length) {
        profile.backend.detected = true;
        profile.backend.evidence.push(...backendDeps.map((d) => `dependency ${d}`));
      }
      const mainFile = typeof pkg.main === 'string' ? pkg.main.trim() : '';
      if (mainFile && !profile.ssr && SERVER_ENTRY.test(path.basename(mainFile))) {
        profile.backend.evidence.push(`entry point ${mainFile}`);
      }
      if (await isDirectory(path.join(abs, 'server')) || await isDirectory(path.join(abs, 'api'))) {
        profile.backend.evidence.push(await isDirectory(path.join(abs, 'server')) ? 'server/ folder' : 'api/ folder');
      }
      // Any single piece of evidence is enough: `detected` is what the plan and
      // the review screen read, so it must not lag behind the evidence list.
      profile.backend.detected = profile.backend.evidence.length > 0;

      // What makes this a desktop program rather than a website.
      if (Object.prototype.hasOwnProperty.call(deps, 'electron')) {
        profile.desktop.evidence.push('electron is a dependency');
      }
      if (pkg.build && typeof pkg.build === 'object') {
        profile.desktop.evidence.push('an electron-builder "build" config');
      }
      if (mainFile && /electron[/\\]/.test(mainFile)) {
        profile.desktop.evidence.push(`entry point ${mainFile}`);
      }
      profile.desktop.detected = profile.desktop.evidence.length > 0;

      applyDeployClassification(profile);
      return profile;
    }

    // No package.json: a static site is any root index.html.
    if (await exists(path.join(abs, 'index.html'))) {
      profile.kind = 'static';
      profile.outputDir = '.';
      profile.outputExists = true;
      profile.targetKind = 'static';
      profile.deployMode = 'prebuilt';
      return profile;
    }

    // Python / other server apps: name them explicitly instead of pretending a
    // static host can run them.
    const pyManifest = (await exists(path.join(abs, 'requirements.txt'))) || (await exists(path.join(abs, 'pyproject.toml')));
    if (pyManifest) {
      const reqs = await readText(path.join(abs, 'requirements.txt')) || '';
      profile.kind = 'python';
      profile.targetKind = 'server';
      profile.deployMode = 'unsupported';
      profile.deployable = false;
      profile.backend = { detected: true, evidence: ['requirements.txt / pyproject.toml'] };
      profile.blockers.push(
        `This is a Python${/fastapi/i.test(reqs) ? ' (FastAPI)' : /flask/i.test(reqs) ? ' (Flask)' : ''} application. Vercel and Netlify host static sites and serverless functions, not a long-running Python server, so NovaCode will not pretend to deploy it.`,
      );
      profile.warnings.push('Use a provider that runs containers/apps (Render, Railway, Fly.io) — or add a static frontend and deploy that.');
      return profile;
    }

    profile.warnings.push('No package.json or index.html found — nothing deployable at the workspace root.');
    profile.deployable = false;
    profile.deployMode = 'unsupported';
    profile.blockers.push('Open the folder that contains package.json or index.html. NovaCode deploys the workspace root, not a subfolder.');
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

module.exports = {
  createDeployService,
  BUNDLE_DIR,
  FRAMEWORKS,
  COMMON_OUTPUTS,
  BACKEND_DEPS,
  SERVER_FRAMEWORKS,
  SERVER_ENTRY,
  applyDeployClassification,
  parseNetlifyToml,
  parseVercelJson,
  parseViteOutDir,
  parseNextStaticExport,
};
