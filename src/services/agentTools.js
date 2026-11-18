/**
 * AI Agent tool protocol — pure parsing, classification and formatting.
 *
 * In Agent mode the model emits fenced `novacode-tool` blocks, each holding one
 * JSON object describing a real action against the workspace (read a file, edit
 * a file, create a folder, run a terminal command…). The panel executes these
 * AUTONOMOUSLY — there is no approval gate for ordinary work — and feeds the
 * result back so the model can continue and fix its own errors. Safety lives in
 * the main process (agentPolicy + pathGuard), not here; this module only decides
 * which tool names are recognised and how they are labelled.
 */

// Fenced block whose info-string is exactly `novacode-tool`.
const TOOL_BLOCK_RE = /```novacode-tool[^\n]*\r?\n([\s\S]*?)```/g;

// Some models ignore the fenced-JSON protocol and emit an XML-style function /
// parameter envelope instead. We accept both so the agent runs whichever dialect
// the current model speaks. `[\x3C]` matches the opening angle bracket so this
// source never contains a literal tag that would confuse the surrounding tooling.
const FUNCTION_RE = /[\x3C]function\s*[=\s]\s*([A-Za-z0-9_.-]+)\s*>([\s\S]*?)[\x3C]\/function\s*>/g;
const PARAM_RE = /[\x3C]parameter(?:\s*=\s*|\s+name\s*=\s*["']|\s+)([A-Za-z0-9_.-]+?)(?:["']\s*)?>([\s\S]*?)[\x3C]\/parameter\s*>/g;
// Whole envelope plus bare wrapper tags, used when cleaning the visible answer.
const XML_TOOL_RE = /[\x3C]tool_call\s*>[\s\S]*?[\x3C]\/tool_call\s*>|[\x3C]function\s*[=\s][\s\S]*?[\x3C]\/function\s*>|[\x3C]\/?tool[\w-]*\s*>/g;
// A third dialect some models use: a JSON object (name/arguments) wrapped in the
// tool-call tags rather than broken into child tags.
const TOOL_CALL_JSON_RE = /[\x3C]tool_call\s*>([\s\S]*?)[\x3C]\/tool_call\s*>/g;

// The full autonomous surface. Every one of these is routed to a governed
// `agent:*` IPC channel in the main process, which enforces workspace
// confinement, refuses secret files, and blocks destructive commands.
export const KNOWN_TOOLS = [
  'read_file',
  'list_dir',
  'search',
  'write_file',
  'create_file',
  'create_folder',
  'delete_path',
  'rename_path',
  'move_path',
  'run_command',
];

// Tools that only inspect — never mutate the project.
const READ_ONLY_TOOLS = new Set(['read_file', 'list_dir', 'search']);

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

/** Strip only the wrapper newlines so multi-line file content keeps indentation. */
function coerceParamValue(raw) {
  const value = String(raw).replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

// Canonical arguments each governed tool needs, so an XML model that names its
// parameters differently (file_path, pattern, shell_command…) still drives the
// right action. Exact names always win; the synonyms below are the fallback.
const TOOL_PARAMS = {
  read_file: ['path'],
  list_dir: ['path'],
  search: ['query', 'isRegex', 'caseSensitive'],
  write_file: ['path', 'content'],
  create_file: ['path', 'content'],
  create_folder: ['path'],
  delete_path: ['path'],
  rename_path: ['path', 'newName'],
  move_path: ['path', 'destDir'],
  run_command: ['command', 'cwd'],
};

const PARAM_SYNONYMS = {
  path: ['file_path', 'filepath', 'file', 'filename', 'file_name', 'old_path', 'target', 'dir', 'directory', 'folder', 'folder_path'],
  content: ['contents', 'text', 'body', 'data', 'file_content', 'file_text', 'new_content'],
  query: ['pattern', 'search_query', 'search_text', 'search', 'term', 'terms', 'text', 'substring', 'keyword'],
  command: ['cmd', 'shell_command', 'script', 'terminal_command'],
  newName: ['new_name', 'name', 'new'],
  destDir: ['dest_dir', 'destination', 'dest', 'target_dir', 'to', 'new_path'],
  isRegex: ['is_regex', 'regex', 'use_regex'],
  caseSensitive: ['case_sensitive', 'case'],
  cwd: ['working_dir', 'workdir'],
};

/** Map the model's parameter names onto this tool's canonical arguments. */
function resolveArgs(tool, rawEntries) {
  const wanted = TOOL_PARAMS[tool] || [];
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const pool = rawEntries.map(([key, value]) => ({ key: norm(key), value, used: false }));
  const args = {};
  for (const canon of wanted) {
    const aliases = [norm(canon), ...(PARAM_SYNONYMS[canon] || []).map(norm)];
    const hit = pool.find((entry) => !entry.used && aliases.includes(entry.key));
    if (hit) { hit.used = true; args[canon] = hit.value; }
  }
  return args;
}

/** Turn one XML-style function match into a normalised call, or null if unknown. */
function normalizeXmlCall(match) {
  const tool = String(match[1]).trim().toLowerCase().replace(/[-.\s]+/g, '_');
  if (!KNOWN_TOOLS.includes(tool)) return null;
  const rawEntries = [];
  PARAM_RE.lastIndex = 0;
  let param = PARAM_RE.exec(match[2]);
  while (param) {
    rawEntries.push([String(param[1]).trim(), coerceParamValue(param[2])]);
    param = PARAM_RE.exec(match[2]);
  }
  return { id: nextId(), tool, args: resolveArgs(tool, rawEntries) };
}

/** Turn a JSON object wrapped in the tool-call tags into a normalised call. */
function normalizeToolCallJson(raw) {
  try {
    const obj = JSON.parse(String(raw).trim());
    if (!obj || typeof obj !== 'object') return null;
    return normalizeCall({ tool: obj.name || obj.tool, args: obj.arguments || obj.args || {} });
  } catch {
    return null;
  }
}

/**
 * Extract every valid tool call from an assistant message, in document order.
 * Both the fenced-JSON protocol and the XML-style envelope are accepted, so a
 * model that ignores our formatting still gets its actions executed. Malformed
 * JSON, unknown tools or stray tags are ignored so a hiccup never halts the loop.
 */
export function parseToolCalls(text) {
  const found = [];
  if (typeof text !== 'string') return found;
  TOOL_BLOCK_RE.lastIndex = 0;
  let match = TOOL_BLOCK_RE.exec(text);
  while (match) {
    try {
      const call = normalizeCall(JSON.parse(match[1].trim()));
      if (call) found.push({ index: match.index, call });
    } catch {
      /* ignore unparseable block */
    }
    match = TOOL_BLOCK_RE.exec(text);
  }
  FUNCTION_RE.lastIndex = 0;
  let xml = FUNCTION_RE.exec(text);
  while (xml) {
    const call = normalizeXmlCall(xml);
    if (call) found.push({ index: xml.index, call });
    xml = FUNCTION_RE.exec(text);
  }
  TOOL_CALL_JSON_RE.lastIndex = 0;
  let wrapped = TOOL_CALL_JSON_RE.exec(text);
  while (wrapped) {
    const call = normalizeToolCallJson(wrapped[1]);
    if (call) found.push({ index: wrapped.index, call });
    wrapped = TOOL_CALL_JSON_RE.exec(text);
  }
  found.sort((a, b) => a.index - b.index);
  return found.map((entry) => entry.call);
}

/** Remove every tool block (fenced JSON or XML envelope) so raw protocol markup
    is never shown as prose in the answer bubble. */
export function stripToolCalls(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(TOOL_BLOCK_RE, '')
    .replace(XML_TOOL_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * In Agent mode there is no approval dialog: every recognised tool runs at
 * once. Anything the model invents never reaches here (parseToolCalls drops
 * unknown names), and the ones that do are still re-checked by the backend.
 */
export function isAutoTool(tool) {
  return KNOWN_TOOLS.includes(tool);
}

/** True when a tool only reads — used to keep the activity wording honest. */
export function isReadOnlyTool(tool) {
  return READ_ONLY_TOOLS.has(tool);
}

/** Short human labels for the action card. */
export function describeToolCall(call) {
  const args = call.args || {};
  const subject = args.path || args.command || args.query || args.dir || args.newName || '';
  switch (call.tool) {
    case 'read_file':
      return { title: 'Reading file', detail: String(subject) };
    case 'list_dir':
      return { title: 'Inspecting project', detail: String(subject || 'workspace root') };
    case 'search':
      return { title: 'Searching project', detail: String(args.query || subject) };
    case 'write_file':
      return { title: 'Writing file', detail: String(subject) };
    case 'create_file':
      return { title: 'Creating file', detail: String(subject) };
    case 'create_folder':
      return { title: 'Creating folder', detail: String(subject) };
    case 'delete_path':
      return { title: 'Deleting item', detail: String(subject) };
    case 'rename_path':
      return { title: 'Renaming', detail: String(subject) };
    case 'move_path':
      return { title: 'Moving', detail: String(subject) };
    case 'run_command':
      return { title: 'Running command', detail: String(args.command || subject) };
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
    if (result.skipped) return `${head}\n(Stopped before this ran.)`;
    if (result.note) return `${head}\n${result.note}`;
    const status = result.ok ? 'succeeded' : `failed${result.code != null ? ` (exit ${result.code})` : ''}`;
    const body = clip(result.output);
    const err = result.error ? `\nError: ${clip(result.error, 1000)}` : '';
    return `${head} ${status}:${err}${body ? `\n${body}` : ''}`;
  });
  return ['Tool results from the last step:', '', ...blocks, '', 'Continue: use these to finish the task, fix any error above, or make another tool call. When everything is done, describe what you changed and stop.'].join('\n');
}
