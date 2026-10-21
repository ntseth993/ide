/**
 * In-app top menu bar.
 *
 * A custom, always-visible menu (File / Edit / Selection / View / Go / Run /
 * Terminal / Help) that mirrors the native application menu. Every enabled
 * entry runs a command id resolved from the shared command registry, so menu
 * and palette never drift apart. Unimplemented entries render disabled.
 *
 * Interaction: click a title to open its dropdown, hover to switch while open,
 * Escape or an outside click to close, and Left/Right to move between menus.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import MENUS from '../services/menuStructure';
import AccountMenu from './AccountMenu';

/**
 * A single dropdown row. Handles three shapes:
 *  - enabled command item (optionally checkable, driven by command.checked),
 *  - disabled "not implemented yet" item,
 *  - submenu parent (renders a trailing arrow; not built as a nested flyout).
 */
function MenuItem({ item, commands, onRun }) {
  const command = item.command ? commands.find((entry) => entry.id === item.command) : null;
  const inert = Boolean(item.disabled || item.submenu);
  const checked = Boolean(command?.checked);
  return (
    <button
      type="button"
      role="menuitem"
      className={inert ? 'menu-item disabled' : 'menu-item'}
      aria-checked={command && 'checked' in command ? checked : undefined}
      disabled={inert}
      title={item.disabled ? 'Coming soon' : undefined}
      onClick={() => !inert && onRun(item.command)}
    >
      <span className="menu-item-check" aria-hidden="true">{checked ? '✓' : ''}</span>
      <span className="menu-item-label">{item.label}</span>
      {item.hint && <span className="menu-item-hint">{item.hint}</span>}
      {item.submenu && <span className="menu-item-arrow" aria-hidden="true">›</span>}
    </button>
  );
}

export default function MenuBar({ commands = [], menus = MENUS, account = null, onSignIn, onSignOut }) {
  const [openIndex, setOpenIndex] = useState(null);
  const barRef = useRef(null);
  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  const close = useCallback(() => setOpenIndex(null), []);

  const runCommand = useCallback((commandId) => {
    const command = commandsRef.current.find((entry) => entry.id === commandId);
    setOpenIndex(null);
    if (command) command.run();
  }, []);

  // Close when clicking anywhere outside the bar.
  useEffect(() => {
    if (openIndex === null) return undefined;
    function onPointerDown(event) {
      if (barRef.current && !barRef.current.contains(event.target)) close();
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [openIndex, close]);

  function onTitleKeyDown(event, index) {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      setOpenIndex((index + 1) % menus.length);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setOpenIndex((index - 1 + menus.length) % menus.length);
    } else if (event.key === 'Escape') {
      close();
    }
  }

  return (
    <nav className="menu-bar" ref={barRef} role="menubar" aria-label="Application menu">
      {menus.map((menu, index) => {
        const isOpen = openIndex === index;
        return (
          <div
            key={menu.label}
            className="menu-group"
            onMouseEnter={() => openIndex !== null && setOpenIndex(index)}
          >
            <button
              type="button"
              role="menuitem"
              aria-haspopup="true"
              aria-expanded={isOpen}
              className={isOpen ? 'menu-title open' : 'menu-title'}
              onClick={() => setOpenIndex(isOpen ? null : index)}
              onKeyDown={(event) => onTitleKeyDown(event, index)}
            >
              {menu.label}
            </button>

            {isOpen && (
              <ul className="menu-dropdown" role="menu" aria-label={menu.label}>
                {menu.items.map((item, itemIndex) =>
                  item.type === 'sep' ? (
                    <li key={`sep-${itemIndex}`} className="menu-sep" role="separator" />
                  ) : (
                    <li key={`${item.label}-${itemIndex}`} role="none">
                      <MenuItem item={item} commands={commands} onRun={runCommand} />
                    </li>
                  )
                )}
              </ul>
            )}
          </div>
        );
      })}
      <div className="menu-bar-spacer" />
      <AccountMenu account={account} onSignIn={onSignIn} onSignOut={onSignOut} />
    </nav>
  );
}
