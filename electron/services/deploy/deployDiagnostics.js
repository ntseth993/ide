/**
 * Deploy failure diagnostics — turn a failed deployment into a plain-English answer.
 *
 * A red deploy panel tells the developer *that* it failed; the provider's build log
 * tells them *where*, in a thousand lines of someone else's jargon. This module sits
 * between the two: it gathers the evidence NovaCode already has (the run, the plan,
 * the provider's own build log), strips anything secret out of it, and asks the
 * assistant the developer already configured for the same answer they would get by
 * typing in the AI panel — no second model, no second API key, no new network path.
 *
 * Two rules hold:
 *
 *  1. Nothing leaves the machine that has a credential in it. Logs are the one place
 *     a provider echoes back a header, an env value or a signed URL, so every line is
 *     redacted before it becomes prompt text, including the account token itself
 *     passed in as a never-send literal.
 *  2. The answer is a suggestion about the developer's project. It is never a claim
 *     about the provider's state: only a provider response can say whether a
 *     deployment is live, so that stays in the controller and never comes from here.
 *
 * When no assistant is configured (or it fails, or it is offline) the run still gets
 * an explanation: the same failure signatures are matched locally, so the panel can
 * answer without sending anything at all — and says so.
 */
const { TOKEN_SECRET } = require('./providers');

/** How much log may become prompt text. Small on purpose: cost, and privacy. */
const LOG_TAIL_LINES = 60;
const MAX_EVIDENCE_CHARS = 6000;
const MAX_ANSWER_CHARS = 1800;
const DIAGNOSIS_TIMEOUT_MS = 45000;

/**
 * Credential shapes that appear in real build logs. `replacement` is used verbatim,
 * so a `$n` may only ever refer to something safe to echo (a label or a parameter
 * NAME) — never to the secret itself. Order matters: specific shapes are masked
 * before the generic `NAME=value` rule.
 */
const SECRET_SHAPES = [
  // Headers echoed back by a provider or a proxy. The first rule handles the
  // `Bearer <token>` form; the second one refuses to fire on text the first already
  // masked (or on the scheme word itself), so the two never fight over one line.
  { pattern: /(authorization\s*[:=]\s*bearer\s+)[a-z0-9._~+/=-]{6,}/gi, replacement: '$1[redacted]' },
  { pattern: /(authorization\s*[:=]\s*)(?!\s*(?:\[redacted\]|bearer\b|basic\b|token\b))\S{6,}/gi, replacement: '$1[redacted]' },
  // Provider and model token prefixes that are actually issued. The character class
  // must include `_` and `-`: real tokens contain them, and a shape that stops at
  // an underscore leaks the tail of the secret.
  { pattern: /\b(?:vca|vcu|nfp|sfp|ghp|gho|ghu|ghs|github_pat|vercel|netlify|npm|aws)[a-z0-9_-]{12,}\b/gi, replacement: '[redacted-token]' },
  { pattern: /\bsk-(?:proj-)?[a-z0-9_-]{16,}\b/gi, replacement: '[redacted-key]' },
  { pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g, replacement: '[redacted-key]' },
  // Key material and signed query parameters (only the name is echoed).
  { pattern: /-----BEGIN [^-]{0,40}PRIVATE KEY-----[\s\S]{0,4000}?-----END [^-]{0,40}PRIVATE KEY-----/g, replacement: '[redacted-private-key]' },
  { pattern: /([?&])(X-Amz-Signature|Signature|token|access_token|auth)=[^&\s"']{4,}/gi, replacement: '$1$2=[redacted]' },
  // `NAME: value` / `NAME=value` where the NAME says secret.
  {
    pattern: /\b((?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth[_-]?header|cookie|session|credential)[a-z0-9_-]*)\s*[:=]\s*(?:"[^"\n]{1,200}"|'[^'\n]{1,200}'|[^\s,&"};]{1,200})/gi,
    replacement: '$1: [redacted]',
  },
];

/**
 * Locally-known failure signatures. Used as the offline answer, and handed to the
 * model as context so it does not have to guess at a well-known provider message.
 */
const KNOWN_FAILURES = [
  {
    id: 'auth',
    // Bounded digits: a bare 401 elsewhere in the log (a byte count, a line number)
    // must not convince us the account was refused.
    test: /\b(?:401|403)\b|unauthorized|access denied|not authorized|invalid (api )?token|token is not valid/i,
    cause: 'The hosting provider refused the stored access token.',
    fix: 'Reconnect the account in the Deploy panel with a current token (Vercel: Account Settings → Tokens; Netlify: User settings → Applications). If the token is current, the deployment may belong to a team it has no access to — pick that team and connect again.',
  },
  {
    id: 'build-command',
    test: /command "(npm|yarn|pnpm) run build" failed|build script failed|\bexit code [1-9]\b|npm err!/i,
    cause: 'The project\'s own build script exited non-zero, so there was nothing to publish.',
    fix: 'Run the build command yourself in the integrated terminal and fix what it reports — usually a compile error or a missing dependency. Deploy only after it exits 0.',
  },
  {
    id: 'missing-deps',
    test: /cannot find module|module not found|command not found: (npm|node|yarn|pnpm)|is not recognized as (an internal|the name of)/i,
    cause: 'A dependency or tool the build needs is not installed in this environment.',
    fix: 'Install dependencies (npm install) and make sure the runtime is on PATH, then redeploy. Do not upload node_modules — NovaCode never does.',
  },
  {
    id: 'no-output-dir',
    test: /no such file or directory.*(dist|build|out|public)|output directory .* (not found|does not exist)|could not find (an )?index\.html|ENOENT.*(dist|build)/i,
    cause: 'The configured output folder does not exist, so the upload had nothing to send.',
    fix: 'Build first (Deploy panel → Build), or correct the output directory to match what the build really produces (Vite: dist, Next.js static export: out).',
  },
  {
    id: 'missing-env',
    test: /missing environment variable|environment variable .* (not set|missing|required)|process\.env\.[A-Z_]+ (is|was) undefined|undefined is not.*api/i,
    cause: 'A required environment variable was not present on the deployed target.',
    fix: 'Add the variable in the Deploy panel\'s Environment section (values stay out of the logs) and redeploy. Build-time values must be prefixed for the framework to inline them, e.g. VITE_ for Vite or NEXT_PUBLIC_ for Next.js.',
  },
  {
    id: 'project-name',
    test: /project name .*already (in use|exists)|already exists|409.*conflict|name is already taken/i,
    cause: 'The project or site name is taken on that account.',
    fix: 'Pick an existing project as the target, or give this deploy a different name.',
  },
  {
    id: 'rate-limit',
    test: /\b429\b|rate limit|too many requests|quota (exceeded|reached)|daily limit/i,
    cause: 'The provider rejected the request because a limit was reached.',
    fix: 'Wait and retry. Check the plan limits on the account or team that owns this deployment.',
  },
  {
    id: 'file-limit',
    test: /\b413\b|file (size|too large)|exceeds? (the )?(maximum|limit)|payload too large|deployment (size|too large)/i,
    cause: 'The upload exceeded a provider file or deployment size limit.',
    fix: 'Narrow the output folder, remove large assets from the deploy, or check the provider\'s limit — do not raise the local budget to push a bundle the host will reject.',
  },
  {
    id: 'framework-unsupported',
    test: /could not (detect|find) a (supported )?framework|zero config|unsupported (framework|runtime)|server (runtime|side) .*not (supported|deployed)/i,
    cause: 'The provider could not build this project, or NovaCode deployed only the static half of it.',
    fix: 'Set the framework explicitly on the provider project, or build locally and upload the output folder. A server-side app (Express, FastAPI) needs a host that runs processes — it cannot be published as a static site.',
  },
  {
    id: 'cancelled',
    test: /cancel(l)?ed|aborted by (the )?user|deployment was stopped/i,
    cause: 'The deployment was stopped before the provider reported it live.',
    fix: 'Nothing to fix if you stopped it. Note that cancelling during the upload does not always stop a deploy the host already accepted — check its dashboard.',
  },
  {
    id: 'network',
    test: /(econnrefused|enotfound|eai_again|etimedout|fetch failed|socket hang up|networkerror)/i,
    cause: 'NovaCode could not reach the provider API.',
    fix: 'Check connectivity and any corporate proxy, then retry. Nothing was published.',
  },
  {
    id: 'dns-domain',
    test: /domain .*not verified|misconfigured|nxdomain|dns .*record/i,
    cause: 'A custom domain is configured but the provider has not verified its DNS.',
    fix: 'Point the A/CNAME record at the provider\'s values and wait for propagation. NovaCode only calls a domain live once the provider reports it verified.',
  },
];

/** Replace every known credential shape, plus any literal that must never travel. */
function redactSensitive(text, neverSend = []) {
  let out = String(text == null ? '' : text);
  // Exact strings first: the account token is opaque and matches no shape above.
  for (const literal of neverSend) {
    const value = String(literal || '');
    if (value.length < 6) continue;
    out = out.split(value).join('[redacted]');
  }
  for (const { pattern, replacement } of SECRET_SHAPES) {
    out = out.replace(pattern, replacement);
  }
  // Last resort for a `SOME_TOKEN: xxxxx` line whose name matched but shape did not.
  out = out.replace(/^(\s*[#"'>-]?\s*[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|APIKEY|API_KEY|KEY)[A-Z0-9_]*)\s*[:=]\s*\S{4,}/gim, '$1: [redacted]');
  return out;
}

/** Match the failure text against the local signature table (most specific first). */
function matchKnownFailure(text) {
  const haystack = String(text || '');
  return KNOWN_FAILURES.filter((entry) => entry.test.test(haystack))
    .map((entry) => ({ id: entry.id, cause: entry.cause, fix: entry.fix }));
}

/**
 * The evidence a diagnosis is allowed to rest on: identifiers, counts, settings and
 * redacted log tails — never a secret value, never a whole project's source.
 */
function buildEvidence({ run, providerLog = '', neverSend = [] }) {
  const facts = [
    `provider: ${run.providerLabel || run.provider}`,
    `phase: ${run.phase}`,
    `state: ${run.state}`,
    `target: ${run.target}`,
    `deployment id: ${run.deploymentId || '(not created)'}`,
    `error message: ${redactSensitive(run.message, neverSend)}`,
    run.error ? `error code: ${run.error.code || 'none'} status: ${run.error.status || 'none'}` : '',
    `files uploaded: ${run.fileCount == null ? 'unknown' : run.fileCount} (${run.totalBytes || 0} bytes)`,
    run.upload ? `upload folder: ${run.upload}` : '',
  ].filter(Boolean);

  const localLog = (run.log || []).slice(-LOG_TAIL_LINES);
  const hostLog = String(providerLog || '').split(/\r?\n/).filter(Boolean).slice(-LOG_TAIL_LINES);

  const lines = [];
  lines.push('DEPLOYMENT FACTS');
  for (const fact of facts) lines.push(`- ${fact}`);
  if (localLog.length) {
    lines.push('', 'NOVACODE RUN LOG (tail, redacted)');
    for (const line of localLog) lines.push(redactSensitive(line, neverSend));
  }
  if (hostLog.length) {
    lines.push('', 'PROVIDER BUILD LOG (tail, redacted)');
    for (const line of hostLog) lines.push(redactSensitive(line, neverSend));
  }

  let text = lines.join('\n');
  if (text.length > MAX_EVIDENCE_CHARS) text = `${text.slice(0, MAX_EVIDENCE_CHARS)}\n… evidence truncated`;
  return { text, facts, hintIds: matchKnownFailure(`${run.message}\n${text}`).map((h) => h.id) };
}

/** Prompt pair for the assistant the developer already configured. */
function diagnosisMessages(evidence) {
  const system = [
    'You are the deployment diagnosis assistant inside NovaCode IDE, a code editor.',
    'Explain why this deployment failed and name the single most likely fix.',
    'Use ONLY the evidence provided. Never invent a URL, a deployment id, or a provider status.',
    'Do not state that anything is live, deployed, or published — you cannot know that.',
    'If the evidence is insufficient, say precisely what to check instead of guessing.',
    'Some values in the log are shown as [redacted]; never ask for them or repeat them.',
    'Answer in plain English, at most 140 words, second person, no preamble, no markdown headings.',
    'Finish with one concrete action the developer can take in the Deploy panel or the project.',
  ].join(' ');
  return [
    { role: 'system', content: system },
    { role: 'user', content: `A deployment failed.\n\n${evidence.text}` },
  ];
}

/**
 * @param {{ hosting: object, ai?: object, settings?: object, secretStore?: object,
 *           logger?: object }} deps
 */
function createDeployDiagnostics({ hosting, ai, settings, secretStore, logger = console } = {}) {
  if (!hosting || typeof hosting.status !== 'function') {
    throw new Error('Deploy diagnostics require the deploy controller.');
  }

  async function aiConfig() {
    if (!settings || typeof settings.load !== 'function') return {};
    try {
      const loaded = await settings.load();
      return (loaded && loaded.ai) || {};
    } catch {
      return {};
    }
  }

  /**
   * The token is fetched only to make sure it cannot be in what we send. It is not
   * returned, not logged, and not reachable from the caller.
   */
  async function neverSendFor(provider) {
    if (!secretStore || typeof secretStore.getSecret !== 'function' || !provider) return [];
    try {
      const token = await secretStore.getSecret(TOKEN_SECRET(provider));
      return token ? [token] : [];
    } catch {
      return [];
    }
  }

  async function diagnose({ runId } = {}) {
    const run = hosting.status({ runId });
    if (run.state !== 'error' && run.state !== 'canceled') {
      throw new Error('Only a failed deployment can be diagnosed.');
    }
    const neverSend = await neverSendFor(run.provider);

    // The provider's own build log is the useful half; it may be unavailable.
    let providerLog = '';
    let logError = null;
    try {
      const fetched = await hosting.deployLogs({
        provider: run.provider,
        teamId: run.teamId,
        deploymentId: run.deploymentId,
        project: run.projectId,
      });
      providerLog = (fetched && fetched.text) || '';
    } catch (error) {
      logError = error && error.message ? error.message : String(error);
      // The reason is our own mapped provider error, which carries no credential,
      // but the message is kept out of the log anyway — this is a diagnosis of a
      // failure, not a place to print more of it.
      logger.warn?.('deploy diagnosis: host build log unavailable', { runId: run.runId });
    }

    const evidence = buildEvidence({ run, providerLog, neverSend });
    const hints = matchKnownFailure(`${run.message}\n${evidence.text}`);

    if (!ai || typeof ai.complete !== 'function') {
      return { runId: run.runId, text: '', reason: 'no-ai-service', evidence, hints, logError };
    }

    const config = await aiConfig();
    const result = await ai.complete(
      {
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
        messages: diagnosisMessages(evidence),
        temperature: 0,
        timeoutMs: DIAGNOSIS_TIMEOUT_MS,
        maxChars: MAX_ANSWER_CHARS,
      },
    );

    if (!result || !result.text) {
      // Honest degradation: the local answer is still real, and it says what was
      // not used so nobody mistakes a built-in hint for a model's reasoning.
      return {
        runId: run.runId,
        text: '',
        reason: (result && result.reason) || 'unavailable',
        evidence,
        hints,
        logError,
      };
    }

    return {
      runId: run.runId,
      text: redactSensitive(result.text, neverSend),
      reason: null,
      model: result.model || config.model || null,
      provider: result.provider || config.provider || null,
      evidence,
      hints,
      logError,
    };
  }

  return { diagnose, buildEvidence, matchKnownFailure };
}

module.exports = {
  createDeployDiagnostics,
  buildEvidence,
  diagnosisMessages,
  matchKnownFailure,
  redactSensitive,
  KNOWN_FAILURES,
  LOG_TAIL_LINES,
  MAX_EVIDENCE_CHARS,
};
