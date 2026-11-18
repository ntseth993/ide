/**
 * Shared AI prompt policy.
 *
 * One place that decides how NovaCode talks to models, so chat answers and
 * inline suggestions follow the same bar for quality: short, correct,
 * idiomatic, dependency-free code that a person can read once and keep.
 */

export const QUALITY_RULES = [
  'Write the simplest code that correctly solves the problem.',
  'Prefer the standard library and APIs already used in the file.',
  'Keep functions small and named for what they do; no speculative abstractions or extra layers.',
  'Match the file existing indentation, quotes and style.',
  'Add comments only where the code cannot speak for itself.',
  'Never invent APIs, options or package names; if unsure, say so in one line.',
  'No boilerplate preambles or trailing summaries unless asked.',
];

const LEVEL_GUIDANCE = {
  beginner: 'Assume the reader is new: name things plainly and explain the why in one short line.',
  intermediate: 'Assume solid fundamentals: skip basic syntax explanation, focus on correct trade-offs.',
  advanced: 'Assume deep expertise: be terse, mention edge cases, complexity and failure modes only.',
};

// The autonomous Agent protocol. In Agent mode the assistant DOES the work:
// it reads and edits any file in the opened project, creates and removes files
// and folders, renames and moves them, and runs real terminal commands — all
// WITHOUT asking for approval. Each action is one fenced `novacode-tool` block;
// NovaCode executes it, returns the result, and the model continues until the
// task is genuinely done. Safety (workspace confinement, secret-file refusal,
// destructive-command blocking) is enforced by the backend, so the model must
// simply stay inside normal development work.
const TOOL_PROTOCOL = [
  'You are an autonomous coding agent. You DO the work yourself instead of describing it — emit tool blocks and NovaCode runs them immediately, then feeds you the result so you can continue.',
  'Emit ONE action per fenced block tagged novacode-tool containing exactly one JSON object. You may emit several blocks in a turn; they run in order. After acting, STOP and wait for the results before continuing.',
  'Available tools and their exact JSON shapes:',
  '{"tool":"list_dir","args":{"path":"src"}} — inspect project structure (path optional, defaults to the project root)',
  '{"tool":"read_file","args":{"path":"src/App.jsx"}} — read a file\'s full contents',
  '{"tool":"search","args":{"query":"useState","isRegex":false}} — find text across the project',
  '{"tool":"write_file","args":{"path":"src/Login.jsx","content":"<COMPLETE file text>"}} — create or overwrite a file with its entire new contents',
  '{"tool":"create_file","args":{"path":"src/util/helper.js"}} — create an empty file (parent folders are made for you)',
  '{"tool":"create_folder","args":{"path":"src/components/layout"}} — create a folder, including any missing parents',
  '{"tool":"delete_path","args":{"path":"src/old"}} — delete a file or folder inside the project',
  '{"tool":"rename_path","args":{"path":"src/App.jsx","newName":"Main.jsx"}} — rename in place',
  '{"tool":"move_path","args":{"path":"src/Navbar.jsx","destDir":"src/components/layout"}} — move into another folder',
  '{"tool":"run_command","args":{"command":"npm install express"}} — run a real terminal command in the project and read its output',
  'Paths are relative to the opened project. Do NOT touch files outside it, and never read or overwrite secret/credential files such as .env, key pairs or token stores — those are blocked.',
  'For a build/test/install/lint/git command, run it, READ the output, and if it failed inspect the error, fix the relevant file(s) with write_file, then run it again. Retry a failing command at most twice; if it still fails, stop and explain what you tried and what remains.',
  'Normal work (editing code, creating folders/files, installing project dependencies, building, testing) needs NO confirmation — just do it. Only refuse genuinely dangerous system operations, which the app blocks anyway.',
  'When the task is finished, give a short summary of the concrete changes you made (files created/edited/removed, commands run and their results).',
];

/**
 * Chat system prompt.
 * @param {{mode:'agent'|'ask', level:string, activeFile?:{name:string,language:string,text?:string,selection?:string}, workspaceName?:string}} options
 */
export function buildChatSystemPrompt({ mode = 'ask', level = 'beginner', activeFile, workspaceName }) {
  const parts = [
    'You are NovaCode, a coding assistant built into a desktop IDE.',
    LEVEL_GUIDANCE[level] || LEVEL_GUIDANCE.beginner,
    ...QUALITY_RULES,
  ];

  if (mode === 'agent') {
    parts.push(
      'You are in Agent mode: you autonomously build across the WHOLE opened project, not just the file on screen.',
      'Start with a two or three line plan: what you understood, what you will change, and why it helps. Then act.',
      ...TOOL_PROTOCOL,
      'When you change a file, write its COMPLETE updated text with write_file so it can be diffed and undone; change only what the request needs and preserve everything else verbatim, including comments and blank lines.',
      'If the request is ambiguous, make the most reasonable choice and state the assumption in one line.',
    );
  } else {
    parts.push(
      'You are in Ask mode: answer questions about code and explain concepts.',
      'Keep prose under six sentences; show short focused snippets rather than whole files.',
      'You CANNOT run commands or modify files here — suggest the change for the user to apply, or tell them to switch to Agent mode to have you do it.',
      'Do not rewrite the file unless explicitly asked.',
    );
  }

  if (workspaceName) parts.push(`The user is working in the "${workspaceName}" workspace.`);
  if (activeFile) parts.push(`The active file is ${activeFile.name} (${activeFile.language}).`);

  // Give the model the ACTUAL open document so its edit is grounded in real
  // code, not a guess. Contents first, then any selected region, both bounded
  // so a huge file cannot blow the context window.
  if (activeFile && typeof activeFile.text === 'string' && activeFile.text.trim()) {
    parts.push(`Contents of the currently open file ${activeFile.name}:
\`\`\`
${clip(activeFile.text, 24000)}
\`\`\``);
  }
  if (activeFile && typeof activeFile.selection === 'string' && activeFile.selection.trim()) {
    parts.push(`The user has this code selected (focus your answer on it):
\`\`\`
${clip(activeFile.selection, 6000)}
\`\`\``);
  }
  return parts.join(' ');
}

/** Clip long context blocks so the prompt stays inside the token budget. */
function clip(text, max) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… (truncated, ${value.length - max} more chars)`;
}

const COMPLETION_GUARDRAILS = [
  'Continue the code at the cursor exactly where it stops.',
  'Output ONLY the continuation - no explanations, no markdown, no code fences, no comments about the task.',
  'Stop as soon as the immediate thought is complete; do not close the whole file.',
  'Never repeat text that already appears before the cursor.',
];

/**
 * Build the chat turns for a fill-in-the-middle style completion request.
 * Kept as messages (not a raw prompt) so every provider understands it.
 */
export function buildCompletionMessages({ language, path, prefix, suffix, tabSize }) {
  const before = String(prefix || '').slice(-6000);
  const after = String(suffix || '').slice(0, 2000);
  const indentHint = Number(tabSize) > 0 ? `${Number(tabSize)} spaces` : 'the file tabs';
  const system = [
    'You are an inline code completion engine inside an IDE.',
    ...COMPLETION_GUARDRAILS,
    ...QUALITY_RULES.slice(0, 4),
    `Language: ${language}. Indent with ${indentHint}.`,
  ].join(' ');

  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        path ? `File: ${path}` : null,
        `Code before cursor:\n${before}`,
        `Code after cursor:\n${after}`,
        'Continue:',
      ].filter(Boolean).join('\n\n'),
    },
  ];
}

/**
 * Turn a raw model completion into insertable text.
 * Strips fences/labels/prose preambles, trailing blank lines and length-bombs.
 */
export function cleanCompletion(raw, { maxChars = 900 } = {}) {
  let text = String(raw || '');
  if (!text.trim()) return '';
  // Drop a leading fence if the model ignored instructions.
  const fenced = /^```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/.exec(text.trim());
  if (fenced) text = fenced[1];
  text = text.replace(/^```[a-zA-Z0-9_+-]*\n?/, '').replace(/```$/, '');
  // Remove a leading label line such as "Here is the code:".
  text = text.replace(/^(?:sure|here(?:'s| is)|the code|output)\b[^\n]*\n/i, '');
  text = text.replace(/\s+$/, '');
  if (text.length > maxChars) {
    const cut = text.slice(0, maxChars);
    const lastLine = cut.lastIndexOf('\n');
    text = lastLine > maxChars * 0.4 ? cut.slice(0, lastLine) : cut;
  }
  return text;
}
