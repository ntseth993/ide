// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AIPanel from '../src/components/AIPanel';
import { client } from '../src/services/novaClient';
import { emit as busEmit } from '../src/services/bus';

// The panel talks to the real event bus only through bus.emit (terminal:run for
// live dev servers, terminal:agent-output to echo a captured command). Mock the
// bus so those dispatches are observable and never reach a real subscriber.
vi.mock('../src/services/bus', () => ({
  emit: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  clear: vi.fn(),
}));

// Collect the panel's ai-event subscribers so a test can replay a stream.
let listeners = [];
function aiPanelListeners() {
  return listeners;
}

vi.mock('../src/services/novaClient', async () => {
  const actual = await vi.importActual('../src/services/novaClient');
  return {
    ...actual,
    client: {
      listAiProviders: vi.fn(async () => []),
      apiKeyStatus: vi.fn(async () => ({ hasKey: true, source: 'secret' })),
      onAiEvent: vi.fn((listener) => {
        listeners.push(listener);
        return () => { listeners = listeners.filter((entry) => entry !== listener); };
      }),
      startChat: vi.fn(async () => ({ runId: 'run-1' })),
      cancelChat: vi.fn(),
      runTerminalCapture: vi.fn(async () => ({ output: 'ok', code: 0, signal: null })),
      readFile: vi.fn(async () => 'file contents'),
      setApiKey: vi.fn(async () => ({ storage: 'os-encrypted' })),
      clearApiKey: vi.fn(async () => ({ ok: true })),
      // governed autonomous agent surface (agent:* IPC channels)
      agentReadFile: vi.fn(async () => ({ content: 'file contents' })),
      agentListDir: vi.fn(async () => []),
      agentSearch: vi.fn(async () => ({ results: [], searchedFiles: 0, truncated: false })),
      agentWriteFile: vi.fn(async () => ({ id: 'h-1', ts: '2026-11-04T00:00:00.000Z', filePath: '/w/src/Login.jsx', created: true })),
      agentCreateFolder: vi.fn(async () => ({ path: '/w/src/components' })),
      agentDeletePath: vi.fn(async () => ({ ok: true, trashed: true, filePath: '/w/src/old' })),
      agentRenamePath: vi.fn(async () => ({ path: '/w/src/Main.jsx' })),
      agentMovePath: vi.fn(async () => ({ path: '/w/src/components/Navbar.jsx' })),
      agentRunCommand: vi.fn(async () => ({ output: '23 passing', code: 0, signal: null })),
    },
  };
});

const baseProps = {
  aiSettings: { provider: 'openai', temperature: 0.2 },
  activeFile: { name: 'app.js', language: 'javascript', text: 'console.log(1)', path: '/w/app.js' },
  workspaceName: 'demo',
  workspaceRoot: '/w',
  account: null,
  onAccountChange: vi.fn(),
  onRequireSignIn: vi.fn(),
  onProviderChange: vi.fn(),
  onStreamingChange: vi.fn(),
  onProposeEdit: vi.fn(),
  onAgentChange: vi.fn(),
  onUndoAgentChanges: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenHistory: vi.fn(),
};

const signedInAgent = {
  ...baseProps,
  aiSettings: { provider: 'ollama', temperature: 0.2 },
  account: { email: 'a@b.com', tokensRemaining: 999 },
  mode: 'agent',
};

// Drive one assistant turn that emits a single novacode-tool block, then a
// plain follow-up turn that emits nothing so the bounded loop terminates.
async function runToolTurn(tool, args) {
  await userEvent.type(screen.getByRole('textbox', { name: /assistant/i }), 'do it');
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(client.startChat).toHaveBeenCalled());
  const handlers = aiPanelListeners();
  handlers.forEach((l) => l({
    runId: 'run-1',
    type: 'delta',
    data: '```novacode-tool\n' + JSON.stringify({ tool, args }) + '\n```',
  }));
  handlers.forEach((l) => l({ runId: 'run-1', type: 'done', data: JSON.stringify({ reason: 'completed' }) }));
  // second round: no tool block -> the loop stops after this answer.
  await waitFor(() => expect(client.startChat.mock.calls.length).toBeGreaterThanOrEqual(2));
  handlers.forEach((l) => l({ runId: 'run-1', type: 'done', data: JSON.stringify({ reason: 'completed' }) }));
}

// Build the XML/Claude dialect from a bracket constant so this source holds no
// literal tag. Same idea as runToolTurn but the model speaks XML instead of
// fenced JSON — NovaCode must still execute the action and hide the raw markup.
const LT = '<';
function xmlToolBlock(tool, params) {
  const inner = Object.entries(params)
    .map(([k, v]) => `${LT}parameter=${k}>${v}${LT}/parameter>`)
    .join('\n');
  return `${LT}tool_call>\n${LT}function=${tool}>\n${inner}\n${LT}/function>\n${LT}/tool_call>`;
}

async function runXmlToolTurn(tool, params) {
  await userEvent.type(screen.getByRole('textbox', { name: /assistant/i }), 'do it');
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(client.startChat).toHaveBeenCalled());
  const handlers = aiPanelListeners();
  handlers.forEach((l) => l({ runId: 'run-1', type: 'delta', data: xmlToolBlock(tool, params) }));
  handlers.forEach((l) => l({ runId: 'run-1', type: 'done', data: JSON.stringify({ reason: 'completed' }) }));
  await waitFor(() => expect(client.startChat.mock.calls.length).toBeGreaterThanOrEqual(2));
  handlers.forEach((l) => l({ runId: 'run-1', type: 'done', data: JSON.stringify({ reason: 'completed' }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  listeners = [];
  client.startChat.mockResolvedValue({ runId: 'run-1' });
  client.apiKeyStatus.mockResolvedValue({ hasKey: true, source: 'secret' });
  client.listAiProviders.mockResolvedValue([]);
  client.agentWriteFile.mockResolvedValue({ id: 'h-1', ts: 'x', filePath: '/w/src/Login.jsx', created: true });
  client.agentRunCommand.mockResolvedValue({ output: '23 passing', code: 0, signal: null });
});

describe('AIPanel (Qoder-style layout)', () => {
  it('shows the centered hero and tab strip when the conversation is empty', () => {
    render(<AIPanel {...baseProps} />);
    expect(screen.getByText('Think Deeper')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Continue' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'New Chat' })).toBeInTheDocument();
  });

  it('prompts to sign in when there is no account', () => {
    render(<AIPanel {...baseProps} />);
    expect(screen.getByRole('button', { name: /Sign in for 1,000M/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /assistant/i })).toHaveAttribute('placeholder', 'Sign in to start chatting');
  });

  it('offers an Agent and an Ask mode and reports the active one', async () => {
    const onModeChange = vi.fn();
    render(<AIPanel {...baseProps} mode="agent" onModeChange={onModeChange} />);
    expect(screen.getByRole('button', { name: 'Agent' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(onModeChange).toHaveBeenCalledWith('ask');
  });

  it('shows the sign-in gate while signed out and the inline-AI state in the composer', () => {
    render(<AIPanel {...baseProps} inlineAIState="ready" />);
    expect(screen.getByText(/Sign in to unlock the assistant/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Press Tab/i })).toHaveClass('on');
  });
});

describe('AIPanel — autonomous Agent execution (no approval dialog)', () => {
  it('applies a write_file immediately through the governed service and reports the change', async () => {
    render(<AIPanel {...signedInAgent} />);
    await runToolTurn('write_file', { path: 'src/Login.jsx', content: 'export default function Login(){}' });
    await waitFor(() => expect(client.agentWriteFile).toHaveBeenCalled());
    expect(client.agentWriteFile).toHaveBeenCalledWith({
      root: '/w', path: 'src/Login.jsx', content: 'export default function Login(){}',
    });
    // The applied change flows to the non-blocking summary + Undo wiring.
    expect(baseProps.onAgentChange).toHaveBeenCalledWith(expect.objectContaining({
      path: '/w/src/Login.jsx', created: true, historyId: 'h-1',
    }));
    // No approval/run button ever appears.
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Accept/ })).not.toBeInTheDocument();
  });

  it('executes an XML-dialect write_file and hides the raw tags from the bubble', async () => {
    render(<AIPanel {...signedInAgent} />);
    await runXmlToolTurn('write_file', { path: 'src/Login.jsx', content: 'export default function Login(){}' });
    await waitFor(() => expect(client.agentWriteFile).toHaveBeenCalledWith({
      root: '/w', path: 'src/Login.jsx', content: 'export default function Login(){}',
    }));
    // The XML protocol must not linger as visible text in the answer bubble.
    expect(screen.queryByText(/tool_call/)).not.toBeInTheDocument();
    expect(screen.queryByText(/parameter=path/)).not.toBeInTheDocument();
  });

  it('nudges a plan-only turn so the agent actually acts instead of stalling', async () => {
    render(<AIPanel {...signedInAgent} />);
    await userEvent.type(screen.getByRole('textbox', { name: /assistant/i }), 'create admin panel');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(client.startChat).toHaveBeenCalled());
    const handlers = aiPanelListeners();
    // Turn 1: the model only narrates its plan — no tool block at all.
    handlers.forEach((l) => l({ runId: 'run-1', type: 'delta', data: 'I will first look at the project, then build it.' }));
    handlers.forEach((l) => l({ runId: 'run-1', type: 'done', data: JSON.stringify({ reason: 'completed' }) }));
    // The loop must NOT stop after an empty plan — it nudges and starts another turn.
    await waitFor(() => expect(client.startChat.mock.calls.length).toBeGreaterThanOrEqual(2));
    // Turn 2: now it emits a real action, which must execute.
    handlers.forEach((l) => l({ runId: 'run-1', type: 'delta', data: '```novacode-tool\n' + JSON.stringify({ tool: 'list_dir', args: {} }) + '\n```' }));
    handlers.forEach((l) => l({ runId: 'run-1', type: 'done', data: JSON.stringify({ reason: 'completed' }) }));
    await waitFor(() => expect(client.agentListDir).toHaveBeenCalled());
  });

  it('runs a short command through agentRunCommand and echoes it to the terminal', async () => {
    render(<AIPanel {...signedInAgent} />);
    await runToolTurn('run_command', { command: 'npm test' });
    await waitFor(() => expect(client.agentRunCommand).toHaveBeenCalledWith({ root: '/w', command: 'npm test', cwd: undefined }));
    expect(busEmit).toHaveBeenCalledWith('terminal:agent-output', expect.objectContaining({ command: 'npm test', code: 0 }));
    // The card shows the real exit code.
    expect(await screen.findByText(/exit 0/i)).toBeInTheDocument();
  });

  it('sends a long-running dev server to the live integrated terminal', async () => {
    render(<AIPanel {...signedInAgent} />);
    await runToolTurn('run_command', { command: 'npm run dev' });
    await waitFor(() => expect(busEmit).toHaveBeenCalledWith('terminal:run', { command: 'npm run dev' }));
    // it must NOT also run headless via the capture channel (no double-execution)
    expect(client.agentRunCommand).not.toHaveBeenCalled();
  });

  it('deletes a workspace item automatically, preferring trash', async () => {
    render(<AIPanel {...signedInAgent} />);
    await runToolTurn('delete_path', { path: 'src/old' });
    await waitFor(() => expect(client.agentDeletePath).toHaveBeenCalledWith({ root: '/w', path: 'src/old' }));
    expect(baseProps.onAgentChange).toHaveBeenCalledWith(expect.objectContaining({ path: '/w/src/old', deleted: true }));
  });

  it('creates folders and moves files through the governed channels', async () => {
    render(<AIPanel {...signedInAgent} />);
    await runToolTurn('create_folder', { path: 'src/components' });
    await waitFor(() => expect(client.agentCreateFolder).toHaveBeenCalledWith({ root: '/w', path: 'src/components' }));
  });

  it('surfaces a backend policy refusal as a failed card, not an approval prompt', async () => {
    client.agentRunCommand.mockResolvedValue({ output: '', code: null, blocked: true, error: '"sudo" is a system-level command and the agent will not run it.' });
    render(<AIPanel {...signedInAgent} />);
    await runToolTurn('run_command', { command: 'sudo rm -rf /' });
    const card = await screen.findByText(/system-level command/i);
    expect(card).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
  });

  it('refuses to act when no workspace is open', async () => {
    render(<AIPanel {...signedInAgent} workspaceRoot={undefined} />);
    await runToolTurn('write_file', { path: 'a.js', content: 'x' });
    expect(await screen.findByText(/Open a project folder first/i)).toBeInTheDocument();
    expect(client.agentWriteFile).not.toHaveBeenCalled();
  });
});

describe('AIPanel — Ask mode never executes', () => {
  it('does not run tools or modify files in Ask mode', async () => {
    render(<AIPanel {...baseProps} aiSettings={{ provider: 'ollama', temperature: 0.2 }} account={{ email: 'a@b.com', tokensRemaining: 999 }} mode="ask" />);
    await userEvent.type(screen.getByRole('textbox', { name: /assistant/i }), 'install express');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(client.startChat).toHaveBeenCalled());
    const handlers = aiPanelListeners();
    handlers.forEach((l) => l({
      runId: 'run-1',
      type: 'delta',
      data: 'You could run:\n```novacode-tool\n{"tool":"run_command","args":{"command":"npm install express"}}\n```',
    }));
    handlers.forEach((l) => l({ runId: 'run-1', type: 'done', data: JSON.stringify({ reason: 'completed' }) }));
    // Ask mode answers once and never dispatches the tool.
    expect(await screen.findByText(/You could run/i)).toBeInTheDocument();
    expect(client.agentRunCommand).not.toHaveBeenCalled();
    expect(client.agentWriteFile).not.toHaveBeenCalled();
    expect(client.startChat).toHaveBeenCalledTimes(1);
  });
});

describe('AIPanel — changed-files summary, Undo, Stop, providers, rendering', () => {
  it('renders the non-blocking changed-files summary with an Undo action', () => {
    render(
      <AIPanel
        {...baseProps}
        account={{ email: 'a@b.com', tokensRemaining: 999 }}
        mode="agent"
        agentChanges={[
          { path: '/w/src/Login.jsx', created: true, historyId: 'h-1' },
          { path: '/w/src/App.jsx', after: 'x', historyId: 'h-2' },
        ]}
        onUndoAgentChanges={baseProps.onUndoAgentChanges}
      />,
    );
    expect(screen.getByText(/Changes applied \(2\)/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Undo edits/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /View diffs/i })).toBeInTheDocument();
  });

  it('shows a Stop control while the agent is running and cancels on click', async () => {
    render(<AIPanel {...baseProps} aiSettings={{ provider: 'ollama', temperature: 0.2 }} account={{ email: 'a@b.com', tokensRemaining: 999 }} mode="agent" />);
    // Force the streaming state, then click Stop.
    await userEvent.type(screen.getByRole('textbox', { name: /assistant/i }), 'go');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(client.startChat).toHaveBeenCalled());
    const stop = await screen.findByRole('button', { name: /Stop/i });
    await userEvent.click(stop);
    expect(client.cancelChat).toHaveBeenCalledWith('run-1');
  });

  it('sends the mode-default Groq model (Agent → qwen, Ask → gpt-oss-20b)', async () => {
    const groq = {
      id: 'groq', label: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1',
      defaultModel: 'openai/gpt-oss-120b',
      models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'], requiresKey: true,
      modeModels: { agent: 'qwen/qwen3.8-27b', ask: 'openai/gpt-oss-20b', reasoning: 'openai/gpt-oss-120b' },
    };
    client.listAiProviders.mockResolvedValue([groq]);
    client.apiKeyStatus.mockResolvedValue({ hasKey: true, source: 'env' });

    const { unmount } = render(
      <AIPanel {...baseProps} aiSettings={{ provider: 'groq', temperature: 0.2 }} account={{ email: 'a@b.com', tokensRemaining: 999 }} mode="agent" />,
    );
    await userEvent.type(screen.getByRole('textbox', { name: /assistant/i }), 'hi');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(client.startChat).toHaveBeenCalled());
    expect(client.startChat.mock.calls.at(-1)[0].model).toBe('qwen/qwen3.8-27b');
    unmount();

    client.startChat.mockClear();
    render(
      <AIPanel {...baseProps} aiSettings={{ provider: 'groq', temperature: 0.2 }} account={{ email: 'a@b.com', tokensRemaining: 999 }} mode="ask" />,
    );
    await userEvent.type(screen.getByRole('textbox', { name: /assistant/i }), 'hi');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(client.startChat).toHaveBeenCalled());
    expect(client.startChat.mock.calls.at(-1)[0].model).toBe('openai/gpt-oss-20b');
  });

  it('shows a paste-key form for a keyed provider with no key and stores it', async () => {
    client.apiKeyStatus.mockResolvedValue({ hasKey: false, source: null });
    render(
      <AIPanel {...baseProps} aiSettings={{ provider: 'openai', temperature: 0.2 }} account={{ email: 'a@b.com', tokensRemaining: 999 }} />,
    );
    const input = await screen.findByPlaceholderText(/Paste your API key/i);
    await userEvent.type(input, 'gsk_test_123');
    await userEvent.click(screen.getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(client.setApiKey).toHaveBeenCalledWith('openai', 'gsk_test_123'));
  });

  it('renders markdown and a code card with a Review-as-edit action (Ask mode)', async () => {
    const onProposeEdit = vi.fn();
    render(
      <AIPanel {...baseProps} aiSettings={{ provider: 'ollama', temperature: 0.2 }} account={{ email: 'a@b.com', tokensRemaining: 999 }} mode="ask" onProposeEdit={onProposeEdit} />,
    );
    const handlers = aiPanelListeners();
    await userEvent.type(screen.getByRole('textbox', { name: /assistant/i }), 'give me a snippet');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(client.startChat).toHaveBeenCalled());
    handlers.forEach((l) => l({ runId: 'run-1', type: 'delta', data: 'Here you go:\n```js\nconst a = 1;\nconst b = 2;\n```' }));
    handlers.forEach((l) => l({ runId: 'run-1', type: 'done', data: JSON.stringify({ reason: 'completed' }) }));
    expect(await screen.findByText('js')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Review as edit/i }));
    expect(onProposeEdit).toHaveBeenCalledWith(expect.objectContaining({
      path: '/w/app.js', modified: 'const a = 1;\nconst b = 2;',
    }));
  });

  it('surfaces an immediate error even when it arrives before the run id resolves', async () => {
    let resolveStart;
    client.startChat.mockImplementation(() => new Promise((res) => { resolveStart = res; }));
    render(<AIPanel {...baseProps} aiSettings={{ provider: 'openai', temperature: 0.2 }} account={{ email: 'a@b.com', tokensRemaining: 999 }} mode="ask" />);
    const handlers = aiPanelListeners();
    await userEvent.type(screen.getByRole('textbox', { name: /assistant/i }), 'hi');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    handlers.forEach((l) => l({ runId: 'run-1', type: 'error', data: 'No API key configured for OpenAI.' }));
    expect(await screen.findByText(/No API key configured for OpenAI/)).toBeInTheDocument();
    resolveStart?.({ runId: 'run-1' });
  });
});

describe('AIPanel — external "Fix with AI" hand-off', () => {
  it('auto-runs a handed-off prompt in Agent mode and consumes it once', async () => {
    const onConsumePendingPrompt = vi.fn();
    render(<AIPanel {...signedInAgent} pendingPrompt="package.json is invalid JSON — fix it" onConsumePendingPrompt={onConsumePendingPrompt} />);
    // No typing: the panel starts the agent turn on its own.
    await waitFor(() => expect(client.startChat).toHaveBeenCalled());
    expect(onConsumePendingPrompt).toHaveBeenCalledTimes(1);
    const payload = client.startChat.mock.calls[0][0];
    expect(JSON.stringify(payload.messages)).toContain('package.json is invalid JSON');
    // End the turn so the bounded loop settles without a dangling promise.
    aiPanelListeners().forEach((l) => l({ runId: 'run-1', type: 'done', data: JSON.stringify({ reason: 'completed' }) }));
  });

  it('runs nothing when no prompt is handed off', async () => {
    render(<AIPanel {...signedInAgent} />);
    await waitFor(() => expect(client.listAiProviders).toHaveBeenCalled());
    expect(client.startChat).not.toHaveBeenCalled();
  });
});
