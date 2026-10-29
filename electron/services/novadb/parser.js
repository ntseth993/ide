'use strict';
/**
 * NovaDB — parser (tokens -> AST).
 *
 * A hand-written recursive-descent parser over lexer.js tokens. It produces a
 * plain-data AST that engine.js executes. The parser performs structural
 * validation only (correct keywords, balanced clauses, known shapes); it never
 * touches data, the filesystem, or the network, and it never evaluates input.
 *
 * Every node carries a lowercase `type`. Positional parameters (`?`) are
 * preserved as { expr:'param', index } and the total count is reported as
 * `paramCount` on the statement so the engine can validate bindings.
 *
 * Supported statements (Stage 1 + relational Stage 3):
 *   CREATE/DROP DATABASE, SHOW DATABASES, USE,
 *   CREATE/DROP/ALTER TABLE (incl. FOREIGN KEY ... REFERENCES), SHOW TABLES,
 *   DESCRIBE, CREATE INDEX, INSERT,
 *   SELECT (WHERE/AND/OR/NOT/IS NULL/LIKE/IN, [INNER|LEFT] JOIN ... ON,
 *   GROUP BY, ORDER BY/LIMIT/OFFSET/DISTINCT, COUNT/SUM/AVG/MIN/MAX),
 *   UPDATE, DELETE, BEGIN/COMMIT/ROLLBACK.
 */
const { tokenize } = require('./lexer');

class NovaParseError extends Error {
  constructor(message, token) {
    const where = token ? ` at '${token.raw || token.type}' (col ${token.index + 1})` : '';
    super(`NovaDB parse error${where}: ${message}`);
    this.name = 'NovaParseError';
  }
}

const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
const DATA_TYPES = new Set(['INTEGER', 'INT', 'REAL', 'FLOAT', 'DOUBLE', 'TEXT', 'VARCHAR', 'BOOLEAN', 'BOOL']);
const TYPE_CANON = { INT: 'INTEGER', FLOAT: 'REAL', DOUBLE: 'REAL', VARCHAR: 'TEXT', BOOL: 'BOOLEAN' };

/** Parse one statement (a trailing `;` is allowed). */
function parse(sql) {
  const parser = new Parser(tokenize(sql));
  const statement = parser.parseStatement();
  parser.consumeOptionalSemicolon();
  parser.expectEof();
  statement.paramCount = parser.paramCount;
  return statement;
}

/** Parse a `;`-separated batch into an array of statements. */
function parseMany(sql) {
  const parser = new Parser(tokenize(sql));
  const out = [];
  for (;;) {
    const before = parser.paramCount;
    parser.consumeOptionalSemicolon();
    if (parser.atEnd()) break;
    const statement = parser.parseStatement();
    statement.paramCount = parser.paramCount - before;
    out.push(statement);
  }
  if (!out.length) throw new NovaParseError('empty statement', null);
  return out;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
    this.paramCount = 0;
  }

  // --- token cursor -------------------------------------------------------
  peek(offset = 0) { return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]; }
  atEnd() { return this.peek().type === 'eof'; }

  next() {
    const token = this.tokens[this.pos];
    if (token.type !== 'eof') this.pos += 1;
    return token;
  }

  check(type, value) {
    const t = this.peek();
    if (t.type !== type) return false;
    if (value === undefined) return true;
    return Array.isArray(value) ? value.includes(t.value) : t.value === value;
  }

  match(type, value) {
    if (this.check(type, value)) { this.next(); return true; }
    return false;
  }

  // Match a bare word that may be lexed as either a keyword or an identifier
  // (used for context-sensitive words like `ON` that are not reserved).
  matchWord(word) {
    const t = this.peek();
    if ((t.type === 'keyword' || t.type === 'ident') && String(t.value).toLowerCase() === word) {
      this.next(); return true;
    }
    return false;
  }

  expectKeyword(value) {
    if (!this.match('keyword', value)) {
      throw new NovaParseError(`expected keyword ${Array.isArray(value) ? value.join('/') : value}`, this.peek());
    }
  }

  expectPunct(value) {
    if (!this.match('punct', value)) {
      throw new NovaParseError(`expected '${value}'`, this.peek());
    }
  }

  consumeOptionalSemicolon() { while (this.match('punct', ';')) { /* tolerate extras */ } }
  expectEof() { if (!this.atEnd()) throw new NovaParseError('unexpected trailing input', this.peek()); }

  // A plain identifier; quoted strings are accepted as identifiers too.
  identifier() {
    const t = this.peek();
    if (t.type === 'ident' || t.type === 'string') { this.next(); return t.value; }
    throw new NovaParseError('expected an identifier', t);
  }

  // Possibly dotted name (table.col). Returns the final segment as the name
  // and records whether it was qualified.
  qualifiedName() {
    let name = this.identifier();
    while (this.check('punct', '.')) {
      this.next();
      name = this.identifier();
    }
    return name;
  }

  // --- statement dispatch -------------------------------------------------
  parseStatement() {
    const t = this.peek();
    if (t.type !== 'keyword' && t.type !== 'ident') {
      throw new NovaParseError('expected a statement', t);
    }
    switch (t.value) {
      case 'CREATE': return this.parseCreate();
      case 'DROP': return this.parseDrop();
      case 'ALTER': return this.parseAlterTable();
      case 'SHOW': return this.parseShow();
      case 'USE': return this.parseUse();
      case 'DESCRIBE': this.next(); return { type: 'describe', name: this.identifier() };
      case 'INSERT': return this.parseInsert();
      case 'SELECT': return this.parseSelect();
      case 'UPDATE': return this.parseUpdate();
      case 'DELETE': return this.parseDelete();
      case 'BEGIN': this.next(); this.match('keyword', 'TRANSACTION'); return { type: 'begin' };
      case 'COMMIT': this.next(); this.match('keyword', 'TRANSACTION'); return { type: 'commit' };
      case 'ROLLBACK': this.next(); this.match('keyword', 'TRANSACTION'); return { type: 'rollback' };
      default: throw new NovaParseError('unsupported statement', t);
    }
  }

  parseIfNotExists() {
    if (this.check('keyword', 'IF') && this.peek(1).value === 'NOT' && this.peek(2).value === 'EXISTS') {
      this.next(); this.next(); this.next();
      return true;
    }
    return false;
  }

  parseIfExists() {
    if (this.check('keyword', 'IF') && this.peek(1).value === 'EXISTS') {
      this.next(); this.next();
      return true;
    }
    return false;
  }

  parseCreate() {
    this.expectKeyword('CREATE');
    if (this.check('keyword', 'DATABASE')) {
      this.next();
      const ifNotExists = this.parseIfNotExists();
      return { type: 'createDatabase', name: this.identifier(), ifNotExists };
    }
    if (this.check('keyword', 'TABLE')) {
      this.next();
      const ifNotExists = this.parseIfNotExists();
      const name = this.identifier();
      this.expectPunct('(');
      const { columns, foreignKeys } = this.parseColumnDefList();
      this.expectPunct(')');
      return { type: 'createTable', name, ifNotExists, columns, foreignKeys };
    }
    if (this.check('keyword', 'UNIQUE') || this.check('keyword', 'INDEX')) {
      const unique = this.match('keyword', 'UNIQUE');
      this.expectKeyword('INDEX');
      const ifNotExists = this.parseIfNotExists();
      const name = this.identifier();
      // `ON` is context-sensitive (not reserved) — accept it as a bare word.
      if (!this.matchWord('on')) throw new NovaParseError("expected 'ON' after CREATE INDEX name", this.peek());
      const table = this.identifier();
      this.expectPunct('(');
      const columns = [this.identifier()];
      while (this.match('punct', ',')) columns.push(this.identifier());
      this.expectPunct(')');
      return { type: 'createIndex', name, table, columns, unique, ifNotExists };
    }
    throw new NovaParseError('expected DATABASE, TABLE or INDEX after CREATE', this.peek());
  }

  parseColumnDefList() {
    const columns = [];
    const foreignKeys = [];
    for (;;) {
      // A table-level constraint is distinguishable by its leading keyword.
      if (this.check('keyword', 'FOREIGN')) {
        this.next();
        this.expectKeyword('KEY');
        this.expectPunct('(');
        const cols = [this.identifier()];
        while (this.match('punct', ',')) cols.push(this.identifier());
        this.expectPunct(')');
        this.expectKeyword('REFERENCES');
        const ref = this.parseFkTarget();
        foreignKeys.push({ columns: cols, refTable: ref.table, refColumn: ref.column });
      } else {
        columns.push(this.parseColumnDef());
      }
      if (!this.match('punct', ',')) break;
    }
    return { columns, foreignKeys };
  }

  // `parent_table[(parent_column)]` — the referenced side of a foreign key.
  parseFkTarget() {
    const table = this.identifier();
    let column = null;
    if (this.match('punct', '(')) {
      column = this.identifier();
      this.expectPunct(')');
    }
    return { table, column };
  }

  parseColumnDef() {
    const name = this.identifier();
    const dataType = this.parseDataType();
    const column = { name, dataType, primaryKey: false, notNull: false, unique: false, defaultValue: undefined, autoIncrement: false, fk: null };
    for (;;) {
      if (this.check('keyword', 'PRIMARY') && this.peek(1).value === 'KEY') {
        this.next(); this.next(); column.primaryKey = true; column.notNull = true;
      } else if (this.match('keyword', 'AUTOINCREMENT')) {
        column.autoIncrement = true;
      } else if (this.check('keyword', 'NOT') && this.peek(1).value === 'NULL') {
        this.next(); this.next(); column.notNull = true;
      } else if (this.match('keyword', 'UNIQUE')) {
        column.unique = true;
      } else if (this.match('keyword', 'DEFAULT')) {
        column.defaultValue = this.parseValue();
      } else if (this.match('keyword', 'REFERENCES')) {
        // Column-level foreign key: `col INTEGER REFERENCES users(id)`.
        const ref = this.parseFkTarget();
        column.fk = { table: ref.table, column: ref.column };
      } else {
        break;
      }
    }
    return column;
  }

  parseDataType() {
    const t = this.peek();
    if (t.type === 'keyword' && DATA_TYPES.has(t.value)) {
      this.next();
      // consume an optional size like VARCHAR(255)
      if (this.check('punct', '(')) { this.next(); if (this.peek().type === 'number') this.next(); this.expectPunct(')'); }
      return TYPE_CANON[t.value] || t.value;
    }
    throw new NovaParseError('expected a column type (INTEGER/REAL/TEXT/BOOLEAN)', t);
  }

  parseDrop() {
    this.expectKeyword('DROP');
    if (this.match('keyword', 'DATABASE')) {
      const ifExists = this.parseIfExists();
      return { type: 'dropDatabase', name: this.identifier(), ifExists };
    }
    if (this.match('keyword', 'TABLE')) {
      const ifExists = this.parseIfExists();
      return { type: 'dropTable', name: this.identifier(), ifExists };
    }
    if (this.match('keyword', 'INDEX')) {
      const ifExists = this.parseIfExists();
      return { type: 'dropIndex', name: this.identifier(), ifExists };
    }
    throw new NovaParseError('expected DATABASE, TABLE or INDEX after DROP', this.peek());
  }

  parseAlterTable() {
    this.expectKeyword('ALTER');
    this.expectKeyword('TABLE');
    const name = this.identifier();
    const actions = [];
    for (;;) {
      if (this.match('keyword', 'ADD')) {
        this.match('keyword', 'COLUMN');
        actions.push({ action: 'add', column: this.parseColumnDef() });
      } else if (this.match('keyword', 'DROP')) {
        this.match('keyword', 'COLUMN');
        actions.push({ action: 'drop', columnName: this.identifier() });
      } else {
        throw new NovaParseError('expected ADD or DROP after ALTER TABLE', this.peek());
      }
      if (!this.match('punct', ',')) break;
    }
    return { type: 'alterTable', name, actions };
  }

  parseShow() {
    this.expectKeyword('SHOW');
    if (this.match('keyword', 'DATABASES')) return { type: 'showDatabases' };
    if (this.match('keyword', 'TABLES')) return { type: 'showTables' };
    throw new NovaParseError('expected DATABASES or TABLES after SHOW', this.peek());
  }

  parseUse() {
    this.expectKeyword('USE');
    return { type: 'use', name: this.identifier() };
  }

  parseInsert() {
    this.expectKeyword('INSERT');
    this.match('keyword', 'INTO');
    const table = this.identifier();
    let columns = null;
    if (this.match('punct', '(')) {
      columns = [this.identifier()];
      while (this.match('punct', ',')) columns.push(this.identifier());
      this.expectPunct(')');
    }
    this.expectKeyword('VALUES');
    const rows = [];
    for (;;) {
      this.expectPunct('(');
      const values = [this.parseValue()];
      while (this.match('punct', ',')) values.push(this.parseValue());
      this.expectPunct(')');
      rows.push(values);
      if (!this.match('punct', ',')) break;
    }
    return { type: 'insert', table, columns, rows };
  }

  parseSelect() {
    this.expectKeyword('SELECT');
    const distinct = this.match('keyword', 'DISTINCT');
    const columns = this.parseSelectItems();
    let table = null;
    let tableAlias = null;
    const joins = [];
    if (this.match('keyword', 'FROM')) {
      const ref = this.parseTableRef();
      table = ref.table;
      tableAlias = ref.alias;
      // Zero or more `[INNER|LEFT] JOIN <table> ON <expr>` clauses.
      for (;;) {
        let joinType = 'inner';
        if (this.check('keyword', 'LEFT')) { joinType = 'left'; this.next(); }
        else if (this.check('keyword', 'INNER')) { this.next(); }
        if (!this.match('keyword', 'JOIN')) break;
        const right = this.parseTableRef();
        if (!this.matchWord('on')) throw new NovaParseError("expected 'ON' after JOIN", this.peek());
        const on = this.parseExpression();
        joins.push({ type: joinType, table: right.table, alias: right.alias, on });
      }
    }
    let where = null;
    if (this.match('keyword', 'WHERE')) where = this.parseExpression();
    let groupBy = null;
    if (this.match('keyword', 'GROUP')) {
      this.expectKeyword('BY');
      groupBy = [this.parseValue()];
      while (this.match('punct', ',')) groupBy.push(this.parseValue());
    }
    let orderBy = null;
    if (this.match('keyword', 'ORDER')) {
      this.expectKeyword('BY');
      orderBy = [];
      for (;;) {
        const expr = this.parseValue();
        const desc = this.match('keyword', 'DESC');
        this.match('keyword', 'ASC');
        orderBy.push({ expr, desc });
        if (!this.match('punct', ',')) break;
      }
    }
    let limit = null;
    let offset = null;
    if (this.match('keyword', 'LIMIT')) limit = this.parseValue();
    if (this.match('keyword', 'OFFSET')) offset = this.parseValue();
    return { type: 'select', table, tableAlias, joins, distinct, columns, where, groupBy, orderBy, limit, offset };
  }

  // `<table> [AS alias]` — the alias defaults to the table name.
  parseTableRef() {
    const name = this.identifier();
    let alias = name;
    if (this.match('keyword', 'AS')) {
      alias = this.identifier();
    } else if (this.peek().type === 'ident' && String(this.peek().value).toLowerCase() !== 'on') {
      // Bare alias (but never the context-sensitive `ON` word of a JOIN).
      alias = this.identifier();
    }
    return { table: name, alias };
  }

  parseSelectItems() {
    const items = [this.parseSelectItem()];
    while (this.match('punct', ',')) items.push(this.parseSelectItem());
    return items;
  }

  parseSelectItem() {
    if (this.check('punct', '*')) { this.next(); return { kind: 'star' }; }
    // aggregate: COUNT(...) etc.
    const t = this.peek();
    if (t.type === 'keyword' && AGGREGATES.has(t.value) && this.peek(1).value === '(' && this.peek(1).type === 'punct') {
      const fn = t.value; this.next(); this.expectPunct('(');
      let arg;
      if (this.match('punct', '*')) {
        arg = { kind: 'star' };
      } else if (this.check('punct', ')')) {
        throw new NovaParseError(`${fn}() requires an argument`, this.peek());
      } else {
        const distinct = this.match('keyword', 'DISTINCT');
        arg = { kind: 'expr', expr: this.parseValue(), distinct };
      }
      this.expectPunct(')');
      const alias = this.parseOptionalAlias();
      return { kind: 'agg', fn, arg, alias };
    }
    const expr = this.parseValue();
    const alias = this.parseOptionalAlias();
    return { kind: 'expr', expr, alias };
  }

  parseOptionalAlias() {
    if (this.match('keyword', 'AS')) return this.identifier();
    if (this.peek().type === 'ident') return this.identifier();
    return null;
  }

  parseUpdate() {
    this.expectKeyword('UPDATE');
    const table = this.identifier();
    this.expectKeyword('SET');
    const assignments = [];
    for (;;) {
      const column = this.identifier();
      if (!this.match('operator', '=')) throw new NovaParseError("expected '=' in SET", this.peek());
      assignments.push({ column, expr: this.parseValue() });
      if (!this.match('punct', ',')) break;
    }
    let where = null;
    if (this.match('keyword', 'WHERE')) where = this.parseExpression();
    return { type: 'update', table, assignments, where };
  }

  parseDelete() {
    this.expectKeyword('DELETE');
    this.expectKeyword('FROM');
    const table = this.identifier();
    let where = null;
    if (this.match('keyword', 'WHERE')) where = this.parseExpression();
    return { type: 'delete', table, where };
  }

  // --- value (scalar) expressions ----------------------------------------
  parseValue() {
    if (this.match('operator', '-')) {
      const operand = this.parseValue();
      if (operand.expr === 'lit' && typeof operand.value === 'number') return { expr: 'lit', value: -operand.value };
      return { expr: 'neg', operand };
    }
    const t = this.next();
    switch (t.type) {
      case 'number': return { expr: 'lit', value: t.value };
      case 'string': return { expr: 'lit', value: t.value };
      case 'param': this.paramCount += 1; return { expr: 'param', index: t.value };
      case 'keyword':
        if (t.value === 'NULL') return { expr: 'lit', value: null };
        if (t.value === 'TRUE') return { expr: 'lit', value: true };
        if (t.value === 'FALSE') return { expr: 'lit', value: false };
        if (t.value === 'DEFAULT') return { expr: 'default' };
        throw new NovaParseError('unexpected keyword in value', t);
      case 'ident': {
        // Qualified column reference: table.col or alias.col. Keep the qualifier
        // so JOINs can disambiguate same-named columns across tables.
        const segments = [t.value];
        while (this.check('punct', '.')) { this.next(); segments.push(this.identifier()); }
        const name = segments[segments.length - 1];
        const table = segments.length > 1 ? segments[segments.length - 2] : null;
        return { expr: 'column', name, table };
      }
      case 'punct':
        if (t.value === '(') {
          const inner = this.parseExpression();
          this.expectPunct(')');
          return { expr: 'group', operand: inner };
        }
        throw new NovaParseError('unexpected token in value', t);
      default:
        throw new NovaParseError('expected a value', t);
    }
  }

  // --- boolean expression grammar (WHERE) --------------------------------
  parseExpression() { return this.parseOr(); }

  parseOr() {
    let left = this.parseAnd();
    while (this.match('keyword', 'OR')) left = { expr: 'or', left, right: this.parseAnd() };
    return left;
  }

  parseAnd() {
    let left = this.parseNot();
    while (this.match('keyword', 'AND')) left = { expr: 'and', left, right: this.parseNot() };
    return left;
  }

  parseNot() {
    if (this.match('keyword', 'NOT')) return { expr: 'not', operand: this.parseNot() };
    return this.parsePredicate();
  }

  parsePredicate() {
    // A parenthesised boolean expression, or a comparison against a value.
    if (this.check('punct', '(')) {
      const saved = this.pos;
      this.next();
      try {
        const inner = this.parseExpression();
        this.expectPunct(')');
        return { expr: 'group', operand: inner };
      } catch {
        this.pos = saved; // not a boolean group; fall through to a value comparison
      }
    }

    const left = this.parseValue();

    // IS [NOT] NULL
    if (this.match('keyword', 'IS')) {
      const negated = this.match('keyword', 'NOT');
      this.expectKeyword('NULL');
      return { expr: 'isNull', operand: left, negated };
    }
    // [NOT] LIKE 'pattern'
    const negLike = this.check('keyword', 'NOT') && this.peek(1).value === 'LIKE';
    if (negLike) this.next();
    if (this.match('keyword', 'LIKE')) return { expr: 'like', left, right: this.parseValue(), negated: negLike };

    // [NOT] IN (v1, v2, ...)
    const negIn = this.check('keyword', 'NOT') && this.peek(1).value === 'IN';
    if (negIn) this.next();
    if (this.match('keyword', 'IN')) {
      this.expectPunct('(');
      const list = [this.parseValue()];
      while (this.match('punct', ',')) list.push(this.parseValue());
      this.expectPunct(')');
      return { expr: 'in', operand: left, list, negated: negIn };
    }

    // comparison operator
    const t = this.peek();
    if (t.type === 'operator') {
      this.next();
      return { expr: 'compare', op: t.value, left, right: this.parseValue() };
    }
    throw new NovaParseError('expected a comparison operator', t);
  }
}

// CREATE INDEX is handled inline in parseCreate (the context-sensitive `ON`
// word is matched via matchWord rather than reserved), so no prototype patch
// is needed.

module.exports = { parse, parseMany, NovaParseError, Parser, AGGREGATES, DATA_TYPES };
