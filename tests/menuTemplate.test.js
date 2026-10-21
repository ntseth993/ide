/**
 * Tests for the native application menu template (electron/menu.js).
 * Pins the command contract between the menu and the renderer registry:
 * every dispatched id must exist in MENU_COMMANDS, unimplemented features
 * must be disabled rather than dead, and edit operations use native roles.
 */
import { describe, expect, it } from 'vitest';
import { buildMenuTemplate, MENU_COMMANDS, EDITOR_ACTIONS } from '../electron/menu';

function flatten(template, out = []) {
  for (const item of template) {
    if (item.submenu) flatten(item.submenu, out);
    else out.push(item);
  }
  return out;
}

describe('buildMenuTemplate', () => {
  const dispatched = [];
  const template = buildMenuTemplate({
    send: (id) => dispatched.push(id),
    showAbout: () => {},
    showDocs: () => {},
  });
  const items = flatten(template);

  it('covers every menu required by the spec', () => {
    const labels = template.map((menu) => menu.label.replace('&', ''));
    expect(labels).toEqual(['File', 'Edit', 'Selection', 'View', 'Go', 'Run', 'Terminal', 'Help']);
  });

  it('dispatches only known command ids', () => {
    for (const item of items) {
      if (item.click && !item.role) {
        // Invoke the click handler; it must call send with a known id.
        item.click();
      }
    }
    expect(dispatched.length).toBeGreaterThan(0);
    for (const id of dispatched) {
      expect(MENU_COMMANDS).toContain(id);
    }
  });

  it('includes every menu command id exactly once in the registry list', () => {
    expect(new Set(MENU_COMMANDS).size).toBe(MENU_COMMANDS.length);
  });

  it('uses native roles for clipboard edit operations', () => {
    const roles = items.map((item) => item.role);
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) {
      expect(roles).toContain(role);
    }
  });

  it('marks unimplemented features as disabled instead of dead', () => {
    const disabled = items.filter((item) => item.enabled === false).map((item) => item.label);
    expect(disabled.some((label) => label.includes('Source Control'))).toBe(true);
    expect(disabled.some((label) => label.includes('Debug'))).toBe(true);
    expect(disabled.some((label) => label.includes('Split Terminal'))).toBe(true);
    expect(disabled.some((label) => label === 'Back (coming soon)')).toBe(true);
    expect(disabled.some((label) => label === 'Forward (coming soon)')).toBe(true);
  });

  it('defines standard accelerators for core commands', () => {
    const byLabel = new Map(items.map((item) => [item.label, item.accelerator]));
    expect(byLabel.get('Save')).toBe('CmdOrCtrl+S');
    expect(byLabel.get('Save As…')).toBe('CmdOrCtrl+Shift+S');
    expect(byLabel.get('Close Editor')).toBe('CmdOrCtrl+W');
    expect(byLabel.get('Command Palette')).toBe('CmdOrCtrl+Shift+P');
    expect(byLabel.get('Run File')).toBe('F5');
    expect(byLabel.get('Extensions')).toBe('CmdOrCtrl+Shift+X');
    // No chord accelerators (Electron menus do not support them).
    for (const accelerator of byLabel.values()) {
      if (accelerator) expect(accelerator).not.toContain('+K+');
    }
  });

  it('exposes editor action ids used by the renderer', () => {
    expect(EDITOR_ACTIONS.find.command).toBe('editor.find');
    expect(EDITOR_ACTIONS['goto-definition'].command).toBe('editor.goto-definition');
  });

  it('wires Help dialogs through the provided hooks', () => {
    let about = false;
    let docs = false;
    const helpMenu = template.find((menu) => menu.label === '&Help');
    const hooks = buildMenuTemplate({
      send: () => {},
      showAbout: () => { about = true; },
      showDocs: () => { docs = true; },
    }).find((menu) => menu.label === '&Help');
    for (const item of helpMenu.submenu) item.click?.();
    for (const item of hooks.submenu) item.click?.();
    expect(about).toBe(true);
    expect(docs).toBe(true);
  });
});
