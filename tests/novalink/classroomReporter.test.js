// @vitest-environment node
/**
 * Client-side tests for the classroom activity reporter.
 *
 * Focus: debounce behaviour + payload truncation. The reporter's contract with
 * the server (see tests/link-server/classroom.test.js) is that only ONE
 * `editor.snapshot` frame is emitted per `DEBOUNCE_MS` window, regardless of
 * how many keystrokes triggered `onEditorChange`. Everything else fires
 * immediately because it is low-frequency.
 *
 * We stub `liveClient.send` to record every frame and use vi.useFakeTimers to
 * advance past the debounce window without waiting in real time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createActivityReporter,
  DEBOUNCE_MS,
  MAX_CONTENT_SNIPPET,
} = require('../../electron/services/classroom/activityReporter.js');

function makeStubs({
  enrolled = true,
  status = { enrollmentId: 'enr-1', classId: 'cls-1' },
} = {}) {
  const sent = [];
  const enrollmentStore = {
    isEnrolled: vi.fn(async () => enrolled),
    getStatus: vi.fn(async () => status),
  };
  const liveClient = { send: vi.fn((frame) => sent.push(frame)) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { sent, enrollmentStore, liveClient, logger };
}

async function startedReporter(stubOverrides) {
  const stubs = makeStubs(stubOverrides);
  const reporter = createActivityReporter(stubs);
  await reporter.start();
  // Drop the classroom.identify frame so tests focus on activity frames only.
  stubs.sent.length = 0;
  return { reporter, stubs };
}

describe('activityReporter — start/stop', () => {
  it('does not activate when the user is not enrolled', async () => {
    const stubs = makeStubs({ enrolled: false });
    const reporter = createActivityReporter(stubs);
    await reporter.start();
    expect(reporter.isActive()).toBe(false);
    expect(stubs.liveClient.send).not.toHaveBeenCalled();
  });

  it('sends classroom.identify on start when enrolled', async () => {
    const stubs = makeStubs();
    const reporter = createActivityReporter(stubs);
    await reporter.start();
    expect(reporter.isActive()).toBe(true);
    expect(stubs.sent[0]).toEqual({
      type: 'classroom.identify',
      enrollmentId: 'enr-1',
      classId: 'cls-1',
    });
  });

  it('drops subsequent reports after stop()', async () => {
    const { reporter, stubs } = await startedReporter();
    reporter.stop();
    reporter.onTerminalCommand({ command: 'ls' });
    expect(stubs.sent).toHaveLength(0);
  });
});

describe('activityReporter — editor snapshot debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses rapid edits into one snapshot at DEBOUNCE_MS', async () => {
    const { reporter, stubs } = await startedReporter();
    reporter.onEditorChange({ path: 'a.js', language: 'javascript', content: 'let a' });
    reporter.onEditorChange({ path: 'a.js', language: 'javascript', content: 'let ab' });
    reporter.onEditorChange({ path: 'a.js', language: 'javascript', content: 'let abc' });
    expect(stubs.sent).toHaveLength(0);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(stubs.sent).toHaveLength(1);
    const frame = stubs.sent[0];
    expect(frame.type).toBe('activity.report');
    expect(frame.eventType).toBe('editor.snapshot');
    // The LAST pending content wins, not the first.
    expect(frame.payload.content).toBe('let abc');
    expect(frame.payload.path).toBe('a.js');
    expect(frame.payload.language).toBe('javascript');
  });

  it('starts a fresh debounce window after each emission', async () => {
    const { reporter, stubs } = await startedReporter();
    reporter.onEditorChange({ path: 'a.js', content: 'x' });
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(stubs.sent).toHaveLength(1);
    reporter.onEditorChange({ path: 'a.js', content: 'y' });
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(stubs.sent).toHaveLength(2);
    expect(stubs.sent[1].payload.content).toBe('y');
  });

  it('truncates long editor content to MAX_CONTENT_SNIPPET characters', async () => {
    const { reporter, stubs } = await startedReporter();
    const long = 'a'.repeat(MAX_CONTENT_SNIPPET * 3);
    reporter.onEditorChange({ path: 'big.js', content: long });
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(stubs.sent[0].payload.content).toHaveLength(MAX_CONTENT_SNIPPET);
  });

  it('flushes the pending snapshot on file switch (onFileOpen)', async () => {
    const { reporter, stubs } = await startedReporter();
    reporter.onEditorChange({ path: 'a.js', content: 'partial' });
    // Switching files should immediately emit the pending snapshot BEFORE
    // the file.open frame so the teacher sees the last state of the previous
    // file.
    reporter.onFileOpen({ path: 'b.js', language: 'javascript' });
    expect(stubs.sent.map((f) => f.eventType)).toEqual(['editor.snapshot', 'file.open']);
    expect(stubs.sent[0].payload.path).toBe('a.js');
    // No leftover timer should fire a duplicate after the debounce elapses.
    stubs.sent.length = 0;
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(stubs.sent).toHaveLength(0);
  });
});

describe('activityReporter — immediate frames', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('onTerminalCommand sends without waiting for the debounce', async () => {
    const { reporter, stubs } = await startedReporter();
    reporter.onTerminalCommand({ command: 'npm test', cwd: '/repo' });
    expect(stubs.sent).toHaveLength(1);
    expect(stubs.sent[0]).toMatchObject({
      type: 'activity.report',
      eventType: 'terminal.command',
      payload: { command: 'npm test', cwd: '/repo' },
    });
  });

  it('onAIPrompt truncates the prompt to 300 characters', async () => {
    const { reporter, stubs } = await startedReporter();
    reporter.onAIPrompt({ prompt: 'p'.repeat(500), model: 'gpt-4o-mini' });
    expect(stubs.sent[0].payload.prompt).toHaveLength(300);
    expect(stubs.sent[0].payload.model).toBe('gpt-4o-mini');
  });

  it('onFileRename emits a file.rename frame with old and new paths', async () => {
    const { reporter, stubs } = await startedReporter();
    reporter.onFileRename({ oldPath: '/a.js', newPath: '/b.js' });
    expect(stubs.sent[0].eventType).toBe('file.rename');
    expect(stubs.sent[0].payload).toMatchObject({ oldPath: '/a.js', newPath: '/b.js' });
  });

  it('onAppFocus reports focus state as a boolean', async () => {
    const { reporter, stubs } = await startedReporter();
    reporter.onAppFocus({ focused: true });
    reporter.onAppFocus({ focused: 0 });
    expect(stubs.sent[0].payload.focused).toBe(true);
    expect(stubs.sent[1].payload.focused).toBe(false);
  });

  it('onTerminalCommand truncates long commands to 500 characters', async () => {
    const { reporter, stubs } = await startedReporter();
    reporter.onTerminalCommand({ command: 'x'.repeat(1200) });
    expect(stubs.sent[0].payload.command).toHaveLength(500);
  });
});

describe('activityReporter — transport failures', () => {
  it('swallows synchronous send errors and logs a warning', async () => {
    const stubs = makeStubs();
    stubs.liveClient.send = vi.fn(() => { throw new Error('socket closed'); });
    const reporter = createActivityReporter(stubs);
    await reporter.start();
    // start() itself already threw once on classroom.identify but must not
    // propagate — the reporter stays active so subsequent frames can retry.
    expect(() => reporter.onTerminalCommand({ command: 'ls' })).not.toThrow();
    expect(stubs.logger.warn).toHaveBeenCalled();
  });

  it('no-ops when liveClient is missing (partially wired service)', async () => {
    const stubs = makeStubs();
    const reporter = createActivityReporter({ ...stubs, liveClient: null });
    await reporter.start();
    expect(() => reporter.onTerminalCommand({ command: 'ls' })).not.toThrow();
  });
});
