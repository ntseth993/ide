'use strict';
/**
 * NovaDB — SQL-like lexer (tokenizer).
 *
 * Stage 1 of the independent NovaDB engine. This turns a NovaDB statement
 * string into a flat array of typed tokens that the parser (parser.js) turns
 * into an AST. It is intentionally dependency-free and side-effect-free so it
 * can be unit tested in isolation, and it never evaluates input: there is no
 * `eval`, no `Function`, and no interpretation of the text beyond token shapes.
 *
 * Token kinds:
 *   keyword  a reserved word (upper-cased in `value`, original text in `raw`)
 *   ident    an identifier: db / table / column name (case preserved in `raw`)
 *   string   a single- or double-quoted literal (unescaped value in `value`)
 *   number   an integer or decimal literal (numeric value in `value`)
 *   param    a `?` positional parameter placeholder (index in `value`)
 *   punct    structural punctuation: ( ) , ; .
 *   operator = != <> < > <= >=
 *   eof      end of input sentinel
 */

// Reserved words. Matching is case-insensitive; identifiers that collide with a
// keyword must be quoted, exactly like a real SQL engine.
const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET',
  'DELETE', 'CREATE', 'DROP', 'ALTER', 'TABLE', 'TABLES', 'DATABASE',
  'DATABASES', 'SHOW', 'USE', 'DESCRIBE', 'DESC', 'INDEX', 'ADD', 'COLUMN',
  'PRIMARY', 'KEY', 'UNIQUE', 'NOT', 'NULL', 'DEFAULT', 'IF', 'EXISTS',
  'AND', 'OR', 'ORDER', 'BY', 'ASC', 'LIMIT', 'OFFSET', 'AS', 'DISTINCT',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION', 'IS', 'LIKE', 'IN',
  'TRUE', 'FALSE',
  // Relationships & grouping (Stage 3)
  'FOREIGN', 'REFERENCES', 'JOIN', 'INNER', 'LEFT', 'GROUP',
  // Types
  'INTEGER', 'INT', 'REAL', 'FLOAT', 'DOUBLE', 'TEXT', 'VARCHAR', 'BOOLEAN', 'BOOL',
  // Aggregates
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
]);

const isDigit = (c) => c >= '0' && c <= '9';
const isIdentStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c) => isIdentStart(c) || isDigit(c);

/** A parse-time error carrying the offending offset for good messages. */
class NovaLexError extends Error {
  constructor(message, index) {
    super(message);
    this.name = 'NovaLexError';
    this.index = index;
  }
}

/**
 * Tokenize a single NovaDB statement.
 * @param {string} sql
 * @returns {Array<{type:string,value:any,raw:string,index:number}>}
 */
function tokenize(sql) {
  const src = String(sql == null ? '' : sql);
  const tokens = [];
  let i = 0;
  let paramIndex = 0;

  const push = (type, value, raw, index) => tokens.push({ type, value, raw, index });

  while (i < src.length) {
    const c = src[i];

    // whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i += 1; continue; }

    // line comment: -- to end of line
    if (c === '-' && src[i + 1] === '-') {
      i += 2;
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    // block comment: /* ... */
    if (c === '/' && src[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      if (i >= src.length) throw new NovaLexError('Unterminated block comment', start);
      i += 2;
      continue;
    }

    // string literal: single-quoted ('' escapes a quote) or double-quoted
    if (c === "'" || c === '"') {
      const quote = c;
      const start = i;
      i += 1;
      let out = '';
      let closed = false;
      while (i < src.length) {
        if (src[i] === quote) {
          if (src[i + 1] === quote) { out += quote; i += 2; continue; } // '' -> '
          i += 1; closed = true; break;
        }
        out += src[i]; i += 1;
      }
      if (!closed) throw new NovaLexError('Unterminated string literal', start);
      push('string', out, src.slice(start, i), start);
      continue;
    }

    // number literal: 123, 123.45 (.45 supported)
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      const start = i;
      let num = '';
      while (i < src.length && isDigit(src[i])) { num += src[i]; i += 1; }
      if (src[i] === '.') {
        num += '.'; i += 1;
        while (i < src.length && isDigit(src[i])) { num += src[i]; i += 1; }
      }
      if (i < src.length && (src[i] === 'e' || src[i] === 'E')) {
        throw new NovaLexError('Exponent notation is not supported', start);
      }
      push('number', Number(num), num, start);
      continue;
    }

    // identifier or keyword
    if (isIdentStart(c)) {
      const start = i;
      let raw = '';
      while (i < src.length && isIdentPart(src[i])) { raw += src[i]; i += 1; }
      const upper = raw.toUpperCase();
      if (KEYWORDS.has(upper)) push('keyword', upper, raw, start);
      else push('ident', raw, raw, start);
      continue;
    }

    // positional parameter
    if (c === '?') {
      push('param', paramIndex, '?', i);
      paramIndex += 1; i += 1;
      continue;
    }

    // two-character operators
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '!=' || two === '<>') {
      push('operator', two === '<>' ? '!=' : two, two, i);
      i += 2; continue;
    }

    // single-character operators
    if (c === '=' || c === '<' || c === '>') {
      push('operator', c, c, i); i += 1; continue;
    }

    // punctuation
    if (c === '(' || c === ')' || c === ',' || c === ';' || c === '.') {
      push('punct', c, c, i); i += 1; continue;
    }

    // star (used in SELECT * and COUNT(*)) — treated as punctuation for the parser
    if (c === '*') {
      push('punct', '*', '*', i); i += 1; continue;
    }

    throw new NovaLexError(`Unexpected character '${c}'`, i);
  }

  push('eof', null, '', src.length);
  return tokens;
}

module.exports = { tokenize, KEYWORDS, NovaLexError };
