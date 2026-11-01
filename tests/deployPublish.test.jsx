// @vitest-environment jsdom
/**
 * Publish panel behaviour tests.
 *
 * These focus on the promises the deploy spec makes to the user, because those
 * are exactly the promises a UI can break on its own: a token is only ever sent
 * in, a URL is only shown when the host says the deploy is live, and nothing is
 * published to production until the missing variables and the risky choices have
 * been acknowledged by name.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DeployPublish from '../src/components/DeployPublish';

const bridge = globalThis.__mockNova;
const ROOT = 'C:\\w\\acme';

function planFixture(overrides = {}) {
  const base = {
    root: ROOT, provider: 'vercel', providerLabel: 'Vercel', teamId: '', project: '',
    profile: {
      kind: 'node', framework: 'vite', projectName: 'acme-site', deployMode: 'prebuilt',
      buildCommand: 'npm run build', outputDir: 'dist', frontendOnly: false, blockers: [], warnings: [],
    },
    build: { buildCommand: 'npm run build', installCommand: null, outputDir: 'dist', framework: 'vite' },
    env: {
      required: [{ key: 'API_URL', source: 'src/api.js', buildTime: false }],
      missing: ['API_URL'], providerDefined: [], locallyDefined: [], warnings: [],
    },
    checks: [
      { id: 'project', label: 'vite detected', ok: true, detail: 'Project name: acme-site' },
      { id: 'account', label: 'Vercel account', ok: true, detail: 'Connected' },
      { id: 'env', label: '1 environment variable(s) not set', ok: false, detail: 'Missing (names only): API_URL' },
    ],
    blockers: [], warnings: [],
    needs: { confirmProduction: false, confirmBuild: false, acknowledgeFrontendOnly: false, needsEnvValues: true },
    deployMode: 'prebuilt', supports: { providerBuild: true, cancel: true },
  };
  return { ...base, ...overrides };
}

/** A plan with nothing missing, so a test can isolate one single gate. */
function planClean(overrides = {}) {
  const plan = planFixture(overrides);
  return {
    ...plan,
    env: { required: [], missing: [], providerDefined: [], locallyDefined: [], warnings: [] },
    checks: plan.checks.filter((check) => check.id !== 'env'),
  };
}

const VercelAccountRow = {
  id: 'vercel', label: 'Vercel', available: true, connected: true, hasToken: true, storage: 'os-encrypted',
  account: { id: 'usr_1', handle: 'ada' }, teams: [{ id: 'team_acme', name: 'Acme', slug: 'acme' }], error: null,
};
const NetlifyRow = {
  id: 'netlify', label: 'Netlify', available: true, connected: false, hasToken: false, storage: null,
  account: null, teams: [], error: null,
};

let notify;
let emitDeployEvent;

function mount(overrides = {}) {
  render(<DeployPublish root={ROOT} onNotify={notify} {...overrides} />);
}

beforeEach(() => {
  cleanup();
  // The bridge mock objects are created once per file, so their call history
  // would otherwise accumulate across tests.
  Object.values(bridge).forEach((fn) => { if (fn && typeof fn.mockClear === 'function') fn.mockClear(); });
  notify = vi.fn();
  emitDeployEvent = null;
  bridge.onDeployEvent.mockImplementation((cb) => { emitDeployEvent = cb; return () => {}; });
  bridge.deployConnections.mockResolvedValue([VercelAccountRow, NetlifyRow]);
  bridge.deployPlan.mockImplementation(async () => planFixture());
  bridge.deployStart.mockResolvedValue({
    runId: 'run_test', provider: 'vercel', phase: 'uploading', state: 'building', target: 'production',
    message: 'Uploading files.', publicUrl: null, deploymentId: null, dashboardUrl: null, log: [], final: false,
  });
  bridge.deployCancel.mockResolvedValue({ ok: true, providerCancelled: true, run: { runId: 'run_test', state: 'canceled' } });
  bridge.deployConnect.mockResolvedValue({
    ok: true, provider: 'vercel', storage: 'os-encrypted', account: { id: 'usr_1', handle: 'ada' }, teams: [],
  });
  bridge.deployHistory.mockResolvedValue([]);
  bridge.deployDomains.mockResolvedValue({ domains: [], instructions: [] });
  bridge.openExternal.mockClear();
});

/** Stream a main-process deploy:event into the mounted panel. */
function push(event) {
  act(() => { emitDeployEvent(event); });
}

describe('provider choice', () => {
  it('lists every provider and labels the unimplemented slot honestly', async () => {
    mount();
    expect(await screen.findByText('Vercel')).toBeInTheDocument();
    expect(screen.getByText('Netlify')).toBeInTheDocument();
    const cloudflare = screen.getByRole('button', { name: /Cloudflare Pages/i });
    expect(cloudflare).toBeDisabled();
    expect(screen.getByText('not implemented')).toBeInTheDocument();
    expect(screen.getByText('Adapter slot reserved. Not implemented yet.')).toBeInTheDocument();
    // §5: neither implemented host requires a repository.
    expect(screen.getAllByText('no Git needed')).toHaveLength(2);
    expect(screen.getByText(/Can build on the host · Next.js supported/)).toBeInTheDocument();
    expect(screen.getByText(/Uploads pre-built output · static \+ SPA only/)).toBeInTheDocument();
  });

  it('explains that history needs an open folder', async () => {
    mount({ root: '' });
    await waitFor(() => expect(screen.getByText('Open a folder to see its deploys.')).toBeInTheDocument());
    expect(screen.queryByText('No deployments from this folder yet.')).not.toBeInTheDocument();
  });
});

describe('connecting an account', () => {
  it('shows how to get a token, and never a pre-filled secret', async () => {
    bridge.deployConnections.mockResolvedValue([{ ...VercelAccountRow, connected: false, storage: null, account: null, teams: [] }]);
    mount();
    expect(await screen.findByText('Create a token named “NovaCode” on your Vercel account tokens page.')).toBeInTheDocument();
    const token = screen.getByLabelText('Vercel access token');
    expect(token).toHaveAttribute('type', 'password');
    expect(token).toHaveValue('');
    expect(screen.getByText(/keeps it in your OS key store/)).toBeInTheDocument();
  });

  it('refuses to contact a provider without a token', async () => {
    bridge.deployConnections.mockResolvedValue([{ ...VercelAccountRow, connected: false, teams: [] }]);
    mount();
    await screen.findByLabelText('Vercel access token');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Paste the access token/);
    expect(bridge.deployConnect).not.toHaveBeenCalled();
  });

  it('sends the token once and forgets it', async () => {
    bridge.deployConnections.mockResolvedValue([{ ...VercelAccountRow, connected: false, teams: [] }]);
    mount();
    await userEvent.type(await screen.findByLabelText('Vercel access token'), '  vercel_odq_secret  ');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(bridge.deployConnect).toHaveBeenCalledWith({ provider: 'vercel', token: 'vercel_odq_secret' }));
    expect(await screen.findByText(/connected as ada/)).toBeInTheDocument();
    expect(notify).toHaveBeenCalledWith('Vercel account connected', 'ok');
    // The form is gone once the main process holds the token, and nothing the
    // panel rendered - including the connection row - carries the secret back.
    expect(screen.queryByLabelText('Vercel access token')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('vercel_odq_secret');
  });

  it('reports a provider rejection instead of claiming success', async () => {
    bridge.deployConnections.mockResolvedValue([{ ...VercelAccountRow, connected: false, teams: [] }]);
    bridge.deployConnect.mockRejectedValue(new Error('Vercel rejected that token (HTTP 401).'));
    mount();
    await userEvent.type(await screen.findByLabelText('Vercel access token'), 'bad-token');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/rejected that token/);
    expect(screen.getByText('not connected')).toBeInTheDocument();
    expect(screen.queryByText(/connected as/)).not.toBeInTheDocument();
  });

  it('tells a revoked token apart from a missing one, and says why', async () => {
    // The main process only reports `connected` once the host accepted the token,
    // so a stored-but-refused token must never render as a working account.
    bridge.deployConnections.mockResolvedValue([{
      ...VercelAccountRow, connected: false, hasToken: true, storage: 'os-encrypted', account: null, teams: [],
      error: 'Vercel rejected the stored token: Your Vercel token is not valid.',
    }]);
    mount();
    expect(await screen.findByText('token rejected')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(/rejected the stored token/);
    expect(screen.queryByText(/connected as/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Deploy to production/ })).toBeDisabled();
  });

  it('warns when the OS key store could not encrypt the secret', async () => {
    bridge.deployConnections.mockResolvedValue([{ ...VercelAccountRow, storage: 'plain' }]);
    mount();
    expect(await screen.findByText('stored without OS encryption')).toBeInTheDocument();
  });

  it('lets the developer pick which account the deploy belongs to', async () => {
    mount();
    const teamSelect = await screen.findByLabelText('Account / team');
    expect(screen.getByText('connected as ada')).toBeInTheDocument();
    await userEvent.selectOptions(teamSelect, 'team_acme');
    await waitFor(() => expect(bridge.deployPlan).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team_acme' })));
    await userEvent.selectOptions(teamSelect, '');
    await waitFor(() => expect(bridge.deployPlan).toHaveBeenLastCalledWith(expect.objectContaining({ teamId: undefined })));
  });
});

describe('review screen', () => {
  it('shows the settings that will be used, and env names without values', async () => {
    mount();
    expect(await screen.findByText('Review')).toBeInTheDocument();
    expect(screen.getByText('vite detected')).toBeInTheDocument();
    expect(screen.getByText('Missing (names only): API_URL')).toBeInTheDocument();
    expect(screen.getByDisplayValue('npm run build')).toBeInTheDocument();
    expect(screen.getByDisplayValue('dist')).toBeInTheDocument();
    expect(screen.getByText('API_URL')).toBeInTheDocument();
    const valueBox = screen.getByLabelText('Value for API_URL');
    expect(valueBox).toHaveAttribute('type', 'password');
    expect(valueBox).toHaveValue('');
    expect(screen.getByText('1 referenced · 0 already on Vercel')).toBeInTheDocument();
  });

  it('re-plans when the target changes so the review matches what would be sent', async () => {
    mount();
    await screen.findByText('Review');
    await userEvent.click(screen.getByRole('button', { name: /Re-review/ }));
    await waitFor(() => expect(bridge.deployPlan).toHaveBeenCalledTimes(2));
  });

  it('names the alternative instead of deploying a project the host cannot build', async () => {
    bridge.deployPlan.mockImplementation(async () => planFixture({
      blockers: ['Netlify cannot build this Next.js project from an upload. Choose Vercel, or run the build locally first.'],
      warnings: ['next renders on the server.'],
    }));
    mount();
    expect(await screen.findByText('Netlify cannot build this Next.js project from an upload. Choose Vercel, or run the build locally first.')).toBeInTheDocument();
    expect(screen.getByText('Blocked — fix the items above.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Deploy to production/ })).toBeDisabled();
  });
});

describe('confirmation gates', () => {
  async function readyToDeploy(plan) {
    bridge.deployPlan.mockImplementation(async () => plan);
    mount();
    await screen.findByText('Review');
  }

  it('locks a production publish until every missing variable has a value', async () => {
    await readyToDeploy(planFixture());
    const deploy = screen.getByRole('button', { name: /Deploy to production/ });
    expect(deploy).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Value for API_URL'), 'https://api.example.com');
    await waitFor(() => expect(deploy).toBeEnabled());

    await userEvent.click(deploy);
    await waitFor(() => expect(bridge.deployStart).toHaveBeenCalledTimes(1));
    const payload = bridge.deployStart.mock.calls[0][0];
    expect(payload.production).toBe(true);
    expect(payload.confirmProduction).toBe(true);
    expect(payload.envVars).toEqual([{ key: 'API_URL', value: 'https://api.example.com' }]);
    expect(payload.root).toBe(ROOT);
    // The value is handed over and then dropped from the interface.
    await waitFor(() => expect(screen.getByLabelText('Value for API_URL')).toHaveValue(''));
  });

  it('explains which names are still empty rather than deploying broken anyway', async () => {
    await readyToDeploy(planFixture());
    // The gate is enforced in startDeploy too, for a plan that changed underneath.
    const deploy = screen.getByRole('button', { name: /Deploy to production/ });
    expect(deploy).toBeDisabled();
    expect(screen.getByText(/Give these a value and NovaCode sends them to the host/)).toBeInTheDocument();
  });

  it('lets a preview go out without the production values', async () => {
    await readyToDeploy(planFixture());
    await userEvent.selectOptions(screen.getByLabelText('Publish as'), 'preview');
    const deploy = screen.getByRole('button', { name: /Deploy preview/ });
    await waitFor(() => expect(deploy).toBeEnabled());
    await userEvent.click(deploy);
    await waitFor(() => expect(bridge.deployStart).toHaveBeenCalledTimes(1));
    expect(bridge.deployStart.mock.calls[0][0]).toMatchObject({ production: false, confirmProduction: false });
  });

  it('asks permission before running the project\'s own build command', async () => {
    await readyToDeploy(planClean({ needs: { ...planFixture().needs, confirmBuild: true } }));
    const consent = screen.getByRole('checkbox', { name: /Allow NovaCode to run/ });
    expect(consent).not.toBeChecked();
    expect(screen.getByRole('button', { name: /Deploy to production/ })).toBeDisabled();

    await userEvent.click(consent);
    await waitFor(() => expect(screen.getByRole('button', { name: /Deploy to production/ })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: /Deploy to production/ }));
    await waitFor(() => expect(bridge.deployStart.mock.calls[0][0].confirmBuild).toBe(true));
  });

  it('requires an explicit acknowledgement before shipping only the frontend', async () => {
    await readyToDeploy(planClean({
      profile: { ...planFixture().profile, frontendOnly: true },
      warnings: ['Server-side code was detected (dependency express).'],
    }));
    const consent = screen.getByRole('checkbox', { name: /only the static frontend will be published/ });
    expect(screen.getByRole('button', { name: /Deploy to production/ })).toBeDisabled();

    await userEvent.click(consent);
    await waitFor(() => expect(screen.getByRole('button', { name: /Deploy to production/ })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: /Deploy to production/ }));
    await waitFor(() => expect(bridge.deployStart.mock.calls[0][0].acknowledgeFrontendOnly).toBe(true));
  });

  it('stays locked while no account is connected', async () => {
    bridge.deployConnections.mockResolvedValue([{ ...VercelAccountRow, connected: false, account: null, teams: [] }]);
    mount();
    await screen.findByText('Review');
    expect(screen.getByRole('button', { name: /Deploy to production/ })).toBeDisabled();
    expect(screen.getByText('Connect a Vercel account to deploy.')).toBeInTheDocument();
  });
});

describe('run status', () => {
  async function startRun(plan = planFixture()) {
    bridge.deployPlan.mockImplementation(async () => plan);
    mount();
    await screen.findByText('Review');
    await userEvent.type(screen.getByLabelText('Value for API_URL'), 'https://api.example.com');
    await userEvent.click(screen.getByRole('button', { name: /Deploy to production/ }));
    await waitFor(() => expect(bridge.deployStart).toHaveBeenCalled());
  }

  it('shows no URL while the host is still working', async () => {
    await startRun();
    expect(await screen.findByText('Uploading files.')).toBeInTheDocument();
    expect(screen.getByText('Building')).toBeInTheDocument();
    expect(screen.getByText('The URL appears once the host reports the deployment as live.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /http/ })).not.toBeInTheDocument();
  });

  it('reveals the URL only when the provider reports the deploy live, and opens exactly that address', async () => {
    await startRun();
    await waitFor(() => expect(emitDeployEvent).toBeTruthy());

    push({ runId: 'run_test', type: 'log', line: 'Build completed in 12s' });
    expect(screen.getByText('Build completed in 12s')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /http/ })).not.toBeInTheDocument();

    push({ runId: 'run_test', type: 'status', phase: 'live', state: 'ready', publicUrl: 'https://acme.vercel.app' });
    const link = await screen.findByRole('link', { name: 'https://acme.vercel.app' });
    expect(link).toHaveAttribute('href', 'https://acme.vercel.app');
    expect(notify).toHaveBeenCalledWith('Deployment is live', 'ok');

    await userEvent.click(screen.getByRole('button', { name: /Open website/ }));
    expect(bridge.openExternal).toHaveBeenCalledWith('https://acme.vercel.app');
  });

  it('drops a stale URL the moment a new deploy starts', async () => {
    await startRun();
    await waitFor(() => expect(emitDeployEvent).toBeTruthy());
    push({ runId: 'run_test', type: 'status', state: 'ready', publicUrl: 'https://old.vercel.app' });
    await screen.findByRole('link', { name: 'https://old.vercel.app' });

    push({ runId: 'run_next', type: 'start', state: 'queued', phase: 'validating' });
    await waitFor(() => expect(screen.queryByRole('link', { name: /vercel\.app/ })).not.toBeInTheDocument());
  });

  it('reports a failure with no URL at all', async () => {
    await startRun();
    await waitFor(() => expect(emitDeployEvent).toBeTruthy());
    push({
      runId: 'run_test', type: 'status', phase: 'failed', state: 'error', publicUrl: null,
      message: 'Build exited with code 1',
    });
    expect(screen.getByText('Build exited with code 1')).toBeInTheDocument();
    expect(screen.getByText('No URL: the host did not finish this deployment.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /http/ })).not.toBeInTheDocument();
    expect(notify).toHaveBeenCalledWith('Deployment failed', 'error');
  });

  it('says what cancellation actually stopped', async () => {
    await startRun();
    await userEvent.click(await screen.findByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(bridge.deployCancel).toHaveBeenCalledWith({ runId: 'run_test' }));
    expect(notify).toHaveBeenCalledWith('Deployment cancelled on the host', 'ok');
  });

  it('does not claim the host cancelled when it did not', async () => {
    bridge.deployCancel.mockResolvedValue({ ok: true, providerCancelled: false, run: { runId: 'run_test', state: 'canceled' } });
    await startRun();
    await userEvent.click(await screen.findByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('NovaCode stopped the upload', 'ok'));
    expect(notify).not.toHaveBeenCalledWith('Deployment cancelled on the host', 'ok');
  });

  it('pulls the host build log on request', async () => {
    bridge.deployProviderLogs.mockResolvedValue({ text: 'Installing dependencies…', provider: 'vercel' });
    await startRun();
    await userEvent.click(await screen.findByRole('button', { name: /View host logs/ }));
    await waitFor(() => expect(bridge.deployProviderLogs).toHaveBeenCalledWith({
      provider: 'vercel', teamId: undefined, deploymentId: undefined, project: undefined,
    }));
    expect(await screen.findByText('Installing dependencies…')).toBeInTheDocument();
  });
});

describe('history, domains and redeploy', () => {
  it('offers Open only for a deploy the host confirmed', async () => {
    bridge.deployHistory.mockResolvedValue([
      { id: 'd2', provider: 'vercel', teamId: 'team_acme', target: 'production', state: 'ready', publicUrl: 'https://live.vercel.app', fileCount: 12, totalBytes: 4096, createdAt: new Date().toISOString() },
      { id: 'd1', provider: 'vercel', target: 'production', state: 'error', publicUrl: null, message: 'Build failed', createdAt: new Date().toISOString() },
    ]);
    mount();
    expect(await screen.findByText('https://live.vercel.app')).toBeInTheDocument();
    expect(screen.getByText('Build failed')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Open/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /Redeploy/ })).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { name: /Open/ }));
    expect(bridge.openExternal).toHaveBeenCalledWith('https://live.vercel.app');
  });

  it('redeploys with the same target the original run had', async () => {
    bridge.deployHistory.mockResolvedValue([
      { id: 'd1', provider: 'netlify', teamId: 'abc', target: 'preview', state: 'ready', publicUrl: 'https://deploy-preview-1.netlify.app', createdAt: new Date().toISOString() },
    ]);
    mount();
    await userEvent.click(await screen.findByRole('button', { name: /Redeploy/ }));
    await waitFor(() => expect(bridge.deployRedeploy).toHaveBeenCalledWith(expect.objectContaining({
      root: ROOT, provider: 'netlify', teamId: 'abc', production: false, confirmProduction: false,
    })));
    expect(bridge.deployRedeploy.mock.calls[0][0].confirmProduction).toBe(false);
  });

  it('only calls a domain active when the host verifies it', async () => {
    bridge.deployDomains.mockResolvedValue({
      domains: [{ name: 'acme.dev', confirmed: false, misconfigured: true }, { name: 'www.acme.dev', confirmed: true }],
      instructions: ['Point the A record at 76.76.21.21.'],
    });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: /Check with Vercel/ }));
    expect(await screen.findByText('acme.dev')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
    expect(screen.getByText('verified')).toBeInTheDocument();
    expect(screen.getByText('DNS misconfigured')).toBeInTheDocument();
    expect(screen.getByText('Point the A record at 76.76.21.21.')).toBeInTheDocument();
  });

  it('treats clearing history as a destructive action needing confirmation', async () => {
    bridge.deployHistory.mockResolvedValue([
      { id: 'd1', provider: 'vercel', target: 'production', state: 'ready', publicUrl: 'https://a.vercel.app', createdAt: new Date().toISOString() },
    ]);
    mount();
    await userEvent.click(await screen.findByRole('button', { name: /Clear/ }));
    const dialog = await screen.findByText('Clear deployment history?');
    expect(dialog).toBeInTheDocument();
    expect(bridge.deployHistoryClear).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Clear history' }));
    await waitFor(() => expect(bridge.deployHistoryClear).toHaveBeenCalledWith({ root: ROOT, confirm: true }));
    expect(await screen.findByText('No deployments from this folder yet.')).toBeInTheDocument();
  });
});

describe('explaining a failed deployment', () => {
  /** Drive the panel through one deploy that the host reports as errored. */
  async function runToFailure(message = 'Build exited with code 1') {
    mount();
    await screen.findByText('Review');
    await userEvent.type(screen.getByLabelText('Value for API_URL'), 'https://api.example.com');
    await userEvent.click(screen.getByRole('button', { name: /Deploy to production/ }));
    await waitFor(() => expect(bridge.deployStart).toHaveBeenCalled());
    await waitFor(() => expect(emitDeployEvent).toBeTruthy());
    push({ runId: 'run_test', type: 'status', phase: 'failed', state: 'error', publicUrl: null, message });
  }

  it('asks for the explanation only when there is a failure to explain', async () => {
    mount();
    await screen.findByText('Review');
    expect(screen.queryByRole('button', { name: /Explain/ })).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Value for API_URL'), 'https://api.example.com');
    await userEvent.click(screen.getByRole('button', { name: /Deploy to production/ }));
    await waitFor(() => expect(bridge.deployStart).toHaveBeenCalled());
    await waitFor(() => expect(emitDeployEvent).toBeTruthy());
    // Still in flight: nothing has failed, so there is nothing to interpret.
    expect(screen.queryByRole('button', { name: /Explain/ })).not.toBeInTheDocument();

    push({ runId: 'run_test', type: 'status', phase: 'live', state: 'ready', publicUrl: 'https://acme.vercel.app' });
    await screen.findByRole('link', { name: 'https://acme.vercel.app' });
    expect(screen.queryByRole('button', { name: /Explain/ })).not.toBeInTheDocument();

    // A live deploy turning into a failed one (a redeploy that died) does offer it.
    push({ runId: 'run_test', type: 'status', phase: 'failed', state: 'error', publicUrl: null, message: 'Build exited with code 1' });
    expect(await screen.findByRole('button', { name: 'Explain this failure' })).toBeInTheDocument();
  });

  it('shows the written answer and says which model wrote it', async () => {
    bridge.deployDiagnose.mockResolvedValue({
      runId: 'run_test',
      text: 'Your build script failed before anything was uploaded. Run npm run build in the terminal and fix what it reports.',
      reason: null,
      provider: 'openai',
      model: 'gpt-4o-mini',
      hints: [{ id: 'build-command', cause: 'The project\'s own build script exited non-zero, so there was nothing to publish.', fix: 'Run the build command yourself and fix what it reports.' }],
      evidence: { text: '', facts: [], hintIds: ['build-command'] },
    });
    await runToFailure();
    expect(bridge.deployDiagnose).not.toHaveBeenCalled();

    await userEvent.click(await screen.findByRole('button', { name: 'Explain this failure' }));
    expect(await screen.findByText('Your build script failed before anything was uploaded. Run npm run build in the terminal and fix what it reports.')).toBeInTheDocument();
    await waitFor(() => expect(bridge.deployDiagnose).toHaveBeenCalledWith({ runId: 'run_test' }));
    expect(screen.getByText('Written by openai · gpt-4o-mini')).toBeInTheDocument();
    expect(screen.getByText('Run the build command yourself and fix what it reports.')).toBeInTheDocument();
  });

  it('names the built-in checks when the assistant could not be used', async () => {
    bridge.deployDiagnose.mockResolvedValue({
      runId: 'run_test',
      text: '',
      reason: 'no-key',
      hints: [{ id: 'missing-env', cause: 'A required environment variable was not present on the deployed target.', fix: 'Add the variable in the Deploy panel and redeploy.' }],
      evidence: { text: '', facts: [], hintIds: ['missing-env'] },
    });
    await runToFailure('Missing environment variable: API_URL');
    await userEvent.click(await screen.findByRole('button', { name: 'Explain this failure' }));

    expect(await screen.findByText("Answered from NovaCode's own failure checks instead — no API key is configured for your assistant.")).toBeInTheDocument();
    expect(screen.getByText('NovaCode built-in causes')).toBeInTheDocument();
    expect(screen.getByText('Add the variable in the Deploy panel and redeploy.')).toBeInTheDocument();
    // No invented attribution: a hint is never presented as a model's reasoning.
    expect(screen.queryByText(/Written by/)).not.toBeInTheDocument();
  });

  it('passes the assistant\'s own excuse through instead of guessing one', async () => {
    bridge.deployDiagnose.mockResolvedValue({
      runId: 'run_test', text: '', reason: 'You are signed out. Sign in to use the assistant.', hints: [],
    });
    await runToFailure();
    await userEvent.click(await screen.findByRole('button', { name: 'Explain this failure' }));
    expect(await screen.findByText(/the assistant said: You are signed out\. Sign in to use the assistant\./)).toBeInTheDocument();
  });

  it('explains a cancelled run without calling it a failure', async () => {
    bridge.deployDiagnose.mockResolvedValue({ runId: 'run_test', text: '', reason: 'no-key', hints: [] });
    mount();
    await screen.findByText('Review');
    await userEvent.type(screen.getByLabelText('Value for API_URL'), 'https://api.example.com');
    await userEvent.click(screen.getByRole('button', { name: /Deploy to production/ }));
    await waitFor(() => expect(emitDeployEvent).toBeTruthy());

    await userEvent.click(await screen.findByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(bridge.deployCancel).toHaveBeenCalled());
    await userEvent.click(await screen.findByRole('button', { name: 'Explain what happened' }));
    await waitFor(() => expect(bridge.deployDiagnose).toHaveBeenCalledWith({ runId: 'run_test' }));
  });

  it('drops an explanation that belongs to an earlier run', async () => {
    bridge.deployDiagnose.mockResolvedValue({ runId: 'run_test', text: 'Reconnect the account.', reason: null, hints: [] });
    await runToFailure();
    await userEvent.click(await screen.findByRole('button', { name: 'Explain this failure' }));
    expect(await screen.findByText('Reconnect the account.')).toBeInTheDocument();

    // A new deploy starts and fails for its own reason: the old answer must not be
    // read as advice about the new one.
    push({ runId: 'run_next', type: 'start', state: 'queued', phase: 'validating' });
    push({ runId: 'run_next', type: 'status', phase: 'failed', state: 'error', publicUrl: null, message: 'Upload timed out' });
    expect(screen.queryByText('Reconnect the account.')).not.toBeInTheDocument();
    expect(bridge.deployDiagnose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Explain this failure' })).toBeInTheDocument();
  });

  it('shows the real reason when the diagnosis itself cannot run', async () => {
    bridge.deployDiagnose.mockRejectedValue(new Error('That deployment run is no longer known.'));
    await runToFailure();
    await userEvent.click(await screen.findByRole('button', { name: 'Explain this failure' }));
    expect(await screen.findByText('That deployment run is no longer known.')).toBeInTheDocument();
    expect(screen.queryByText('NovaCode built-in causes')).not.toBeInTheDocument();
  });
});
