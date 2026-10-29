import { describe, expect, it } from 'vitest';
import {
  QUALITY_RULES,
  buildChatSystemPrompt,
  buildCompletionMessages,
  cleanCompletion,
} from '../src/services/aiPrompts';

describe('aiPrompts — chat policy', () => {
  it('always carries the quality bar into chat', () => {
    const prompt = buildChatSystemPrompt({ mode: 'ask', level: 'advanced' });
    for (const rule of QUALITY_RULES) {
      expect(prompt).toContain(rule);
    }
  });

  it('makes Agent mode teach the provider-agnostic tool protocol', () => {
    const prompt = buildChatSystemPrompt({
      mode: 'agent',
      level: 'beginner',
      activeFile: { name: 'app.js', language: 'javascript' },
      workspaceName: 'demo',
    });
    expect(prompt).toContain('Agent mode');
    // The three core tools and the fenced-block protocol are all described.
    expect(prompt).toContain('novacode-tool');
    expect(prompt).toContain('run_command');
    expect(prompt).toContain('read_file');
    expect(prompt).toContain('write_file');
    // run_command is gated behind the user's approval.
    expect(prompt).toMatch(/run_command asks the user to approve/i);
    // Editing still funnels through a complete file the user can review.
    expect(prompt).toContain('COMPLETE updated file');
    expect(prompt).toContain('preserve everything else verbatim');
    expect(prompt).toContain('app.js');
    expect(prompt).toContain('"demo" workspace');
  });

  it('keeps Ask mode explanatory, non-destructive and tool-free', () => {
    const prompt = buildChatSystemPrompt({ mode: 'ask' });
    expect(prompt).toContain('Ask mode');
    expect(prompt).toContain('Do not rewrite the file unless explicitly asked.');
    expect(prompt).not.toContain('Agent mode');
    expect(prompt).not.toContain('novacode-tool');
  });

  it('falls back to a safe mode/level when callers omit them', () => {
    expect(buildChatSystemPrompt({})).toContain('Ask mode');
    expect(buildChatSystemPrompt({ level: 'guru' })).toContain('Assume the reader is new');
  });
});

describe('aiPrompts — inline completions', () => {
  it('sends the context window around the cursor as chat turns', () => {
    const messages = buildCompletionMessages({
      language: 'python',
      path: 'C:/w/app.py',
      prefix: 'def sum_values(nums):\n    total = 0',
      suffix: '\n\nprint(sum_values([1]))',
      tabSize: 4,
    });
    expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(messages[0].content).toContain('inline code completion engine');
    expect(messages[0].content).toContain('Output ONLY the continuation');
    expect(messages[0].content).toContain('Language: python');
    expect(messages[0].content).toContain('4 spaces');
    expect(messages[1].content).toContain('File: C:/w/app.py');
    expect(messages[1].content).toContain('total = 0');
    expect(messages[1].content).toContain('Continue:');
  });

  it('bounds the context so a big file cannot blow up the request', () => {
    const messages = buildCompletionMessages({
      language: 'javascript',
      prefix: 'a'.repeat(20000),
      suffix: 'b'.repeat(20000),
    });
    expect(messages[1].content).toContain('a'.repeat(6000));
    expect(messages[1].content).not.toContain('a'.repeat(6001));
    expect(messages[1].content).toContain('b'.repeat(2000));
    expect(messages[1].content).not.toContain('b'.repeat(2001));
  });
});

describe('aiPrompts — cleaning a completion', () => {
  it('accepts plain continuation as-is', () => {
    expect(cleanCompletion('    return total\n')).toBe('    return total');
  });

  it('strips markdown fences the model added anyway', () => {
    expect(cleanCompletion('```js\nconst a = 1;\n```')).toBe('const a = 1;');
  });

  it('drops a prose preamble line', () => {
    expect(cleanCompletion("Here's the code:\nconst a = 1;")).toBe('const a = 1;');
  });

  it('cuts long answers on a line boundary', () => {
    const text = cleanCompletion(`${'x'.repeat(400)}\n${'y'.repeat(400)}\n${'z'.repeat(400)}`, { maxChars: 900 });
    expect(text.length).toBeLessThanOrEqual(900);
    expect(text).not.toContain('z');
  });

  it('returns an empty string for nothing useful', () => {
    expect(cleanCompletion('')).toBe('');
    expect(cleanCompletion(null)).toBe('');
    expect(cleanCompletion('   \n ')).toBe('');
  });
});
