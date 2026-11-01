#!/usr/bin/env node
'use strict';
/**
 * Real-deployment verification for the NovaCode Deploy workspace.
 *
 * Unit tests can only prove the wire contract against a fake transport. Proving
 * that a deployment really happened needs three things a test suite cannot
 * invent: the developer's own provider token, an actual upload the provider
 * accepted, and a public URL that answers over the internet. This script does
 * exactly that, and it is never run automatically.
 *
 * The token is read from the environment (or from the already gitignored `.env`
 * next to this repository, using the same loader the IDE itself uses) and is never
 * accepted as a command-line argument, never echoed, and never handed to a build
 * script's environment.
 *
 * Usage (PowerShell):
 *   $env:VERCEL_TOKEN = "<your token>"
 *   node scripts/verify-real-deploy.js --provider=vercel --root=C:\path\to\site
 *
 * Or, when the token cannot be exported into the shell that runs this script, put it
 * in the project's gitignored .env instead (VERCEL_TOKEN=...) and set nothing.
 *
 *   $env:NETLIFY_TOKEN = "<your token>"
 *   node scripts/verify-real-deploy.js --provider=netlify --root=C:\path\to\site --preview
 *
 * Options:
 *   --provider=<vercel|netlify>  which host to deploy to (required)
 *   --root=<folder>              project folder to deploy (required)
 *   --project=<name|id>          deploy into an existing project instead of creating one
 *   --team=<id>                  publish under a team the token belongs to
 *   --preview                    publish a preview/draft instead of production
 *   --plan-only                  stop after the review plan: uploads nothing
 *   --allow-build                permit running the project's own build script locally
 *   --acknowledge-frontend-only  accept that a detected backend will NOT be deployed
 *   --env KEY=value              supply a value for a detected variable (repeatable)
 *   --then-cancel                start a second run and cancel it, to verify cancellation
 *   --then-redeploy              redeploy from history, to verify the redeploy path
 *
 * Exit code 0 requires ALL of: the provider reported the deployment live, the
 * provider's own status call returned a public URL, and that URL answered
 * successfully when fetched here. Anything less exits non-zero.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const { createDeployService } = require('../electron/services/deploy/deployService');
const { createDeployController } = require('../electron/services/deploy/deployController');
const { createDeployHistory } = require('../electron/services/deploy/deployHistory');
const { loadEnv } = require('../electron/services/env');
const { TOKEN_SECRET } = require('../electron/services/deploy/providers');

const TOKEN_ENV = { vercel: 'VERCEL_TOKEN', netlify: 'NETLIFY_TOKEN' };
const POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * A deliberate stop. `fail()` throws instead of calling `process.exit()` because
 * forcing the process down while an undici socket is still closing aborts Node on
 * Windows (`uv_async` assertion, exit 0xC0000409) and the real exit status is then
 * lost. Setting process.exitCode and unwinding keeps the status honest.
 */
class VerificationFailure extends Error {}

function fail(message) {
  process.exitCode = 1;
  console.error(`\n[verify] FAILED: ${message}`);
  throw new VerificationFailure(message);
}

function parseArgs(argv) {
  const args = { envVars: [] };
  for (const raw of argv) {
    if (!raw.startsWith('--')) fail(`Unexpected argument "${raw}". Run with --help for usage.`);
    const [flag, valueRaw] = raw.slice(2).split(/=(.*)/s);
    const value = valueRaw === undefined ? true : valueRaw;
    switch (flag) {
      case 'help':
        args.help = true;
        break;
      case 'provider': args.provider = value; break;
      case 'root': args.root = value; break;
      case 'project': args.project = value; break;
      case 'team': args.teamId = value; break;
      case 'preview': args.preview = true; break;
      case 'plan-only': args.planOnly = true; break;
      case 'allow-build': args.allowBuild = true; break;
      case 'acknowledge-frontend-only': args.acknowledgeFrontendOnly = true; break;
      case 'then-cancel': args.thenCancel = true; break;
      case 'then-redeploy': args.thenRedeploy = true; break;
      case 'timeout': args.timeoutMs = Number(value) * 1000; break;
      case 'env': {
        const text = String(value || '');
        const eq = text.indexOf('=');
        if (eq < 1) fail('--env expects KEY=value');
        args.envVars.push({ key: text.slice(0, eq).trim(), value: text.slice(eq + 1) });
        break;
      }
      default: fail(`Unknown option --${flag}`);
    }
  }
  return args;
}

/**
 * Build runner used only when --allow-build is given.
 *
 * The provider tokens are stripped from the child environment: a project's own
 * build script is untrusted code and must not be able to read the credential
 * that is being verified.
 */
function makeRunCapture({ allowBuild }) {
  return async ({ root, command, timeoutMs = 10 * 60 * 1000 }) => {
    if (!allowBuild) {
      throw new Error('Refusing to run the project\'s own build script without --allow-build.');
    }
    const { spawn } = require('child_process');
    const env = { ...process.env };
    Object.values(TOKEN_ENV).forEach((name) => delete env[name]);
    console.log(`[build] $ ${command}`);
    return await new Promise((resolve) => {
      const child = spawn(command, { cwd: root, shell: true, windowsHide: true, env });
      let output = '';
      const timer = setTimeout(() => { child.kill(); }, timeoutMs);
      child.stdout.on('data', (chunk) => { output += chunk; process.stdout.write(`[build] ${chunk}`); });
      child.stderr.on('data', (chunk) => { output += chunk; process.stderr.write(`[build] ${chunk}`); });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ output: `${output}\n${error.message}`, code: 127, signal: null });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ output, code, signal });
      });
    });
  };
}

/**
 * The controller only ever needs three secret-store methods. Reading the token
 * from the environment keeps it out of argv, out of the shell history that
 * recorded the command, and out of NovaCode's own credential store.
 */
function makeSecretStore(provider, token) {
  const secretName = TOKEN_SECRET(provider);
  return {
    async getSecret(name) { return name === secretName ? token : null; },
    async getSecretSource(name) { return name === secretName ? 'env-var' : null; },
    async setSecret() { throw new Error('This script never stores a credential.'); },
    async clearSecret() { return { ok: true }; },
  };
}

function line(text = '') { console.log(text); }

function showPlan(plan) {
  line('\n--- review plan -------------------------------------------------');
  for (const check of plan.checks) {
    line(`  ${check.ok ? '[ok]  ' : '[FAIL]'} ${check.label}${check.detail ? ` — ${check.detail}` : ''}`);
  }
  line(`  mode        : ${plan.deployMode} (${plan.profile.targetKind || 'static'})`);
  line(`  framework   : ${plan.profile.framework || 'plain files'}`);
  line(`  build cmd   : ${plan.build.buildCommand || '(none — nothing to build)'}`);
  line(`  upload      : ${plan.build.outputDir || '(project source)'}`);
  line(`  env names   : ${plan.env.required.map((e) => e.key).join(', ') || '(none referenced)'}`);
  line(`  env missing : ${plan.env.missing.join(', ') || '(none missing)'}`);
  if (plan.profile.frontendOnly) line('  NOTE        : a backend was detected and will NOT be deployed.');
  for (const warning of plan.warnings) line(`  warn        : ${warning}`);
  for (const blocker of plan.blockers) line(`  BLOCKER     : ${blocker}`);
}

async function waitForFinal(controller, runId, { timeoutMs }) {
  const started = Date.now();
  let last = '';
  for (;;) {
    const snap = controller.status({ runId });
    const mark = `${snap.phase}/${snap.state}`;
    if (mark !== last) {
      last = mark;
      line(`  [${new Date().toISOString().slice(11, 19)}] ${mark} — ${snap.message || ''}`);
    }
    if (snap.final) return snap;
    if (Date.now() - started > timeoutMs) {
      return { ...snap, final: false, message: `Timed out after ${Math.round(timeoutMs / 60000)} minutes.` };
    }
    await controller.refresh({ runId });
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** The part no mock can provide: the internet agrees the site is up. */
async function checkPublicUrl(url) {
  if (typeof fetch !== 'function') fail('Node 18+ is required so the public URL can really be fetched.');
  if (!/^https?:\/\//.test(url)) fail(`The provider returned something that is not a URL: ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  const body = (await response.text().catch(() => '')).slice(0, 400).replace(/\s+/g, ' ').trim();
  line(`  GET ${url}`);
  line(`  status ${response.status} ${response.statusText}`);
  line(`  body   ${body.slice(0, 160)}…`);
  if (!response.ok) fail(`The provider called this deployment live, but the URL answered ${response.status}.`);
  return response;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('See the header comment of scripts/verify-real-deploy.js for usage.');
    return;
  }
  if (!args.provider || !args.root) fail('--provider and --root are both required.');
  const provider = String(args.provider).trim();
  if (!TOKEN_ENV[provider]) fail(`Only vercel and netlify are implemented. Got "${provider}".`);
  const root = path.resolve(String(args.root));
  if (!fs.existsSync(root)) fail(`No such folder: ${root}`);
  // A real environment variable always wins; .env only fills the gap, which is the
  // exact rule the IDE follows, so this script cannot diverge from the app.
  const fromEnvironment = process.env[TOKEN_ENV[provider]];
  loadEnv();
  const token = process.env[TOKEN_ENV[provider]];
  if (!token) fail(`Set ${TOKEN_ENV[provider]} in the environment, or add it to the gitignored .env, first. Never pass the token on the command line.`);

  line(`[verify] provider ${provider} · root ${root}`);
  line(`[verify] token    read from ${TOKEN_ENV[provider]} (${token.length} chars, not printed)`);
  line(`[verify] source   ${fromEnvironment === undefined ? '.env (gitignored)' : 'environment variable'}`);

  const historyFile = path.join(os.tmpdir(), 'novacode-verify-deploy-history.json');
  const controller = createDeployController({
    deploy: createDeployService({ runCapture: makeRunCapture(args), logger: console }),
    secretStore: makeSecretStore(provider, token),
    settings: { load: async () => ({}), save: async () => ({}) },
    history: createDeployHistory({ filePath: historyFile, logger: console }),
    logger: { info: () => {}, warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) },
    maxPollMs: args.timeoutMs || DEFAULT_TIMEOUT_MS,
  });

  // 1 · Does the provider accept this token, and whose account is it?
  // `connected` is only true once the host itself answered 2xx, so a stored or
  // supplied-but-refused token lands in the failure branch with its real reason.
  const rows = await controller.connections();
  const row = rows.find((r) => r.id === provider);
  if (!row) fail(`"${provider}" is not a known provider.`);
  if (!row.connected) {
    fail(row.error
      ? `authentication failed — ${row.error}`
      : `no usable token: set ${TOKEN_ENV[provider]} in the environment.`);
  }
  line(`[verify] connected as ${JSON.stringify(row.account)} · storage ${row.storage}`);
  if (row.teams.length) line(`[verify] teams      : ${row.teams.map((t) => `${t.id} (${t.name || t.slug})`).join(', ')}`);
  if (args.teamId && !row.teams.some((t) => t.id === args.teamId)) {
    fail(`--team=${args.teamId} is not a team this token belongs to.`);
  }

  // 2 · The same plan the IDE shows, including everything that blocks a deploy.
  const plan = await controller.plan({
    root, provider, teamId: args.teamId, project: args.project, rebuild: true,
  });
  showPlan(plan);
  if (args.planOnly) {
    line('\n[verify] --plan-only: nothing was uploaded and nothing was published.');
    // A blocked plan is still a blocked plan, and a non-zero exit is how a caller
    // learns that, so this reports it rather than returning quietly.
    if (plan.blockers.length) fail(`the review plan blocks this deploy: ${plan.blockers[0]}`);
    return;
  }
  if (plan.blockers.length) fail(plan.blockers[0]);

  const missingWithNoValue = plan.env.missing.filter(
    (key) => !args.envVars.some((item) => item.key === key),
  );
  if (!args.preview && missingWithNoValue.length) {
    fail(`No value supplied for ${missingWithNoValue.join(', ')} (use --env KEY=value) or deploy with --preview.`);
  }
  if (plan.profile.frontendOnly && !args.acknowledgeFrontendOnly) {
    fail('This project has server-side code that a static publish will not deploy. Re-run with --acknowledge-frontend-only to accept that.');
  }
  if (plan.needs.confirmBuild && !args.allowBuild) {
    fail('The plan requires running the project build script. Re-run with --allow-build to permit it.');
  }

  // 3 · Publish for real, with the same confirmations the IDE demands.
  const production = !args.preview;
  line(`\n--- ${production ? 'PRODUCTION' : 'preview'} deploy: ${provider} -------------------`);
  const started = await controller.start({
    root,
    provider,
    teamId: args.teamId,
    project: args.project,
    production,
    confirmProduction: production,
    confirmBuild: plan.needs.confirmBuild ? Boolean(args.allowBuild) : true,
    acknowledgeFrontendOnly: plan.profile.frontendOnly ? Boolean(args.acknowledgeFrontendOnly) : true,
    rebuild: true,
    envVars: args.envVars,
  }, (event) => {
    if (event && event.type === 'log' && event.line) line(`  · ${event.line}`);
  });
  line(`[verify] run ${started.runId} started`);

  const final = await waitForFinal(controller, started.runId, { timeoutMs: args.timeoutMs || DEFAULT_TIMEOUT_MS });
  line(`[verify] final state: ${final.state} (${final.phase}) — ${final.message || ''}`);

  if (final.state !== 'ready') {
    try {
      const logs = await controller.deployLogs({ provider, teamId: args.teamId, deploymentId: final.deploymentId, project: args.project });
      line('\n--- host build log (last 3000 chars) --------------------------');
      line(String(logs.text).slice(-3000));
    } catch (error) { line(`[verify] could not read the host log: ${error.message}`); }
    fail(`${provider} did not report a live deployment (state ${final.state}). No URL is claimed.`);
  }
  if (!final.publicUrl) fail(`${provider} reported the deployment live without giving a URL.`);
  if (final.dashboardUrl) line(`[verify] dashboard ${final.dashboardUrl}`);

  // 4 · The provider says live; prove it independently.
  line('\n--- public URL ---------------------------------------------------');
  await checkPublicUrl(final.publicUrl);

  // 5 · Optional: cancellation and redeploy paths, still against the real API.
  if (args.thenCancel) {
    line('\n--- cancellation check -----------------------------------------');
    const second = await controller.start({
      root, provider, teamId: args.teamId, project: args.project, production: false,
      confirmProduction: false, confirmBuild: true, acknowledgeFrontendOnly: true, rebuild: true,
    }, () => {});
    const outcome = await controller.cancel({ runId: second.runId });
    line(`[verify] cancel reported: ${outcome.message || 'no message'} (providerCancelled=${outcome.providerCancelled})`);
    if (outcome.run && outcome.run.state !== 'canceled' && outcome.run.state !== 'error' && outcome.run.state !== 'ready') {
      fail('A cancelled run did not reach a terminal state.');
    }
    line('[verify] note: providerCancelled=false means NovaCode stopped the upload; the host may still finish a deploy it already accepted.');
  }

  if (args.thenRedeploy) {
    line('\n--- redeploy check ---------------------------------------------');
    const history = await controller.historyList({ root });
    if (!history.length) fail('No history row to redeploy from.');
    const again = await controller.redeploy({
      root,
      provider: history[0].provider,
      teamId: history[0].teamId || undefined,
      production: history[0].target !== 'preview',
      confirmProduction: history[0].target !== 'preview',
      confirmBuild: true,
      acknowledgeFrontendOnly: true,
      rebuild: true,
    }, () => {});
    line(`[verify] redeploy run ${again.runId} started`);
    const done = await waitForFinal(controller, again.runId, { timeoutMs: args.timeoutMs || DEFAULT_TIMEOUT_MS });
    if (done.state !== 'ready' || !done.publicUrl) fail(`Redeploy ended in state ${done.state}.`);
    await checkPublicUrl(done.publicUrl);
  }

  line('\n======================================================================');
  line(`  ${provider} accepted the deploy and ${final.publicUrl} answered OK.`);
  line('  This deployment now exists on that account. Remove it in the host');
  line(`  dashboard (${row.label || provider}) when you no longer need it.`);
  line('======================================================================');
}

main().catch((error) => {
  // `fail()` has already reported itself; anything else is an unexpected crash
  // and must still exit non-zero with a readable line instead of a stack trace.
  if (error instanceof VerificationFailure) return;
  process.exitCode = 1;
  const detail = error && error.message ? error.message : String(error);
  console.error(`\n[verify] UNEXPECTED ERROR: ${detail}${error && error.code ? ` (code ${error.code})` : ''}`);
  if (error && error.stack) console.error(error.stack);
});
