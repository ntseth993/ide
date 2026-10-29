/**
 * NovaDB parser tests — AST shapes and structural validation.
 */
import { describe, it, expect } from 'vitest';
import { parse, parseMany, NovaParseError } from '../../electron/services/novadb/parser';

describe('novadb parser — DDL', () => {
  it('parses CREATE DATABASE with IF NOT EXISTS', () => {
    expect(parse('CREATE DATABASE IF NOT EXISTS school')).toMatchObject({
      type: 'createDatabase', name: 'school', ifNotExists: true,
    });
  });

  it('parses CREATE TABLE columns with constraints', () => {
    const ast = parse('CREATE TABLE students (id INTEGER PRIMARY KEY, name TEXT NOT NULL, gpa REAL, active BOOLEAN DEFAULT TRUE)');
    expect(ast.type).toBe('createTable');
    expect(ast.columns).toHaveLength(4);
    expect(ast.columns[0]).toMatchObject({ name: 'id', dataType: 'INTEGER', primaryKey: true });
    expect(ast.columns[1]).toMatchObject({ name: 'name', dataType: 'TEXT', notNull: true });
    expect(ast.columns[2].dataType).toBe('REAL');
    expect(ast.columns[3]).toMatchObject({ name: 'active', dataType: 'BOOLEAN' });
    expect(ast.columns[3].defaultValue).toEqual({ expr: 'lit', value: true });
  });

  it('canonicalizes declared types (INT->INTEGER, VARCHAR(n)->TEXT)', () => {
    const ast = parse('CREATE TABLE t (a INT, b VARCHAR(255), c BOOL)');
    expect(ast.columns.map((x) => x.dataType)).toEqual(['INTEGER', 'TEXT', 'BOOLEAN']);
  });

  it('parses ALTER TABLE ADD / DROP COLUMN', () => {
    const add = parse('ALTER TABLE students ADD COLUMN email TEXT');
    expect(add).toMatchObject({ type: 'alterTable', name: 'students' });
    expect(add.actions[0]).toMatchObject({ action: 'add', column: { name: 'email', dataType: 'TEXT' } });
    const drop = parse('ALTER TABLE students DROP email');
    expect(drop.actions[0]).toMatchObject({ action: 'drop', columnName: 'email' });
  });

  it('parses CREATE INDEX ... ON table(cols) with UNIQUE', () => {
    const ast = parse('CREATE UNIQUE INDEX idx_email ON students (email)');
    expect(ast).toMatchObject({ type: 'createIndex', name: 'idx_email', table: 'students', columns: ['email'], unique: true });
  });
});

describe('novadb parser — DML', () => {
  it('parses SELECT * and a projection with an alias', () => {
    expect(parse('SELECT * FROM students').columns[0]).toEqual({ kind: 'star' });
    const ast = parse('SELECT name AS full_name FROM students');
    expect(ast.columns[0]).toMatchObject({ kind: 'expr', alias: 'full_name' });
  });

  it('parses aggregate select items', () => {
    const ast = parse('SELECT COUNT(*), AVG(gpa) AS avg_gpa FROM students');
    expect(ast.columns[0]).toMatchObject({ kind: 'agg', fn: 'COUNT', arg: { kind: 'star' } });
    expect(ast.columns[1]).toMatchObject({ kind: 'agg', fn: 'AVG', alias: 'avg_gpa' });
  });

  it('parses a WHERE tree with AND / OR and comparisons', () => {
    const ast = parse("SELECT * FROM t WHERE age >= 18 AND (name = 'Ann' OR score > 5)");
    expect(ast.where).toMatchObject({ expr: 'and' });
    expect(ast.where.left).toMatchObject({ expr: 'compare', op: '>=' });
    expect(ast.where.right.operand).toMatchObject({ expr: 'or' });
  });

  it('parses IS NULL, LIKE and IN predicates', () => {
    expect(parse('SELECT * FROM t WHERE a IS NULL').where).toMatchObject({ expr: 'isNull', negated: false });
    expect(parse('SELECT * FROM t WHERE a IS NOT NULL').where).toMatchObject({ expr: 'isNull', negated: true });
    expect(parse("SELECT * FROM t WHERE name LIKE 'A%'").where).toMatchObject({ expr: 'like' });
    expect(parse('SELECT * FROM t WHERE id IN (1, 2, 3)').where).toMatchObject({ expr: 'in', list: [{ expr: 'lit', value: 1 }, { expr: 'lit', value: 2 }, { expr: 'lit', value: 3 }] });
  });

  it('parses multi-row INSERT with parameters and reports paramCount', () => {
    const ast = parse('INSERT INTO students (name, age) VALUES (?, ?), (?, ?)');
    expect(ast.rows).toHaveLength(2);
    expect(ast.paramCount).toBe(4);
  });

  it('parses UPDATE SET and DELETE with WHERE, ORDER BY, LIMIT', () => {
    expect(parse('UPDATE t SET a = 1, b = 2 WHERE id = 3').assignments).toHaveLength(2);
    const sel = parse('SELECT * FROM t ORDER BY age DESC LIMIT 10 OFFSET 5');
    expect(sel.orderBy[0]).toMatchObject({ desc: true });
    expect(sel.limit).toEqual({ expr: 'lit', value: 10 });
    expect(sel.offset).toEqual({ expr: 'lit', value: 5 });
  });

  it('parses transaction statements', () => {
    expect(parse('BEGIN').type).toBe('begin');
    expect(parse('COMMIT').type).toBe('commit');
    expect(parse('ROLLBACK').type).toBe('rollback');
  });
});

describe('novadb parser — validation', () => {
  it('rejects an unknown statement', () => {
    expect(() => parse('VACUUM')).toThrow(NovaParseError);
  });

  it('rejects a column without a type', () => {
    expect(() => parse('CREATE TABLE t (name)')).toThrow(/type/);
  });

  it('rejects trailing garbage after a statement', () => {
    expect(() => parse('SELECT 1 oops oops')).toThrow();
  });

  it('parseMany splits a ;-separated batch', () => {
    const statements = parseMany('CREATE DATABASE d; USE d; SELECT * FROM t;');
    expect(statements.map((s) => s.type)).toEqual(['createDatabase', 'use', 'select']);
  });
});

describe('novadb parser — relationships, joins, grouping', () => {
  it('parses a column-level REFERENCES into an fk descriptor', () => {
    const ast = parse('CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id))');
    expect(ast.columns[1]).toMatchObject({ name: 'user_id', fk: { table: 'users', column: 'id' } });
  });

  it('parses a table-level FOREIGN KEY constraint', () => {
    const ast = parse('CREATE TABLE orders (id INTEGER, uid INTEGER, FOREIGN KEY (uid) REFERENCES users(id))');
    expect(ast.foreignKeys).toEqual([{ columns: ['uid'], refTable: 'users', refColumn: 'id' }]);
  });

  it('keeps the table qualifier on dotted column references', () => {
    const ast = parse('SELECT s.name FROM students s');
    expect(ast.columns[0].expr).toMatchObject({ expr: 'column', name: 'name', table: 's' });
    expect(ast.table).toBe('students');
    expect(ast.tableAlias).toBe('s');
  });

  it('parses INNER and LEFT JOIN with an ON predicate', () => {
    const ast = parse('SELECT * FROM a JOIN b ON a.id = b.a_id LEFT JOIN c ON c.id = b.id');
    expect(ast.joins).toHaveLength(2);
    expect(ast.joins[0]).toMatchObject({ type: 'inner', table: 'b', alias: 'b' });
    expect(ast.joins[1]).toMatchObject({ type: 'left', table: 'c' });
    expect(ast.joins[0].on).toMatchObject({ expr: 'compare', op: '=' });
  });

  it('parses GROUP BY with one or more expressions', () => {
    const ast = parse('SELECT homeroom, COUNT(*) FROM students GROUP BY homeroom');
    expect(ast.groupBy).toHaveLength(1);
    expect(ast.groupBy[0]).toMatchObject({ expr: 'column', name: 'homeroom' });
  });
});
