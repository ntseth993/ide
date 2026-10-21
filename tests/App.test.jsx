// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App';

const nova = () => globalThis.__mockNova;

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('App (renderer shell)', () => {
  it('renders the welcome screen with primary actions', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'NovaCode' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Folder' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Project' })).toBeInTheDocument();
  });

  it('loads settings from the desktop bridge when available', async () => {
    nova().getSettings.mockResolvedValue({ theme: 'light', fontSize: 18 });
    render(<App />);
    await waitFor(() => {
      expect(nova().getSettings).toHaveBeenCalled();
    });
  });

  it('opens a folder, expands it, and opens a file in a tab', async () => {
    const n = nova();
    n.chooseDirectory.mockResolvedValue('C:/projects/demo');
    n.validateWorkspace.mockImplementation(async (root) => root);
    n.readDir.mockResolvedValue([
      {
        name: 'src',
        path: 'C:/projects/demo/src',
        type: 'folder',
        children: [
          { name: 'index.js', path: 'C:/projects/demo/src/index.js', type: 'file', children: [] },
        ],
      },
      { name: 'README.md', path: 'C:/projects/demo/README.md', type: 'file', children: [] },
    ]);
    n.readFile.mockResolvedValue('console.log("hi");');

    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Open Folder' }));

    // Explorer header (and status bar) show the project name once open.
    const demoLabels = await screen.findAllByText('demo');
    expect(demoLabels.length).toBeGreaterThan(0);

    // Expand the folder, then open the file.
    await user.click(screen.getByText('src'));
    await user.click(await screen.findByText('index.js'));

    expect(await screen.findByRole('button', { name: 'Close index.js' })).toBeInTheDocument();
    expect(n.readFile).toHaveBeenCalledWith('C:/projects/demo', 'C:/projects/demo/src/index.js');

    // Monaco receives the file content and language.
    await waitFor(() => {
      const editor = screen.getByTestId('monaco-stub');
      expect(editor).toHaveAttribute('data-language', 'javascript');
      expect(editor).toHaveAttribute('data-value', 'console.log("hi");');
    });
  });

  it('marks documents dirty on edit and saves with Ctrl+S through the bridge', async () => {
    const n = nova();
    n.chooseDirectory.mockResolvedValue('C:/projects/demo');
    n.readDir.mockResolvedValue([
      { name: 'a.js', path: 'C:/projects/demo/a.js', type: 'file', children: [] },
    ]);
    n.readFile.mockResolvedValue('let x = 1;');

    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Open Folder' }));
    await user.click(await screen.findByText('a.js'));
    await screen.findByRole('button', { name: 'Close a.js' });

    n.writeFile.mockClear();

    // Save via the Ctrl+S hotkey and verify the write crosses the bridge
    // with the exact document text.
    await user.keyboard('{Control>}s{/Control}');

    await waitFor(() => {
      expect(n.writeFile).toHaveBeenCalled();
    });
    expect(n.writeFile).toHaveBeenCalledWith('C:/projects/demo', 'C:/projects/demo/a.js', 'let x = 1;');
  });

  it('degrades to browser mode with a clear message when the bridge is missing', async () => {
    const originalApi = window.novaApi;
    delete window.novaApi;
    // Re-import with a clean module registry so novaClient re-evaluates.
    vi.resetModules();
    const { default: FreshApp } = await import('../src/App');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<FreshApp />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Open Folder' }));

    await waitFor(() => {
      expect(screen.getByText(/desktop app/i)).toBeInTheDocument();
    });
    consoleError.mockRestore();
    window.novaApi = originalApi;
  });
});
