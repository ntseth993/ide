// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TerminalPanel from '../src/components/TerminalPanel';

const mock = globalThis.__mockNova;

beforeEach(() => {
  vi.clearAllMocks();
});

function makeCommands() {
  const run = vi.fn();
  const commands = ['terminal.new', 'terminal.clear', 'run.file', 'run.stop'].map((id) => ({ id, run }));
  return { commands, run };
}

describe('TerminalPanel menu', () => {
  it('opens the terminal actions menu and runs a command', async () => {
    const { commands, run } = makeCommands();
    render(<TerminalPanel root="C:/proj" height={200} visible commands={commands} />);
    await userEvent.click(screen.getByRole('button', { name: 'Terminal actions' }));
    const menu = screen.getByRole('menu', { name: 'Terminal actions' });
    await userEvent.click(within(menu).getByRole('menuitem', { name: /Clear Terminal/ }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('keeps the unimplemented Split Terminal disabled', async () => {
    const { commands, run } = makeCommands();
    render(<TerminalPanel root="C:/proj" height={200} visible commands={commands} />);
    await userEvent.click(screen.getByRole('button', { name: 'Terminal actions' }));
    const split = within(screen.getByRole('menu', { name: 'Terminal actions' }))
      .getByRole('menuitem', { name: /Split Terminal/ });
    expect(split).toBeDisabled();
    await userEvent.click(split);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('TerminalPanel interactive shell', () => {
  it('shows a PowerShell prompt with the workspace path', async () => {
    render(<TerminalPanel root="C:/proj" height={200} visible commands={[]} />);
    expect(await screen.findByText('PS C:\\proj>')).toBeInTheDocument();
  });

  it('cd moves the working directory without spawning a process', async () => {
    render(<TerminalPanel root="C:/proj" height={200} visible commands={[]} />);
    const input = await screen.findByLabelText('Terminal command');
    await userEvent.type(input, 'cd src');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText(/^PS C:\\proj\\src>/)).toBeInTheDocument();
    expect(mock.startTerminal).not.toHaveBeenCalled();
  });

  it('refuses to cd outside the workspace and keeps the directory', async () => {
    render(<TerminalPanel root="C:/proj" height={200} visible commands={[]} />);
    const input = await screen.findByLabelText('Terminal command');
    await userEvent.type(input, 'cd C:/Windows');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText(/outside the workspace/)).toBeInTheDocument();
    expect(screen.getByText('PS C:\\proj>')).toBeInTheDocument();
  });

  it('runs later commands in the current working directory', async () => {
    render(<TerminalPanel root="C:/proj" height={200} visible commands={[]} />);
    const input = await screen.findByLabelText('Terminal command');
    await userEvent.type(input, 'cd src');
    await userEvent.keyboard('{Enter}');
    await userEvent.type(input, 'dir');
    await userEvent.keyboard('{Enter}');
    expect(mock.startTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: 'C:/proj/src', command: 'dir' }),
    );
  });
});
