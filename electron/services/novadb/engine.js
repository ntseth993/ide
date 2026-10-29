'use strict';
/**
 * NovaDB — in-memory execution engine (Stage 1 prototype).
 *
 * Executes the AST produced by parser.js against an in-memory catalog of
 * databases, tables and records. This is the "working prototype" the roadmap's
 * Stage 1 calls for: real parsing, real execution, real results — no mocks, no
 * `eval`, no borrowed engine. Persistent storage (Stage 2), the server (Stage
 * 4) and authentication (Stage 5) intentionally build on this same engine.
 *
 * Data model
 *   - Column types: INTEGER, REAL, TEXT, BOOLEAN; every column is nullable
 *     unless declared NOT NULL (primary keys are implicitly NOT NULL).
 *   - A primary key is unique; an INTEGER primary key auto-increments when the
 *     value is omitted. UNIQUE columns and UNIQUE indexes are enforced.
 *   - Records are plain objects keyed by column name.
 *
 * Transactions use snapshot/restore (BEGIN deep-copies the current database;
 * ROLLBACK restores it; COMMIT discards the snapshot). This gives correct
 * atomicity for the prototype without claiming durability — the spec forbids
 * asserting ACID guarantees until Stage 5 adds journaling and its tests.
 */
const { parse, parseMany } = require('./parser');

const NOVA_DB_TYPES = new Set(['INTEGER', 'REAL', 'TEXT', 'BOOLEAN']);
const KEY_SEP = '\u0000';

class NovaDBError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NovaDBError';
  }
}

/** Create a fresh in-memory engine. */
function createEngine() {
  const databases = new Map(); // lower-name -> { name, tables: Map<lower, table> }
  let current = null;           // current database lower-name
  let snapshot = null;          // { database, tables } taken at BEGIN

  function requireDatabase() {
    if (!current || !databases.has(current)) {
      throw new NovaDBError('No database is selected. Run `CREATE DATABASE` and `USE <db>` first.');
    }
    return databases.get(current);
  }

  function requireTable(name) {
    const db = requireDatabase();
    const table = db.tables.get(String(name).toLowerCase());
    if (!table) throw new NovaDBError(`Table '${name}' does not exist.`);
    return table;
  }

  function resolveColumn(table, name) {
    const col = table.columns.find((c) => c.name.toLowerCase() === String(name).toLowerCase());
    if (!col) throw new NovaDBError(`Unknown column '${name}' in table '${table.name}'.`);
    return col;
  }

  // --- entry points -------------------------------------------------------
  function execute(sql, params = []) {
    return run(parse(sql), params);
  }

  function executeMany(sql, params = []) {
    const results = parseMany(sql).map((statement) => run(statement, params));
    return results[results.length - 1];
  }

  function run(statement, params) {
    const needed = statement.paramCount || 0;
    const given = Array.isArray(params) ? params.length : 0;
    if (needed !== given) {
      throw new NovaDBError(`Statement binds ${needed} parameter(s) but ${given} were provided.`);
    }
    switch (statement.type) {
      case 'createDatabase': return createDatabase(statement);
      case 'dropDatabase': return dropDatabase(statement);
      case 'showDatabases': return { ok: true, type: 'showDatabases', columns: ['database'], rows: [...databases.values()].map((db) => ({ database: db.name })) };
      case 'use': return useDatabase(statement);
      case 'createTable': return createTable(statement);
      case 'dropTable': return dropTable(statement);
      case 'alterTable': return alterTable(statement);
      case 'showTables': { const db = requireDatabase(); return { ok: true, type: 'showTables', columns: ['table'], rows: [...db.tables.values()].map((t) => ({ table: t.name })) }; }
      case 'describe': return describeTable(statement);
      case 'createIndex': return createIndex(statement);
      case 'dropIndex': return dropIndex(statement);
      case 'insert': return insert(statement, params);
      case 'select': return select(statement, params);
      case 'update': return update(statement, params);
      case 'delete': return remove(statement, params);
      case 'begin': return beginTx();
      case 'commit': return commitTx();
      case 'rollback': return rollbackTx();
      default: throw new NovaDBError(`Unsupported statement type '${statement.type}'.`);
    }
  }

  // --- DDL ----------------------------------------------------------------
  function createDatabase({ name, ifNotExists }) {
    const key = name.toLowerCase();
    if (databases.has(key)) {
      if (ifNotExists) return { ok: true, type: 'createDatabase', message: `database ${name} already exists` };
      throw new NovaDBError(`Database '${name}' already exists.`);
    }
    databases.set(key, { name, tables: new Map() });
    if (!current) current = key;
    return { ok: true, type: 'createDatabase', message: `database ${name} created` };
  }

  function dropDatabase({ name, ifExists }) {
    const key = name.toLowerCase();
    if (!databases.has(key)) {
      if (ifExists) return { ok: true, type: 'dropDatabase', message: `database ${name} dropped` };
      throw new NovaDBError(`Database '${name}' does not exist.`);
    }
    databases.delete(key);
    if (current === key) current = null;
    snapshot = null;
    return { ok: true, type: 'dropDatabase', message: `database ${name} dropped` };
  }

  function useDatabase({ name }) {
    const key = name.toLowerCase();
    if (!databases.has(key)) throw new NovaDBError(`Database '${name}' does not exist.`);
    current = key;
    snapshot = null;
    return { ok: true, type: 'use', message: `using ${name}` };
  }

  function createTable({ name, ifNotExists, columns, foreignKeys }) {
    const db = requireDatabase();
    const key = name.toLowerCase();
    if (db.tables.has(key)) {
      if (ifNotExists) return { ok: true, type: 'createTable', message: `table ${name} already exists` };
      throw new NovaDBError(`Table '${name}' already exists.`);
    }
    const seen = new Set();
    const cols = columns.map((c) => {
      if (seen.has(c.name.toLowerCase())) throw new NovaDBError(`Duplicate column '${c.name}'.`);
      seen.add(c.name.toLowerCase());
      if (!NOVA_DB_TYPES.has(c.dataType)) throw new NovaDBError(`Unsupported type '${c.dataType}'.`);
      return {
        name: c.name,
        dataType: c.dataType,
        primaryKey: !!c.primaryKey,
        notNull: !!c.notNull || !!c.primaryKey,
        unique: !!c.unique,
        defaultValue: c.defaultValue || null,
        fk: c.fk ? { table: c.fk.table, column: c.fk.column || null } : null,
      };
    });
    // Fold table-level FOREIGN KEY (col, ...) REFERENCES parent(col) onto columns.
    for (const fk of foreignKeys || []) {
      for (const colName of fk.columns) {
        const col = cols.find((c) => c.name.toLowerCase() === String(colName).toLowerCase());
        if (!col) throw new NovaDBError(`FOREIGN KEY references unknown column '${colName}'.`);
        if (!col.fk) col.fk = { table: fk.refTable, column: fk.refColumn || null };
      }
    }
    db.tables.set(key, { name, columns: cols, rows: [], indexes: [], autoId: nextAutoId(cols, []) });
    return { ok: true, type: 'createTable', message: `table ${name} created with ${cols.length} column(s)` };
  }

  function dropTable({ name, ifExists }) {
    const db = requireDatabase();
    const key = name.toLowerCase();
    if (!db.tables.has(key)) {
      if (ifExists) return { ok: true, type: 'dropTable', message: `table ${name} dropped` };
      throw new NovaDBError(`Table '${name}' does not exist.`);
    }
    db.tables.delete(key);
    return { ok: true, type: 'dropTable', message: `table ${name} dropped` };
  }

  function alterTable({ name, actions }) {
    const table = requireTable(name);
    for (const action of actions) {
      if (action.action === 'add') {
        const c = action.column;
        if (table.columns.some((x) => x.name.toLowerCase() === c.name.toLowerCase())) {
          throw new NovaDBError(`Column '${c.name}' already exists.`);
        }
        const notNull = !!c.notNull || !!c.primaryKey;
        if (notNull && !c.defaultValue && table.rows.length) {
          throw new NovaDBError(`Cannot add NOT NULL column '${c.name}' without a default to a populated table.`);
        }
        const col = {
          name: c.name, dataType: c.dataType, primaryKey: false,
          notNull, unique: !!c.unique, defaultValue: c.defaultValue || null,
        };
        const filled = c.defaultValue ? coerce(evalExpr(c.defaultValue, {}, [], table), col, `${table.name}.${c.name}`) : null;
        table.columns.push(col);
        for (const row of table.rows) row[col.name] = filled;
      } else {
        const idx = table.columns.findIndex((x) => x.name.toLowerCase() === action.columnName.toLowerCase());
        if (idx === -1) throw new NovaDBError(`Column '${action.columnName}' does not exist.`);
        const [dropped] = table.columns.splice(idx, 1);
        for (const row of table.rows) delete row[dropped.name];
        table.indexes = table.indexes.filter((ix) => !ix.columns.some((n) => n.toLowerCase() === dropped.name.toLowerCase()));
      }
    }
    return { ok: true, type: 'alterTable', message: `table ${name} altered` };
  }

  function describeTable({ name }) {
    const table = requireTable(name);
    return {
      ok: true,
      type: 'describe',
      table: table.name,
      columns: ['column', 'type', 'nullable', 'primary_key', 'references', 'default'],
      rows: table.columns.map((c) => ({
        column: c.name,
        type: c.dataType,
        nullable: c.notNull ? 'NO' : 'YES',
        primary_key: c.primaryKey ? 'YES' : 'NO',
        references: c.fk ? `${c.fk.table}(${c.fk.column || defaultRefColumn(c)})` : null,
        default: c.defaultValue ? literalValue(c.defaultValue) : null,
      })),
    };
  }

  // The referenced column when a FK omits it: the parent table's primary key.
  function defaultRefColumn(col) {
    const db = databases.get(current);
    const parent = db && db.tables.get(String(col.fk.table).toLowerCase());
    if (!parent) return '?';
    const pk = parent.columns.find((c) => c.primaryKey);
    return pk ? pk.name : '?';
  }

  function createIndex({ name, table: tableName, columns, unique, ifNotExists }) {
    const table = requireTable(tableName);
    const key = name.toLowerCase();
    if (table.indexes.some((ix) => ix.name.toLowerCase() === key)) {
      if (ifNotExists) return { ok: true, type: 'createIndex', message: `index ${name} already exists` };
      throw new NovaDBError(`Index '${name}' already exists.`);
    }
    const colNames = columns.map((n) => resolveColumn(table, n).name);
    if (unique) assertRowsUnique(table, colNames, table.rows, `Index '${name}'`);
    table.indexes.push({ name, columns: colNames, unique: !!unique });
    return { ok: true, type: 'createIndex', message: `index ${name} created on ${table.name}(${colNames.join(', ')})` };
  }

  function dropIndex({ name, ifExists }) {
    const db = requireDatabase();
    for (const table of db.tables.values()) {
      const idx = table.indexes.findIndex((ix) => ix.name.toLowerCase() === name.toLowerCase());
      if (idx !== -1) { table.indexes.splice(idx, 1); return { ok: true, type: 'dropIndex', message: `index ${name} dropped` }; }
    }
    if (ifExists) return { ok: true, type: 'dropIndex', message: `index ${name} dropped` };
    throw new NovaDBError(`Index '${name}' does not exist.`);
  }

  // --- DML ----------------------------------------------------------------
  function insert(statement, params) {
    const table = requireTable(statement.table);
    const explicit = statement.columns
      ? statement.columns.map((n) => resolveColumn(table, n))
      : table.columns.slice();
    let affected = 0;

    for (const valueExprs of statement.rows) {
      if (valueExprs.length !== explicit.length) {
        throw new NovaDBError(`INSERT has ${valueExprs.length} value(s) but ${explicit.length} column(s).`);
      }
      const row = {};
      for (const col of table.columns) {
        if (!explicit.includes(col)) row[col.name] = defaultFor(col, params, table);
      }
      for (let i = 0; i < explicit.length; i += 1) {
        const col = explicit[i];
        const expr = valueExprs[i];
        if (expr.expr === 'default') { row[col.name] = defaultFor(col, params, table); continue; }
        const raw = evalExpr(expr, {}, params, table);
        row[col.name] = coerce(raw, col, `${table.name}.${col.name}`);
      }
      applyAutoIncrement(table, row);
      validateRow(table, row, null);
      assertForeignKeys(table, row);
      table.rows.push(row);
      affected += 1;
    }
    return { ok: true, type: 'insert', affectedRows: affected, message: `inserted ${affected} row(s)` };
  }

  function select(statement, params) {
    const isJoin = !!(statement.joins && statement.joins.length);
    const singleTable = !isJoin && statement.table ? requireTable(statement.table) : null;
    const scopeTable = singleTable;
    const sources = isJoin ? collectSources(statement) : null;

    const base = isJoin ? buildJoinedRows(statement, params, sources) : (singleTable ? singleTable.rows.slice() : [{}]);
    const filtered = statement.where
      ? base.filter((row) => truthy(evalBool(statement.where, row, params, scopeTable)))
      : base;

    const hasAggregate = statement.columns.some((c) => c.kind === 'agg');
    const grouped = !!(statement.groupBy && statement.groupBy.length);
    let columns;
    let rows;

    if (hasAggregate || grouped) {
      if (statement.orderBy) throw new NovaDBError('ORDER BY with GROUP BY/aggregates is not supported yet.');
      const groups = groupRows(filtered, statement.groupBy, params, scopeTable);
      columns = dedupeNames(statement.columns.map((item, i) => selectItemName(item, i)));
      rows = groups.map((grp) => {
        const out = {};
        statement.columns.forEach((item, i) => {
          out[columns[i]] = item.kind === 'agg'
            ? computeAggregate(item, grp, params, scopeTable)
            : (grp.length ? evalExpr(item.expr, grp[0], params, scopeTable) : null);
        });
        return out;
      });
    } else {
      if (statement.orderBy) orderRows(filtered, statement.orderBy, params, scopeTable);
      const items = expandItems(statement.columns, singleTable, sources);
      columns = dedupeNames(items.map((item, i) => item.alias || columnNameFor(item, i)));
      rows = filtered.map((row) => {
        const out = {};
        items.forEach((item, i) => { out[columns[i]] = evalExpr(item.expr, row, params, scopeTable); });
        return out;
      });
      if (statement.distinct) rows = distinctRows(rows, columns);
    }

    const limit = statement.limit ? toInt(evalExpr(statement.limit, {}, params, scopeTable), 'LIMIT') : null;
    const offset = statement.offset ? toInt(evalExpr(statement.offset, {}, params, scopeTable), 'OFFSET') : 0;
    if (limit !== null) rows = rows.slice(offset, offset + limit);
    else if (offset) rows = rows.slice(offset);

    return { ok: true, type: 'select', columns, rows, rowCount: rows.length };
  }

  // --- join / grouping helpers -------------------------------------------
  function selectItemName(item, index) {
    if (item.kind === 'agg') return aggregateName(item, index);
    return item.alias || columnNameFor(item, index);
  }

  // FROM table + each JOIN, each with its resolved object and effective alias.
  function collectSources(statement) {
    const sources = [{ table: requireTable(statement.table), alias: statement.tableAlias || statement.table }];
    for (const j of statement.joins) sources.push({ table: requireTable(j.table), alias: j.alias || j.table });
    return sources;
  }

  // A joined row carries both qualified (`alias.col`) and bare (`col`) keys.
  function decorateRow(table, alias, row) {
    const out = {};
    for (const col of table.columns) {
      const v = row[col.name] === undefined ? null : row[col.name];
      out[`${alias}.${col.name}`] = v;
      if (!(col.name in out)) out[col.name] = v;
    }
    return out;
  }

  // Nested-loop join: cross product filtered by the ON predicate; LEFT keeps
  // unmatched left rows with the right side padded to NULL.
  function buildJoinedRows(statement, params, sources) {
    const [first, ...rest] = sources;
    let acc = first.table.rows.map((r) => decorateRow(first.table, first.alias, r));
    for (let i = 0; i < rest.length; i += 1) {
      const join = statement.joins[i];
      const right = rest[i];
      const next = [];
      for (const lrow of acc) {
        let matched = false;
        for (const r of right.table.rows) {
          const merged = Object.assign({}, lrow, decorateRow(right.table, right.alias, r));
          if (truthy(evalBool(join.on, merged, params, null))) { next.push(merged); matched = true; }
        }
        if (!matched && join.type === 'left') {
          const padded = Object.assign({}, lrow);
          for (const col of right.table.columns) {
            padded[`${right.alias}.${col.name}`] = null;
            if (!(col.name in padded)) padded[col.name] = null;
          }
          next.push(padded);
        }
      }
      acc = next;
    }
    return acc;
  }

  function groupRows(rows, groupExprs, params, table) {
    if (!groupExprs || !groupExprs.length) return [rows];
    const map = new Map();
    for (const row of rows) {
      const key = groupExprs.map((g) => serialize(evalExpr(g, row, params, table))).join(KEY_SEP);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    return [...map.values()];
  }

  function expandItems(columns, singleTable, sources) {
    const items = [];
    for (const item of columns) {
      if (item.kind !== 'star') { items.push(item); continue; }
      if (sources) {
        for (const s of sources) {
          for (const col of s.table.columns) {
            items.push({ kind: 'expr', expr: { expr: 'column', name: col.name, table: s.alias }, alias: `${s.alias}.${col.name}` });
          }
        }
      } else if (singleTable) {
        for (const col of singleTable.columns) items.push({ kind: 'expr', expr: { expr: 'column', name: col.name }, alias: col.name });
      } else {
        throw new NovaDBError('SELECT * requires a FROM table.');
      }
    }
    return items;
  }

  function update(statement, params) {
    const table = requireTable(statement.table);
    const targets = table.rows.filter((row) => !statement.where || truthy(evalBool(statement.where, row, params, table)));
    for (const row of targets) {
      const candidate = { ...row };
      for (const assignment of statement.assignments) {
        const col = resolveColumn(table, assignment.column);
        const raw = assignment.expr.expr === 'default'
          ? defaultFor(col, params, table)
          : evalExpr(assignment.expr, row, params, table);
        // allow SET col = col + ... is out of scope; direct column ref reads old row
        candidate[col.name] = coerce(raw, col, `${table.name}.${col.name}`);
      }
      validateRow(table, candidate, row);
      assertForeignKeys(table, candidate);
      Object.assign(row, candidate);
    }
    return { ok: true, type: 'update', affectedRows: targets.length, message: `updated ${targets.length} row(s)` };
  }

  function remove(statement, params) {
    const table = requireTable(statement.table);
    const doomed = table.rows.filter((row) => !statement.where || truthy(evalBool(statement.where, row, params, table)));
    if (doomed.length) assertNoChildReferences(table, doomed);
    let removed = 0;
    table.rows = table.rows.filter((row) => {
      const match = !statement.where || truthy(evalBool(statement.where, row, params, table));
      if (match) removed += 1;
      return !match;
    });
    return { ok: true, type: 'delete', affectedRows: removed, message: `deleted ${removed} row(s)` };
  }

  // --- transactions -------------------------------------------------------
  function beginTx() {
    const db = requireDatabase();
    if (snapshot) throw new NovaDBError('A transaction is already in progress.');
    snapshot = { database: current, tables: cloneTables(db.tables) };
    return { ok: true, type: 'begin', message: 'transaction started' };
  }

  function commitTx() {
    if (!snapshot) throw new NovaDBError('No transaction is in progress (BEGIN first).');
    snapshot = null;
    return { ok: true, type: 'commit', message: 'transaction committed' };
  }

  function rollbackTx() {
    if (!snapshot) throw new NovaDBError('No transaction is in progress (BEGIN first).');
    const db = databases.get(snapshot.database);
    db.tables = snapshot.tables;
    snapshot = null;
    return { ok: true, type: 'rollback', message: 'transaction rolled back' };
  }

  // --- integrity ----------------------------------------------------------
  function defaultFor(col, params, table) {
    if (col.defaultValue) return coerce(literalValue(col.defaultValue), col, `${table.name}.${col.name}`);
    return col.primaryKey ? undefined : null;
  }

  function applyAutoIncrement(table, row) {
    const pk = table.columns.find((c) => c.primaryKey && c.dataType === 'INTEGER');
    if (!pk) return;
    if (row[pk.name] === undefined || row[pk.name] === null) {
      row[pk.name] = table.autoId;
      table.autoId += 1;
    } else if (typeof row[pk.name] === 'number' && row[pk.name] >= table.autoId) {
      table.autoId = row[pk.name] + 1;
    }
  }

  function validateRow(table, candidate, oldRow) {
    for (const col of table.columns) {
      const value = candidate[col.name];
      if (value === undefined) {
        if (col.notNull) throw new NovaDBError(`Column '${col.name}' cannot be NULL.`);
        candidate[col.name] = null;
        continue;
      }
      if (value === null && col.notNull) throw new NovaDBError(`Column '${col.name}' cannot be NULL.`);
    }
    for (const col of table.columns) {
      if (col.primaryKey || col.unique) {
        assertUnique(table, [col.name], candidate, table.rows, oldRow, `Column '${col.name}'`);
      }
    }
    for (const ix of table.indexes) {
      if (ix.unique) assertUnique(table, ix.columns, candidate, table.rows, oldRow, `Index '${ix.name}'`);
    }
    const pk = table.columns.find((c) => c.primaryKey && c.dataType === 'INTEGER');
    if (pk && typeof candidate[pk.name] === 'number' && candidate[pk.name] >= table.autoId) {
      table.autoId = candidate[pk.name] + 1;
    }
  }

  function keyOf(table, colNames, row) {
    return colNames.map((n) => serialize(row[resolveColumn(table, n).name])).join(KEY_SEP);
  }

  function assertUnique(table, colNames, candidate, rows, exclude, label) {
    const values = colNames.map((n) => candidate[resolveColumn(table, n).name]);
    if (values.some((v) => v === null || v === undefined)) return; // NULLs never collide
    const candidateKey = values.map(serialize).join(KEY_SEP);
    const clash = rows.some((row) => row !== exclude && keyOf(table, colNames, row) === candidateKey);
    if (clash) throw new NovaDBError(`${label}: UNIQUE constraint (${colNames.join(', ')}) violated.`);
  }

  function assertRowsUnique(table, colNames, rows, label) {
    const seen = new Set();
    for (const row of rows) {
      const values = colNames.map((n) => row[resolveColumn(table, n).name]);
      if (values.some((v) => v === null || v === undefined)) continue;
      const key = values.map(serialize).join(KEY_SEP);
      if (seen.has(key)) throw new NovaDBError(`${label}: existing rows violate UNIQUE (${colNames.join(', ')}).`);
      seen.add(key);
    }
  }

  // --- referential integrity ---------------------------------------------
  // The referenced parent column for a FK: the explicit one, else the parent PK.
  function fkParentColumn(parent, fk) {
    if (fk.column) {
      const col = parent.columns.find((c) => c.name.toLowerCase() === String(fk.column).toLowerCase());
      if (!col) throw new NovaDBError(`FOREIGN KEY references unknown column '${parent.name}.${fk.column}'.`);
      return col;
    }
    const pk = parent.columns.find((c) => c.primaryKey);
    if (!pk) throw new NovaDBError(`FOREIGN KEY on '${parent.name}' has no referenced column and parent has no PRIMARY KEY.`);
    return pk;
  }

  // Validate that every non-NULL FK value in `row` exists in the parent table.
  function assertForeignKeys(table, row) {
    const db = databases.get(current);
    for (const col of table.columns) {
      if (!col.fk) continue;
      const value = row[col.name];
      if (value === null || value === undefined) continue; // NULL FK is allowed
      const parent = db && db.tables.get(String(col.fk.table).toLowerCase());
      if (!parent) throw new NovaDBError(`FOREIGN KEY on '${table.name}.${col.name}' references unknown table '${col.fk.table}'.`);
      const pcol = fkParentColumn(parent, col.fk);
      const exists = parent.rows.some((prow) => looseEq(prow[pcol.name], value));
      if (!exists) {
        const shown = typeof value === 'string' ? `'${value}'` : String(value);
        throw new NovaDBError(`FOREIGN KEY constraint violated: '${table.name}.${col.name}' = ${shown} not found in '${parent.name}.${pcol.name}'.`);
      }
    }
  }

  // RESTRICT: block deleting a parent row that child rows still reference.
  function assertNoChildReferences(table, deletedRows) {
    const db = databases.get(current);
    if (!db) return;
    for (const [key, child] of db.tables) {
      if (key === table.name.toLowerCase()) continue;
      for (const col of child.columns) {
        if (!col.fk) continue;
        if (String(col.fk.table).toLowerCase() !== table.name.toLowerCase()) continue;
        const pcol = fkParentColumn(table, col.fk);
        const blocked = deletedRows.some((prow) => {
          const pv = prow[pcol.name];
          if (pv === null || pv === undefined) return false;
          return child.rows.some((crow) => crow !== prow && looseEq(crow[col.name], pv));
        });
        if (blocked) {
          throw new NovaDBError(`DELETE blocked: rows in '${child.name}.${col.name}' still reference '${table.name}.${pcol.name}' (RESTRICT).`);
        }
      }
    }
  }

  // --- ordering -----------------------------------------------------------
  function orderRows(rows, orderBy, params, table) {
    rows.sort((a, b) => {
      for (const { expr, desc } of orderBy) {
        const av = evalExpr(expr, a, params, table);
        const bv = evalExpr(expr, b, params, table);
        const nullA = av === null || av === undefined;
        const nullB = bv === null || bv === undefined;
        if (nullA && nullB) continue;
        if (nullA) return desc ? 1 : -1;
        if (nullB) return desc ? -1 : 1;
        const c = compareValues(av, bv);
        if (c !== 0) return desc ? -c : c;
      }
      return 0;
    });
  }

  // --- aggregates ---------------------------------------------------------
  function computeAggregate(item, rows, params, table) {
    const fn = item.fn;
    if (item.arg.kind === 'star') {
      if (fn !== 'COUNT') throw new NovaDBError(`${fn}(*) is not valid; only COUNT(*) accepts '*'.`);
      return rows.length;
    }
    const expr = item.arg.expr;
    let vals = rows.map((row) => evalExpr(expr, row, params, table));
    if (item.arg.distinct) {
      const seen = new Set();
      const deduped = [];
      for (const v of vals) {
        if (v === null || v === undefined) continue;
        const k = serialize(v);
        if (!seen.has(k)) { seen.add(k); deduped.push(v); }
      }
      vals = deduped;
    }
    const nonNull = vals.filter((v) => v !== null && v !== undefined);
    const numeric = nonNull.filter((v) => typeof v === 'number');
    switch (fn) {
      case 'COUNT': return nonNull.length;
      case 'SUM': return numeric.reduce((a, b) => a + b, 0);
      case 'AVG': return numeric.length ? numeric.reduce((a, b) => a + b, 0) / numeric.length : null;
      case 'MIN': return nonNull.length ? nonNull.reduce((a, b) => (compareValues(a, b) <= 0 ? a : b)) : null;
      case 'MAX': return nonNull.length ? nonNull.reduce((a, b) => (compareValues(a, b) >= 0 ? a : b)) : null;
      default: throw new NovaDBError(`Unknown aggregate '${fn}'.`);
    }
  }

  function aggregateName(item, index) {
    if (item.alias) return item.alias;
    if (item.arg.kind === 'star') return `${item.fn}(*)`;
    const inner = exprName(item.arg.expr, index);
    return `${item.fn}(${item.arg.distinct ? 'DISTINCT ' : ''}${inner})`;
  }

  // --- expression evaluation ---------------------------------------------
  function evalExpr(node, row, params, table) {
    switch (node.expr) {
      case 'lit': return node.value;
      case 'param': return params[node.index];
      case 'column': {
        const keys = Object.keys(row || {});
        // Qualified reference (table.col / alias.col) — match the dotted key first.
        if (node.table) {
          const want = `${String(node.table)}.${String(node.name)}`.toLowerCase();
          const q = keys.find((k) => k.toLowerCase() === want);
          if (q !== undefined) return row[q] === undefined ? null : row[q];
        }
        const key = keys.find((k) => k.toLowerCase() === String(node.name).toLowerCase());
        if (key !== undefined) return row[key] === undefined ? null : row[key];
        if (table && !table.columns.some((c) => c.name.toLowerCase() === String(node.name).toLowerCase())) {
          throw new NovaDBError(`Unknown column '${node.name}'.`);
        }
        return null;
      }
      case 'neg': { const v = evalExpr(node.operand, row, params, table); if (typeof v !== 'number') throw new NovaDBError('Unary minus requires a numeric value.'); return -v; }
      case 'group': return evalBoolOrValue(node, row, params, table);
      case 'default': return undefined;
      default: throw new NovaDBError(`Cannot evaluate expression '${node.expr}'.`);
    }
  }

  // A parenthesised node is reused by both value and boolean contexts.
  function evalBoolOrValue(node, row, params, table) {
    const inner = node.operand;
    if (isBooleanNode(inner)) return evalBool(inner, row, params, table);
    return evalExpr(inner, row, params, table);
  }

  function isBooleanNode(node) {
    return ['and', 'or', 'not', 'compare', 'isNull', 'like', 'in', 'group'].includes(node.expr)
      && !(node.expr === 'group' && isBooleanNode(node.operand) === false && looksLikeValue(node.operand));
  }

  function looksLikeValue(node) {
    return ['lit', 'param', 'column', 'neg'].includes(node.expr);
  }

  function evalBool(node, row, params, table) {
    switch (node.expr) {
      case 'and': return truthy(evalBool(node.left, row, params, table)) && truthy(evalBool(node.right, row, params, table));
      case 'or': return truthy(evalBool(node.left, row, params, table)) || truthy(evalBool(node.right, row, params, table));
      case 'not': return !truthy(evalBool(node.operand, row, params, table));
      case 'group': return isBooleanNode(node.operand) ? evalBool(node.operand, row, params, table) : truthy(evalExpr(node.operand, row, params, table));
      case 'compare': return compareOp(node.op, evalExpr(node.left, row, params, table), evalExpr(node.right, row, params, table));
      case 'isNull': { const v = evalExpr(node.operand, row, params, table); const isNull = v === null || v === undefined; return node.negated ? !isNull : isNull; }
      case 'like': { const v = evalExpr(node.left, row, params, table); const pat = evalExpr(node.right, row, params, table); const m = likeMatch(v, pat); return node.negated ? !m : m; }
      case 'in': { const v = evalExpr(node.operand, row, params, table); const found = node.list.some((item) => looseEq(v, evalExpr(item, row, params, table))); return node.negated ? !found : found; }
      default: return truthy(evalExpr(node, row, params, table));
    }
  }

  // --- persistence & introspection ---------------------------------------
  // serialize() captures the full catalog as plain JSON-safe data so the
  // storage layer (Stage 2) can flush it to disk; load() restores it. These
  // operate on the same structures the engine already owns — no re-parsing.
  function serializeState() {
    return {
      version: 1,
      current,
      databases: [...databases.values()].map((db) => ({
        name: db.name,
        tables: [...db.tables.values()].map((t) => ({
          name: t.name,
          columns: t.columns.map((c) => ({ ...c })),
          rows: t.rows.map((r) => ({ ...r })),
          indexes: t.indexes.map((ix) => ({ ...ix, columns: [...ix.columns] })),
          autoId: t.autoId,
        })),
      })),
    };
  }

  function loadAll(state) {
    if (!state || typeof state !== 'object' || !Array.isArray(state.databases)) return;
    databases.clear();
    for (const db of state.databases) {
      if (!db || typeof db.name !== 'string') continue;
      const tables = new Map();
      for (const t of db.tables || []) {
        if (!t || typeof t.name !== 'string') continue;
        const columns = (t.columns || []).map((c) => ({
          name: c.name,
          dataType: c.dataType,
          primaryKey: !!c.primaryKey,
          notNull: !!c.notNull,
          unique: !!c.unique,
          defaultValue: c.defaultValue || null,
          fk: c.fk && c.fk.table ? { table: c.fk.table, column: c.fk.column || null } : null,
        }));
        const rows = (t.rows || []).map((r) => ({ ...r }));
        tables.set(t.name.toLowerCase(), {
          name: t.name,
          columns,
          rows,
          indexes: (t.indexes || []).map((ix) => ({ ...ix, columns: [...(ix.columns || [])] })),
          autoId: Number.isInteger(t.autoId) ? t.autoId : nextAutoId(columns, rows),
        });
      }
      databases.set(db.name.toLowerCase(), { name: db.name, tables });
    }
    current = state.current && databases.has(state.current) ? state.current : null;
    snapshot = null;
  }

  // overview() is the lightweight snapshot the Database UI reads on open: the
  // catalog shape (databases, tables, columns, row counts) WITHOUT full rows.
  function overview() {
    return {
      current: current ? databases.get(current).name : null,
      databases: [...databases.values()].map((db) => ({
        name: db.name,
        isCurrent: db.name.toLowerCase() === current,
        tables: [...db.tables.values()].map((t) => ({
          name: t.name,
          columns: t.columns.map((c) => ({
            name: c.name,
            dataType: c.dataType,
            primaryKey: !!c.primaryKey,
            notNull: !!c.notNull,
            unique: !!c.unique,
            default: c.defaultValue ? literalValue(c.defaultValue) : null,
            references: c.fk ? { table: c.fk.table, column: c.fk.column || defaultRefColumn(c) } : null,
          })),
          rowCount: t.rows.length,
        })),
      })),
    };
  }

  return {
    execute,
    executeMany,
    getState: () => ({ current: current ? databases.get(current).name : null, databases: [...databases.values()].map((d) => d.name), inTransaction: Boolean(snapshot) }),
    getTableRows: (tableName) => requireTable(tableName).rows.map((r) => ({ ...r })),
    serialize: serializeState,
    load: loadAll,
    overview,
  };
}

// --- pure helpers (module scope) ------------------------------------------

function literalValue(defaultExpr) {
  // defaultValue is stored as an expression node; return its literal value.
  if (!defaultExpr || typeof defaultExpr !== 'object') return defaultExpr;
  if (defaultExpr.expr === 'lit') return defaultExpr.value;
  if (defaultExpr.expr === 'neg') return -literalValue(defaultExpr.operand);
  return defaultExpr;
}

function cloneTables(tables) {
  const clone = new Map();
  for (const [key, table] of tables) {
    clone.set(key, {
      name: table.name,
      columns: table.columns.map((c) => ({ ...c })),
      rows: table.rows.map((r) => ({ ...r })),
      indexes: table.indexes.map((ix) => ({ ...ix, columns: [...ix.columns] })),
      autoId: table.autoId,
    });
  }
  return clone;
}

function nextAutoId(cols, rows) {
  const pk = cols.find((c) => c.primaryKey && c.dataType === 'INTEGER');
  if (!pk) return 1;
  let max = 0;
  for (const row of rows) if (typeof row[pk.name] === 'number' && row[pk.name] > max) max = row[pk.name];
  return max + 1;
}

function coerce(raw, col, context) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const value = raw;
  switch (col.dataType) {
    case 'INTEGER': {
      if (typeof value === 'number') { if (!Number.isInteger(value)) throw new NovaDBError(`Column ${context}: INTEGER requires a whole number, got ${value}.`); return value; }
      if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
      throw new NovaDBError(`Column ${context}: cannot store ${typeName(value)} as INTEGER.`);
    }
    case 'REAL': {
      if (typeof value === 'number') return value;
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
      throw new NovaDBError(`Column ${context}: cannot store ${typeName(value)} as REAL.`);
    }
    case 'TEXT': {
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      throw new NovaDBError(`Column ${context}: cannot store ${typeName(value)} as TEXT.`);
    }
    case 'BOOLEAN': {
      if (typeof value === 'boolean') return value;
      if (value === 1 || value === 0) return Boolean(value);
      if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (v === 'true' || v === '1') return true;
        if (v === 'false' || v === '0') return false;
      }
      throw new NovaDBError(`Column ${context}: cannot store ${typeName(value)} as BOOLEAN.`);
    }
    default:
      throw new NovaDBError(`Column ${context}: unsupported type '${col.dataType}'.`);
  }
}

function typeName(value) {
  if (value === null) return 'NULL';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function truthy(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  return Boolean(value);
}

function compareOp(op, left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  const c = compareValues(left, right);
  switch (op) {
    case '=': return c === 0;
    case '!=': return c !== 0;
    case '<': return c < 0;
    case '>': return c > 0;
    case '<=': return c <= 0;
    case '>=': return c >= 0;
    default: throw new NovaDBError(`Unknown operator '${op}'.`);
  }
}

function compareValues(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  const sa = String(a); const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function looseEq(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === typeof b) return compareValues(a, b) === 0;
  // cross-type numeric/string equality on the numeric axis only
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b;
  if (typeof a === 'string' && typeof b === 'number') return a === String(b);
  return false;
}

function likeMatch(value, pattern) {
  if (value === null || value === undefined || typeof pattern !== 'string') return false;
  const body = pattern
    .split('')
    .map((ch) => {
      if (ch === '%') return '.*';
      if (ch === '_') return '.';
      return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${body}$`, 'i').test(String(value));
}

function serialize(value) {
  if (value === undefined || value === null) return '\u0001null';
  return `${typeof value}:${String(value)}`;
}

function columnNameFor(item, index) {
  if (item.alias) return item.alias;
  if (item.expr && item.expr.expr === 'column') return item.expr.name;
  return `column_${index + 1}`;
}

function exprName(node, index) {
  if (!node) return '*';
  if (node.expr === 'column') return node.name;
  if (node.expr === 'lit') return String(node.value);
  return columnNameFor({ expr: node }, index);
}

function distinctRows(rows, columns) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = columns.map((c) => serialize(row[c])).join(KEY_SEP);
    if (!seen.has(key)) { seen.add(key); out.push(row); }
  }
  return out;
}

function toInt(value, label) {
  const n = typeof value === 'string' ? parseInt(value, 10) : value;
  if (!Number.isInteger(n) || n < 0) throw new NovaDBError(`${label} must be a non-negative integer.`);
  return n;
}

function dedupeNames(names) {
  const counts = new Map();
  return names.map((n) => {
    const c = counts.get(n) || 0;
    counts.set(n, c + 1);
    return c === 0 ? n : `${n}_${c + 1}`;
  });
}

module.exports = { createEngine, NovaDBError, NOVA_DB_TYPES };
