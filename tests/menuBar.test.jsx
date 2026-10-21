// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MenuBar from '../src/components/MenuBar';
import { MENUS, MENU_BAR_COMMANDS } from '../src/services/menuStructure';

function makeCommands() {
  const run = vi.fn();
  const commands = MENU_BAR_COMMANDS.map((id) => ({ id, label: id, run }));
  return { commands, run };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('menuStructure', () => {
  it('exposes the standard top-level menus', () => {
    expect(MENUS.map((menu) => menu.label)).toEqual([
      'File', 'Edit', 'Selection', 'View', 'Go', 'Run', 'Terminal', 'Help',
    ]);
  });

  it('references command ids as non-empty strings (shared across menus)', () => {
    expect(MENU_BAR_COMMANDS.length).toBeGreaterThan(0);
    for (const id of MENU_BAR_COMMANDS) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
    // A few commands are intentionally reachable from more than one menu.
    expect(MENU_BAR_COMMANDS.filter((id) => id === 'view.search').length).toBeGreaterThan(1);
  });

  it('never mixes a command with the disabled placeholder', () => {
    for (const menu of MENUS) {
      for (const item of menu.items) {
        if (item.disabled) expect(item.command).toBeUndefined();
      }
    }
  });
});

describe('MenuBar', () => {
  it('renders every menu title without opening dropdowns', () => {
    render(<MenuBar commands={[]} />);
    const bar = screen.getByRole('menubar', { name: 'Application menu' });
    for (const menu of MENUS) {
      expect(within(bar).getByRole('menuitem', { name: menu.label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens a dropdown and runs the selected command', async () => {
    const { commands, run } = makeCommands();
    render(<MenuBar commands={commands} />);
    await userEvent.click(screen.getByRole('menuitem', { name: 'File' }));
    const menu = screen.getByRole('menu', { name: 'File' });
    await userEvent.click(within(menu).getByRole('menuitem', { name: /Save As…/ }));
    expect(run).toHaveBeenCalledTimes(1);
    // Menu closes after an action.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('renders unimplemented entries as disabled and inert', async () => {
    const { commands, run } = makeCommands();
    render(<MenuBar commands={commands} />);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Run' }));
    const menu = screen.getByRole('menu', { name: 'Run' });
    const debug = within(menu).getByRole('menuitem', { name: /Start Debugging/ });
    expect(debug).toBeDisabled();
    await userEvent.click(debug);
    expect(run).not.toHaveBeenCalled();
  });
});
