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

// A provider-agnostic tool protocol. Any chat model can follow it because it
// is plain text in a fenced block, not native function-calling, so Agent mode
// works identically across OpenAI, Anthropic, Gemini, Groq, OpenRouter and
// Ollama. The renderer parses these blocks, runs them, and feeds results back.
const TOOL_PROTOCOL = [
  'You can act on the workspace with tools. To use one, emit a fenced block tagged novacode-tool containing exactly one JSON object, then STOP and wait for the result before continuing. Never invent tool output.',
  'Available tools and their JSON shape:',
  '{"tool":"run_command","args":{"command":"<shell command>","cwd":"<optional folder>"}}',
  '{"tool":"read_file","args":{"path":"<relative/file/path>"}}',
  '{"tool":"write_file","args":{"path":"<relative/file/path>","content":"<full new file text>"}}',
  'Emit one block per tool call; you may emit several in one message to do independent work at once.',
  'run_command asks the user to approve before it runs; read_file and write_file run automatically. write_file is offered as a diff the user must accept.',
  'Use tools only when they genuinely move the task forward (run tests, read a file you need, apply an edit). When the task is done, give the final answer without any novacode-tool block.',
];

/**
 * Chat system prompt.
 * @param {{mode:'agent'|'ask', level:string, activeFile?:{name:string,language:string}, workspaceName?:string}} options
 */
export function buildChatSystemPrompt({ mode = 'ask', level = 'beginner', activeFile, workspaceName }) {
  const parts = [
    'You are NovaCode, a coding assistant built into a desktop IDE.',
    LEVEL_GUIDANCE[level] || LEVEL_GUIDANCE.beginner,
    ...QUALITY_RULES,
  ];

  if (mode === 'agent') {
    parts.push(
      'You are in Agent mode: act autonomously on the open project.',
      'Start with a two or three line plan.',
      ...TOOL_PROTOCOL,
      'To change the open file, prefer the write_file tool with the COMPLETE updated file so it can be reviewed as a diff; alternatively return the complete updated file in one fenced code block tagged with its language.',
      'Change only what the request needs; preserve everything else verbatim, including comments and blank lines.',
      'If the request is ambiguous, make the most reasonable choice, apply it, and state the assumption in one line.',
    );
  } else {
    parts.push(
      'You are in Ask mode: answer questions about code.',
      'Keep prose under six sentences; show short focused snippets rather than whole files.',
      'Do not rewrite the file unless explicitly asked.',
    );
  }

  if (workspaceName) parts.push(`The user is working in the "${workspaceName}" workspace.`);
  if (activeFile) parts.push(`The active file is ${activeFile.name} (${activeFile.language}).`);
  return parts.join(' ');
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
