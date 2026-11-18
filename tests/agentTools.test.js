import { describe, it, expect } from 'vitest';
import {
  parseToolCalls,
  stripToolCalls,
  isAutoTool,
  isReadOnlyTool,
  describeToolCall,
  formatToolResults,
  KNOWN_TOOLS,
} from '../src/services/agentTools';

const fence = (obj) => '```novacode-tool\n' + JSON.stringify(obj) + '\n```';
// Build the XML envelope from a bracket constant so this source holds no literal tag.
const LT = '<';
const xml = (name, params) => {
  const inner = Object.entries(params)
    .map(([k, v]) => `${LT}parameter=${k}>${v}${LT}/parameter>`)
    .join('\n');
  return `${LT}function=${name}>\n${inner}\n${LT}/function>`;
};

describe('agentTools.parseToolCalls', () => {
  it('parses every autonomous tool the agent can run', () => {
    const text = [
      fence({ tool: 'read_file', args: { path: 'src/App.jsx' } }),
      fence({ tool: 'write_file', args: { path: 'src/Login.jsx', content: 'x' } }),
      fence({ tool: 'create_folder', args: { path: 'src/components' } }),
      fence({ tool: 'delete_path', args: { path: 'src/old' } }),
      fence({ tool: 'run_command', args: { command: 'npm install express' } }),
    ].join('\n');
    const calls = parseToolCalls(text);
    expect(calls).toHaveLength(5);
    expect(calls.map((c) => c.tool)).toEqual([
      'read_file', 'write_file', 'create_folder', 'delete_path', 'run_command',
    ]);
    expect(calls[4].args.command).toBe('npm install express');
    // Every call carries a stable id used to route live status updates.
    expect(calls.every((c) => c.id)).toBe(true);
  });

  it('parses multiple blocks in document order', () => {
    const calls = parseToolCalls(`${fence({ tool: 'list_dir', args: {} })}\nprose\n${fence({ tool: 'search', args: { query: 'a' } })}`);
    expect(calls.map((c) => c.tool)).toEqual(['list_dir', 'search']);
  });

  it('ignores unknown tools and malformed JSON without throwing', () => {
    const text = fence({ tool: 'launch_missiles', args: {} })
      + '\n```novacode-tool\n{ not valid json }\n```';
    expect(parseToolCalls(text)).toHaveLength(0);
  });

  it('defaults missing args to an empty object', () => {
    const calls = parseToolCalls(fence({ tool: 'run_command' }));
    expect(calls[0].args).toEqual({});
  });

  it('returns empty for non-string input', () => {
    expect(parseToolCalls(undefined)).toEqual([]);
    expect(parseToolCalls(null)).toEqual([]);
  });

  it('parses an XML-style function/parameter envelope', () => {
    const calls = parseToolCalls(`Sure, let me look.\n${xml('list_dir', { path: '.' })}`);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('list_dir');
    expect(calls[0].args).toEqual({ path: '.' });
  });

  it('coerces true/false parameters and preserves multi-line content', () => {
    const found = parseToolCalls(xml('search', { query: 'useState', isRegex: 'true' }));
    expect(found[0].args).toEqual({ query: 'useState', isRegex: true });
    const w = parseToolCalls(xml('write_file', { path: 'a.js', content: 'line1\n  line2' }))[0];
    expect(w.args.content).toBe('line1\n  line2');
  });

  it("maps synonym parameter names onto each tool's canonical argument", () => {
    expect(parseToolCalls(xml('read_file', { file_path: 'src/App.jsx' }))[0].args).toEqual({ path: 'src/App.jsx' });
    expect(parseToolCalls(xml('search', { pattern: 'useState' }))[0].args).toEqual({ query: 'useState' });
    expect(parseToolCalls(xml('run_command', { shell_command: 'npm test' }))[0].args).toEqual({ command: 'npm test' });
  });

  it('accepts the name="key" attribute form for parameters', () => {
    const block = `${LT}function=read_file>\n${LT}parameter name="path">src/App.jsx${LT}/parameter>\n${LT}/function>`;
    const call = parseToolCalls(block)[0];
    expect(call.tool).toBe('read_file');
    expect(call.args).toEqual({ path: 'src/App.jsx' });
  });

  it('parses a JSON object wrapped in the tool-call tags', () => {
    const block = `${LT}tool_call>{"name":"read_file","arguments":{"path":"src/App.jsx"}}${LT}/tool_call>`;
    const call = parseToolCalls(`Working.\n${block}`)[0];
    expect(call.tool).toBe('read_file');
    expect(call.args).toEqual({ path: 'src/App.jsx' });
  });

  it('ignores unknown tools expressed in the XML envelope', () => {
    expect(parseToolCalls(xml('launch_missiles', { code: '123' }))).toHaveLength(0);
  });

  it('orders mixed fenced-JSON and XML calls by document position', () => {
    const text = `${fence({ tool: 'list_dir', args: {} })}\n${xml('read_file', { path: 'b.js' })}`;
    expect(parseToolCalls(text).map((c) => c.tool)).toEqual(['list_dir', 'read_file']);
  });

  it('knows exactly the governed autonomous surface', () => {
    expect(KNOWN_TOOLS).toEqual([
      'read_file', 'list_dir', 'search', 'write_file', 'create_file',
      'create_folder', 'delete_path', 'rename_path', 'move_path', 'run_command',
    ]);
  });
});

describe('agentTools.stripToolCalls', () => {
  it('removes tool fences but keeps prose', () => {
    const text = `Here is my plan.\n${fence({ tool: 'write_file', args: { path: 'a', content: 'x' } })}\nDone.`;
    const stripped = stripToolCalls(text);
    expect(stripped).not.toContain('novacode-tool');
    expect(stripped).toContain('Here is my plan.');
    expect(stripped).toContain('Done.');
  });

  it('removes XML envelope and wrapper tags but keeps prose', () => {
    const stripped = stripToolCalls(`Looking now.\n${LT}tool_call>\n${xml('list_dir', { path: '.' })}\n${LT}/tool_call>\nDone.`);
    expect(stripped).not.toContain('function');
    expect(stripped).not.toContain('tool_call');
    expect(stripped).toContain('Looking now.');
    expect(stripped).toContain('Done.');
  });

  it('removes a wrapped JSON tool call from the visible answer', () => {
    const block = `${LT}tool_call>{"name":"list_dir","arguments":{}}${LT}/tool_call>`;
    const stripped = stripToolCalls(`Here.\n${block}\nDone.`);
    expect(stripped).not.toContain('list_dir');
    expect(stripped).not.toContain('tool_call');
    expect(stripped).toContain('Here.');
    expect(stripped).toContain('Done.');
  });
});

describe('agentTools.classification', () => {
  it('treats every known tool as auto — there is no approval gate in Agent mode', () => {
    for (const tool of KNOWN_TOOLS) expect(isAutoTool(tool)).toBe(true);
    // Nothing the model invents is ever auto-run.
    expect(isAutoTool('launch_missiles')).toBe(false);
    expect(isAutoTool('edit_current_file')).toBe(false);
  });

  it('flags the read-only inspection tools', () => {
    expect(isReadOnlyTool('read_file')).toBe(true);
    expect(isReadOnlyTool('list_dir')).toBe(true);
    expect(isReadOnlyTool('search')).toBe(true);
    expect(isReadOnlyTool('write_file')).toBe(false);
    expect(isReadOnlyTool('run_command')).toBe(false);
  });

  it('describes each call for the action card', () => {
    expect(describeToolCall({ tool: 'run_command', args: { command: 'npm run build' } }))
      .toEqual({ title: 'Running command', detail: 'npm run build' });
    expect(describeToolCall({ tool: 'write_file', args: { path: 'src/App.jsx' } }))
      .toEqual({ title: 'Writing file', detail: 'src/App.jsx' });
    expect(describeToolCall({ tool: 'list_dir', args: {} }))
      .toEqual({ title: 'Inspecting project', detail: 'workspace root' });
    expect(describeToolCall({ tool: 'move_path', args: { path: 'a.jsx' } }))
      .toEqual({ title: 'Moving', detail: 'a.jsx' });
  });

  it('falls back for an unexpected tool name', () => {
    expect(describeToolCall({ tool: 'weird', args: {} }).title).toBe('weird');
  });
});

describe('agentTools.formatToolResults', () => {
  it('reports a succeeded command with its output', () => {
    const msg = formatToolResults([{ tool: 'run_command', args: { command: 'npm test' }, ok: true, code: 0, output: '23 passing' }]);
    expect(msg).toContain('run_command — npm test succeeded');
    expect(msg).toContain('23 passing');
  });

  it('flags a failed command with exit code and error so the model can fix it', () => {
    const msg = formatToolResults([{ tool: 'run_command', args: { command: 'npm run build' }, ok: false, code: 1, error: 'Module not found' }]);
    expect(msg).toContain('failed (exit 1)');
    expect(msg).toContain('Module not found');
  });

  it('passes a note straight through (e.g. a started dev server)', () => {
    const msg = formatToolResults([{ tool: 'run_command', args: { command: 'npm run dev' }, ok: true, note: 'Started in the integrated terminal — still running.' }]);
    expect(msg).toContain('still running');
  });

  it('marks a skipped result when the user hit Stop', () => {
    const msg = formatToolResults([{ tool: 'write_file', args: {}, skipped: true }]);
    expect(msg).toContain('Stopped before this ran');
  });
});
