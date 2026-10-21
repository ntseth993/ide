// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AIPanel from '../src/components/AIPanel';
import { client } from '../src/services/novaClient';

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
    },
  };
});

const baseProps = {
  aiSettings: { provider: 'openai', temperature: 0.2 },
  activeFile: { name: 'app.js', language: 'javascript', text: 'console.log(1)', path: '/w/app.js' },
  workspaceName: 'demo',
  account: null,
  onAccountChange: vi.fn(),
  onRequireSignIn: vi.fn(),
  onProviderChange: vi.fn(),
  onStreamingChange: vi.fn(),
  onProposeEdit: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenHistory: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  listeners = [];
  client.startChat.mockResolvedValue({ runId: 'run-1' });
  client.apiKeyStatus.mockResolvedValue({ hasKey: true, source: 'secret' });
  client.listAiProviders.mockResolvedValue([]);
});

describe('AIPanel (Qoder-style layout)', () => {
  it('shows the centered hero and tab strip when the conversation is empty', () => {
    render(<AIPanel {...baseProps} />);
    expect(screen.getByText('Think Deeper')).toBeInTheDocument();
    expect(screen.getByText('Build Better')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Continue' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'New Chat' })).toBeInTheDocument();
  });

  it('prompts to sign in when there is no account', () => {
    render(<AIPanel {...baseProps} />);
    expect(screen.getByRole('button', { name: /Sign in for 1,000M/ })).toBeInTheDocument();
    const box = screen.getByRole('textbox', { name: /assistant/i });
    expect(box).toHaveAttribute('placeholder', 'Sign in to start chatting');
  });

  it('lets a quick prompt fill the composer', async () => {
    render(
      <AIPanel
        {...baseProps}
        aiSettings={{ provider: 'ollama', temperature: 0.2 }}
        account={{ email: 'a@b.com', tokensRemaining: 999 }}
        mode="ask"
      />,
    );
    const box = await screen.findByPlaceholderText('Plan and build, @ for context, / for commands');
    await userEvent.click(screen.getByRole('button', { name: 'Explain what this file does' }));
    expect(box.value).toBe('Explain what this file does');
  });

  it('offers an Agent and an Ask mode and reports the active one', async () => {
    const onModeChange = vi.fn();
    render(<AIPanel {...baseProps} mode="agent" onModeChange={onModeChange} />);
    expect(screen.getByRole('button', { name: 'Agent' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Ask' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(onModeChange).toHaveBeenCalledWith('ask');
  });

  it('shows the sign-in gate while signed out and the inline-AI state in the composer', () => {
    render(<AIPanel {...baseProps} inlineAIState="ready" />);
    expect(screen.getByText(/Sign in to unlock the assistant/i)).toBeInTheDocument();
    const inlinePill = screen.getByRole('button', { name: /Press Tab/i });
    expect(inlinePill).toHaveClass('on');
  });

  it('auto-offers the agent answer as a diff review once streaming ends', async () => {
    const onProposeEdit = vi.fn();
    render(
      <AIPanel
        {...baseProps}
        aiSettings={{ provider: 'ollama', temperature: 0.2 }}
        account={{ email: 'a@b.com', tokensRemaining: 999 }}
        mode="agent"
        onProposeEdit={onProposeEdit}
      />,
    );
    // Assistant answers arrive through the streaming events, so drive them.
    const aiEventHandlers = aiPanelListeners();
    await userEvent.type(screen.getByRole('textbox', { name: /assistant/i }), 'rewrite this');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    aiEventHandlers.forEach((listener) => listener({
      runId: 'run-1', type: 'delta', data: 'Here you go:\n```js\nconst a = 1;\n```',
    }));
    aiEventHandlers.forEach((listener) => listener({
      runId: 'run-1', type: 'done', data: JSON.stringify({ reason: 'completed' }),
    }));
    await screen.findByText(/Here you go/);
    expect(onProposeEdit).toHaveBeenCalledTimes(1);
    expect(onProposeEdit).toHaveBeenCalledWith({
      path: '/w/app.js',
      original: 'console.log(1)',
      modified: 'const a = 1;\n',
    });
  });
});
