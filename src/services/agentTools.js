/**
 * AI Agent tool protocol — pure parsing, classification and formatting.
 *
 * Models in Agent mode emit fenced `novacode-tool` blocks, each holding one
 * JSON object describing an action (run a command, read a file, write a file).
 * Keeping the parse/format logic here (no React, no IPC) makes it unit-testable
 * and lets the panel own only the orchestration: executing calls, asking for
 * approval and feeding results back to the model.
 */

// Fenced block whose info-string is exactly `novacode-tool`.
const TOOL_BLOCK_RE = /```novacode-tool[^\n]*\r?\n([\s\S]*?)```/g;

export const KNOWN_TOOLS = ['run_command', 'read_file', 'write_file'];

let seq = 0;
function nextId() {
  seq += 1;
  return `tool-${seq}`;
}

/** Coerce one parsed object into a well-formed call, or null if unusable. */
function normalizeCall(value) {
  if (!value || typeof value !== 'object') return null;
  const tool = typeof value.tool === 'string' ? value.tool.trim() : '';
  if (!KNOWN_TOOLS.includes(tool)) return null;
  const args = value.args && typeof value.args === 'object' ? value.args : {};
  return { id: nextId(), tool, args };
}

/**
 * Extract every valid tool call from an assistant message, in order.
 * Malformed JSON or unknown tools are ignored so a model hiccup never halts
 * the loop — the panel just treats them as prose.
 */
export function parseToolCalls(text) {
  const calls = [];
  if (typeof text !== 'string') return calls;
  TOOL_BLOCK_RE.lastIndex = 0;
  let match = TOOL_BLOCK_RE.exec(text);
  while (match) {
    try {
      const call = normalizeCall(JSON.parse(match[1].trim()));
      if (call) calls.push(call);
    } catch {
      /* ignore unparseable block */
    }
    match = TOOL_BLOCK_RE.exec(text);
  }
  return calls;
}

/** Remove every novacode-tool block so raw tool JSON is never shown as code. */
export function stripToolCalls(text) {
  if (typeof text !== 'string') return '';
  return text.replace(TOOL_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * read_file and write_file run without a prompt; run_command always needs the
 * user to click Run first (write_file still gates the actual save behind the
 * existing diff review).
 */
export function isAutoTool(tool) {
  return tool === 'read_file' || tool === 'write_file';
}

/** Short human labels for the action card. */
export function describeToolCall(call) {
  const args = call.args || {};
  switch (call.tool) {
    case 'run_command':
      return { title: 'Run command', detail: String(args.command || '').trim() };
    case 'read_file':
      return { title: 'Read file', detail: String(args.path || '').trim() };
    case 'write_file':
      return { title: 'Write file', detail: String(args.path || '').trim() };
    default:
      return { title: String(call.tool || 'Tool'), detail: '' };
  }
}

/** Cap very long outputs so the feedback message stays inside the context. */
function clip(text, max = 8000) {
  const value = String(text == null ? '' : text);
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… (truncated, ${value.length - max} more chars)`;
}

/**
 * Turn executed results into the text message fed back to the model. Each
 * result: { tool, args, ok, output, code, error, skipped, note }.
 */
export function formatToolResults(results) {
  const blocks = (results || []).map((result) => {
    const subject = result.args && (result.args.command || result.args.path) || '';
    const head = `TOOL ${result.tool}${subject ? ` — ${subject}` : ''}`;
    if (result.skipped) return `${head}\n(The user chose not to run this.)`;
    if (result.note) return `${head}\n${result.note}`;
    const status = result.ok ? 'succeeded' : `failed${result.code != null ? ` (exit ${result.code})` : ''}`;
    const body = clip(result.output);
    const err = result.error ? `\nError: ${clip(result.error, 1000)}` : '';
    return `${head} ${status}:${err}${body ? `\n${body}` : ''}`;
  });
  return ['Tool results from the last step:', '', ...blocks, '', 'Continue: use these to finish the task, or make another tool call.'].join('\n');
}
