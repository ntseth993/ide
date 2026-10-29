/**
 * AI inline completions (ghost text, Tab to accept).
 *
 * Registers a Monaco InlineCompletionsProvider for the languages NovaCode
 * supports. While the user types, the text before/after the cursor is sent to
 * the main process (which owns the API key and the account budget), and the
 * reply is rendered as ghost text at the caret — Tab commits it, Escape or
 * typing on dismisses it. Nothing is ever inserted without an explicit accept.
 *
 * Guard rails:
 *   - requires the setting enabled AND a signed-in account (AI is a member
 *     feature; the main process enforces the same gate, this just avoids
 *     pointless network calls);
 *   - at most one request in flight per view — stale replies are dropped;
 *   - a short debounce so we only ask once typing pauses, not on every key;
 *   - bounded context (3k chars before / 1k after) keeps latency and cost low.
 */
import { client } from './novaClient';
import { buildCompletionMessages, cleanCompletion } from './aiPrompts';

const SUPPORTED_LANGUAGES = [
  'javascript', 'typescript', 'python', 'html', 'css', 'scss', 'less',
  'json', 'markdown', 'shell', 'yaml', 'go', 'sql', 'java', 'c', 'cpp',
  'csharp', 'php', 'ruby', 'rust',
];

const MIN_CONTEXT_CHARS = 12;
// How long typing must pause before we spend a request — Monaco re-invokes the
// provider (and cancels the previous call) on every keystroke, so only the last
// invocation clears this window and actually hits the network.
const DEBOUNCE_MS = 180;
// Bigger prompts mean slower, pricier round-trips; the model rarely needs more
// than this to complete the current line/block.
const PREFIX_CHARS = 3000;
const SUFFIX_CHARS = 1000;
const MAX_TOKENS = 160;

// A "break point" is anywhere a suggestion reads naturally: after whitespace,
// punctuation or an operator.
const BREAK_POINT = /[\s{}()[\];,.:=><+\-*/&|^!?~'"`\\]$/;
const WORD_TAIL = /[\w$]+$/;

/** Resolve true if the token is cancelled before `ms` elapses, else false. */
function waitOrCancel(ms, token) {
  return new Promise((resolve) => {
    if (token?.isCancellationRequested) { resolve(true); return; }
    let settled = false;
    const finish = (canceled) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { listener?.dispose?.(); } catch { /* event already gone */ }
      resolve(canceled);
    };
    const timer = setTimeout(() => finish(false), ms);
    const listener = token?.onCancellationRequested?.(() => finish(true));
  });
}

/**
 * Decide whether a caret position is worth asking the model about. Mid-word
 * requests are noisy, so they need a slightly longer identifier first.
 */
export function shouldRequestCompletion(prefix) {
  const before = String(prefix || '');
  if (before.trim().length < MIN_CONTEXT_CHARS) return false;
  if (BREAK_POINT.test(before)) return true;
  const word = WORD_TAIL.exec(before.slice(-24));
  return Boolean(word) && word[0].length >= 3;
}

/**
 * @param {object} options
 * @param {object} options.monaco Monaco API surface (from the mounted editor).
 * @param {() => object} options.getConfig Latest settings/account as a plain object.
 * @param {(status: string, detail?: string) => void} [options.onStatus] 'idle'|'working'|'off'|'error'
 * @returns {{ dispose: () => void }}
 */
export function registerInlineAI({ monaco, getConfig, onStatus }) {
  if (!monaco || typeof monaco.languages?.registerInlineCompletionsProvider !== 'function') {
    return { dispose() {} };
  }
  let seq = 0;
  const report = (status, detail) => { try { onStatus?.(status, detail); } catch { /* UI only */ } };

  const provider = {
    async provideInlineCompletions(model, position, _context, token) {
      const config = getConfig?.() || {};
      if (!config.enabled || !config.signedIn) {
        report('off');
        return { items: [] };
      }
      // Serialize AI usage: never fire an inline completion while a chat turn is
      // streaming — one request at a time, so the assistant finishes first.
      if (config.chatBusy) {
        report('idle');
        return { items: [] };
      }

      const fullText = model.getValue();
      const offset = model.getOffsetAt(position);
      const prefix = fullText.slice(Math.max(0, offset - PREFIX_CHARS), offset);
      const suffix = fullText.slice(offset, offset + SUFFIX_CHARS);
      if (!shouldRequestCompletion(prefix)) {
        report('idle');
        return { items: [] };
      }

      const requestId = ++seq;
      // Wait for a brief pause; if the user keeps typing (Monaco cancels this
      // call) or a newer position arrives, abandon before spending a request.
      const canceled = await waitOrCancel(DEBOUNCE_MS, token);
      if (canceled || token.isCancellationRequested || requestId !== seq) {
        return { items: [] };
      }

      report('working');
      const languageId = model.getLanguageId?.() || 'plaintext';
      let result;
      try {
        result = await client.aiComplete({
          messages: buildCompletionMessages({
            language: languageId,
            path: config.path,
            prefix,
            suffix,
            tabSize: config.tabSize,
          }),
          provider: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
          // Completions want determinism and speed, not creativity.
          temperature: 0,
          maxTokens: MAX_TOKENS,
        });
      } catch (error) {
        if (requestId === seq) report('error', error?.message);
        return { items: [] };
      }

      // A newer keystroke (or a cancel) won the race: throw this away.
      if (token.isCancellationRequested || requestId !== seq) {
        return { items: [] };
      }

      const text = cleanCompletion(result?.text);
      if (!text || prefix.endsWith(text)) {
        report('idle');
        return { items: [] };
      }
      report('ready');
      return {
        items: [{
          insertText: text,
          range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
        }],
      };
    },
  };

  const disposables = SUPPORTED_LANGUAGES.map((languageId) => (
    monaco.languages.registerInlineCompletionsProvider(languageId, provider)
  ));

  return {
    dispose() {
      seq += 1; // Invalidate anything still in flight.
      for (const disposable of disposables) disposable.dispose();
    },
  };
}

export { SUPPORTED_LANGUAGES as INLINE_COMPLETION_LANGUAGES };
