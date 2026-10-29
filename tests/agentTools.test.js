import { describe, it, expect } from 'vitest';
import {
  parseToolCalls,
  stripToolCalls,
  isAutoTool,
  describeToolCall,
  formatToolResults,
  KNOWN_TOOLS,
} from '../src/services/agentTools';

const fence = (obj) => '```novacode-tool\n' + JSON.stringify(obj) + '\n```';

describe('agentTools.parseToolCalls', () => {
  it('parses valid tool blocks in order', () => {
    const text = `Plan.\n${fence({ tool: 'run_command', args: { command: 'npm test' } })}\nmore\n${fence({ tool: 'read_file', args: { path: 'a.js' } })}`;
    const calls = parseToolCalls(text);
    expect(calls).toHaveLength(2);
    expect(calls[0].tool).toBe('run_command');
    expect(calls[0].args.command).toBe('npm test');
    expect(calls[1].tool).toBe('read_file');
    expect(calls[1].args.path).toBe('a.js');
    expect(calls[0].id).toBeTruthy();
  });

  it('ignores unknown tools and malformed JSON without throwing', () => {
    const text = fence({ tool: 'launch_missiles', args: {} })
      + '\n```novacode-tool\n{ not valid json }\n```';
    expect(parseToolCalls(text)).toHaveLength(0);
  });

  it('defaults missing args to an empty object', () => {
    const calls = parseToolCalls(fence({ tool: 'read_file' }));
    expect(calls[0].args).toEqual({});
  });

  it('returns empty for non-string input', () => {
    expect(parseToolCalls(undefined)).toEqual([]);
    expect(parseToolCalls(null)).toEqual([]);
  });

  it('only knows the core set of tools', () => {
    expect(KNOWN_TOOLS).toEqual(['run_command', 'read_file', 'write_file']);
  });
});

describe('agentTools.stripToolCalls', () => {
  it('removes tool fences but keeps prose', () => {
    const text = `Here is my plan.\n${fence({ tool: 'run_command', args: { command: 'ls' } })}\nDone.`;
    const stripped = stripToolCalls(text);
    expect(stripped).not.toContain('novacode-tool');
    expect(stripped).toContain('Here is my plan.');
    expect(stripped).toContain('Done.');
  });
});

describe('agentTools.classification', () => {
  it('auto-runs reads/writes but not commands', () => {
    expect(isAutoTool('read_file')).toBe(true);
    expect(isAutoTool('write_file')).toBe(true);
    expect(isAutoTool('run_command')).toBe(false);
  });

  it('describes a call for the action card', () => {
    expect(describeToolCall({ tool: 'run_command', args: { command: ' npm test ' } })).toEqual({ title: 'Run command', detail: 'npm test' });
    expect(describeToolCall({ tool: 'read_file', args: { path: 'src/a.js' } })).toEqual({ title: 'Read file', detail: 'src/a.js' });
    expect(describeToolCall({ tool: 'write_file', args: { path: 'src/b.js' } }).title).toBe('Write file');
  });
});

describe('agentTools.formatToolResults', () => {
  it('summarizes success with output', () => {
    const msg = formatToolResults([{ tool: 'run_command', args: { command: 'npm test' }, ok: true, code: 0, output: 'all good' }]);
    expect(msg).toContain('run_command');
    expect(msg).toContain('succeeded');
    expect(msg).toContain('all good');
  });

  it('flags failures with the exit code and error', () => {
    const msg = formatToolResults([{ tool: 'run_command', args: { command: 'bad' }, ok: false, code: 2, error: 'boom' }]);
    expect(msg).toContain('failed');
    expect(msg).toContain('exit 2');
    expect(msg).toContain('boom');
  });

  it('notes a skipped command', () => {
    const msg = formatToolResults([{ tool: 'run_command', args: { command: 'x' }, ok: false, skipped: true }]);
    expect(msg).toContain('chose not to run');
  });

  it('passes through a write_file note', () => {
    const msg = formatToolResults([{ tool: 'write_file', args: { path: 'a.js' }, ok: true, note: 'Opened a diff for a.js.' }]);
    expect(msg).toContain('Opened a diff for a.js.');
  });
});
