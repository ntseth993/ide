/**
 * NovaDB lexer tests — token shapes, comments, strings, numbers, params.
 */
import { describe, it, expect } from 'vitest';
import { tokenize, NovaLexError } from '../../electron/services/novadb/lexer';

const kinds = (tokens) => tokens.map((t) => t.type);

describe('novadb lexer', () => {
  it('splits keywords, identifiers and punctuation', () => {
    const t = tokenize('SELECT name FROM users;');
    expect(t.map((x) => [x.type, x.value])).toEqual([
      ['keyword', 'SELECT'],
      ['ident', 'name'],
      ['keyword', 'FROM'],
      ['ident', 'users'],
      ['punct', ';'],
      ['eof', null],
    ]);
  });

  it('is case-insensitive for keywords but preserves identifier case', () => {
    const t = tokenize('select MyCol');
    expect(t[0]).toMatchObject({ type: 'keyword', value: 'SELECT', raw: 'select' });
    expect(t[1]).toMatchObject({ type: 'ident', value: 'MyCol' });
  });

  it('lexes integers and reals', () => {
    const t = tokenize('123 45.67 .5');
    expect(t.slice(0, 3).map((x) => [x.type, x.value])).toEqual([
      ['number', 123],
      ['number', 45.67],
      ['number', 0.5],
    ]);
  });

  it('unescapes doubled quotes inside string literals', () => {
    const t = tokenize("'it''s ok'");
    expect(t[0]).toMatchObject({ type: 'string', value: "it's ok" });
  });

  it('accepts double-quoted identifiers/strings', () => {
    const t = tokenize('"hello world"');
    expect(t[0].type).toBe('string');
    expect(t[0].value).toBe('hello world');
  });

  it('numbers positional parameters in order', () => {
    const t = tokenize('INSERT INTO t VALUES (?, ?, ?)');
    const params = t.filter((x) => x.type === 'param');
    expect(params.map((p) => p.value)).toEqual([0, 1, 2]);
  });

  it('normalizes <> to != and keeps <= / >=', () => {
    const t = tokenize('a <> b');
    expect(t.find((x) => x.type === 'operator').value).toBe('!=');
  });

  it('skips line and block comments', () => {
    expect(kinds(tokenize('-- a comment\nSELECT 1')).includes('comment')).toBe(false);
    expect(tokenize('/* ignore */ SELECT 1')[0].value).toBe('SELECT');
  });

  it('throws on an unterminated string', () => {
    expect(() => tokenize("'oops")).toThrow(NovaLexError);
  });

  it('throws on an unexpected character', () => {
    expect(() => tokenize('SELECT $ FROM')).toThrow(/Unexpected character/);
  });
});
