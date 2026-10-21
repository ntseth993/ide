/**
 * Minimal pub/sub bus for renderer-side cross-component commands.
 *
 * The menu dispatches into App's command registry; commands that target a
 * component owning its own state (terminal sessions) travel over this bus
 * instead of lifting that state into App. Events: 'terminal:run'
 * { command }, 'terminal:new', 'terminal:clear', 'terminal:stop'.
 */

const listeners = new Map();

export function emit(event, payload) {
  const handlers = listeners.get(event);
  if (!handlers) return;
  for (const handler of [...handlers]) handler(payload);
}

export function subscribe(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event)?.delete(handler);
}

/** Testing helper: drop all listeners. */
export function clear() {
  listeners.clear();
}
