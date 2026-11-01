'use strict';
/**
 * Classroom activity reporter.
 *
 * Hooks into IDE events (editor content changes, file opens, terminal commands,
 * AI prompts) and sends them over the existing NovaLink Live WebSocket as
 * `activity.report` frames. The server stores them and fans out to the teacher.
 *
 * Design:
 *   - Only active when enrollment is confirmed (checked via enrollmentStore).
 *   - Editor snapshots are debounced to at most once per 2 seconds to avoid
 *     flooding the socket with every keystroke.
 *   - Terminal commands and file opens are reported immediately (low frequency).
 *   - All payloads are structured JSON objects with a known shape per event type.
 */
const DEBOUNCE_MS = 2000;
const MAX_CONTENT_SNIPPET = 200;

function createActivityReporter({ enrollmentStore, liveClient, logger }) {
  let active = false;
  let debounceTimer = null;
  let pendingSnapshot = null;

  /** Start reporting if enrolled. Called after boot/auth. */
  async function start() {
    const enrolled = await enrollmentStore.isEnrolled();
    if (!enrolled) {
      active = false;
      return;
    }
    const status = await enrollmentStore.getStatus();
    active = true;
    // Send classroom.identify so the server links this socket to the enrollment
    sendFrame({ type: 'classroom.identify', enrollmentId: status.enrollmentId, classId: status.classId });
    logger.info?.('activity reporter started', { enrollmentId: status.enrollmentId });
  }

  function stop() {
    active = false;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    pendingSnapshot = null;
  }

  function sendFrame(frame) {
    if (!liveClient || !liveClient.send) return;
    try {
      liveClient.send(frame);
    } catch (error) {
      logger.warn?.('activity frame send failed', { error: error.message, type: frame.type });
    }
  }

  /** Flush a pending debounced snapshot immediately (e.g. on file switch). */
  function flushSnapshot() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (pendingSnapshot) {
      sendFrame({ type: 'activity.report', eventType: 'editor.snapshot', payload: pendingSnapshot });
      pendingSnapshot = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Public event hooks (called from registerIpc / App wiring)
  // ---------------------------------------------------------------------------

  /**
   * Editor content changed. Debounced — only the latest state within DEBOUNCE_MS
   * is reported.
   * @param {object} data - { path, language, content, cursorLine, cursorCol }
   */
  function onEditorChange(data) {
    if (!active) return;
    const snippet = String(data.content || '').slice(0, MAX_CONTENT_SNIPPET);
    pendingSnapshot = {
      path: data.path || '',
      language: data.language || 'plaintext',
      content: snippet,
      cursorLine: data.cursorLine || 0,
      cursorCol: data.cursorCol || 0,
      timestamp: Date.now(),
    };
    if (!debounceTimer) {
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (pendingSnapshot) {
          sendFrame({ type: 'activity.report', eventType: 'editor.snapshot', payload: pendingSnapshot });
          pendingSnapshot = null;
        }
      }, DEBOUNCE_MS);
      debounceTimer.unref?.();
    }
  }

  /** A file was opened or switched to. */
  function onFileOpen(data) {
    if (!active) return;
    flushSnapshot();
    sendFrame({
      type: 'activity.report',
      eventType: 'file.open',
      payload: { path: data.path || '', language: data.language || '', timestamp: Date.now() },
    });
  }

  /** A file was renamed. */
  function onFileRename(data) {
    if (!active) return;
    sendFrame({
      type: 'activity.report',
      eventType: 'file.rename',
      payload: { oldPath: data.oldPath || '', newPath: data.newPath || '', timestamp: Date.now() },
    });
  }

  /** A terminal command was executed. */
  function onTerminalCommand(data) {
    if (!active) return;
    sendFrame({
      type: 'activity.report',
      eventType: 'terminal.command',
      payload: { command: String(data.command || '').slice(0, 500), cwd: data.cwd || '', timestamp: Date.now() },
    });
  }

  /** An AI prompt was sent. */
  function onAIPrompt(data) {
    if (!active) return;
    sendFrame({
      type: 'activity.report',
      eventType: 'ai.prompt',
      payload: { prompt: String(data.prompt || '').slice(0, 300), model: data.model || '', timestamp: Date.now() },
    });
  }

  /** App focus changed (window gained/lost focus). */
  function onAppFocus(data) {
    if (!active) return;
    sendFrame({
      type: 'activity.report',
      eventType: 'app.focus',
      payload: { focused: Boolean(data.focused), timestamp: Date.now() },
    });
  }

  return {
    start,
    stop,
    onEditorChange,
    onFileOpen,
    onFileRename,
    onTerminalCommand,
    onAIPrompt,
    onAppFocus,
    isActive: () => active,
    DEBOUNCE_MS,
  };
}

module.exports = { createActivityReporter, DEBOUNCE_MS, MAX_CONTENT_SNIPPET };
