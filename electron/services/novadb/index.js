'use strict';
/**
 * NovaDB — module entry point (Stage 1).
 *
 * NovaDB is NovaCode's own database engine: its own lexer (lexer.js), parser
 * (parser.js) and execution engine (engine.js). Nothing here borrows another
 * database engine, and no input is ever `eval`'d — queries are tokenized,
 * parsed into an AST, and executed against NovaDB's own data model.
 *
 * Stage 1 ships the parser + in-memory execution prototype. Later stages add,
 * on top of this same engine: a persistent file format (Stage 2), a local TCP
 * server + JS client library (Stages 4), and transactions/journaling, auth and
 * reliability hardening (Stage 5).
 *
 * Usage:
 *   const { createNovaDB } = require('./novadb');
 *   const db = createNovaDB();
 *   db.execute('CREATE DATABASE school');
 *   db.execute('USE school');
 *   db.execute('CREATE TABLE students (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)');
 *   db.execute('INSERT INTO students (name, age) VALUES (?, ?)', ['Ada', 36]);
 *   const rows = db.execute('SELECT * FROM students WHERE age > ?', [30]).rows;
 */
const { tokenize, NovaLexError } = require('./lexer');
const { parse, parseMany, NovaParseError } = require('./parser');
const { createEngine, NovaDBError } = require('./engine');

/**
 * Create a NovaDB engine instance.
 * @returns {{ execute: Function, executeMany: Function, getState: Function, getTableRows: Function }}
 */
function createNovaDB() {
  return createEngine();
}

module.exports = {
  createNovaDB,
  createEngine,
  parse,
  parseMany,
  tokenize,
  NovaDBError,
  NovaParseError,
  NovaLexError,
};
