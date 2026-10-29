/**
 * NovaDB — the Database workspace.
 *
 * A visual front-end over NovaCode's own database engine, so a user can create
 * databases, design tables and browse/add/delete records WITHOUT writing SQL.
 * Everything is backed by the real engine through two narrow bridge calls
 * (client.novaDbStatus / client.novaDbExec) — there is no mock data here: the
 * grid, the row counts and the query results are what the engine actually
 * stored. A query editor is included for people who DO want to run SQL, and the
 * same statements work in the terminal via `novadb <sql>`.
 *
 * This component stays presentational: it never touches Node, fs, or the engine
 * directly. Identifier inputs are validated to a safe [A-Za-z_][A-Za-z0-9_]*
 * shape before being placed into a statement; all row VALUES go through `?`
 * bind parameters, so user data is never interpolated into SQL text.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { client, isDesktop, toUserMessage } from '../services/novaClient';
import { DatabaseIcon, PlusIcon, RefreshIcon, TrashIcon, PlayIcon, KeyIcon, CodeIcon } from './Icons';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DATA_TYPES = ['INTEGER', 'TEXT', 'REAL', 'BOOLEAN'];

function isValidIdent(value) {
  return typeof value === 'string' && IDENT.test(value);
}

/** Build a CREATE TABLE column list from the designer's rows. */
function buildColumnSql(col) {
  const parts = [col.name, col.dataType];
  if (col.primaryKey) parts.push('PRIMARY KEY');
  if (col.notNull && !col.primaryKey) parts.push('NOT NULL');
  if (col.unique && !col.primaryKey) parts.push('UNIQUE');
  // Foreign key: `REFERENCES parent[(col)]` — the engine defaults the target
  // column to the parent's primary key when it is omitted.
  const ref = col.references;
  if (ref && isValidIdent(ref.table)) {
    parts.push('REFERENCES', ref.column && isValidIdent(ref.column) ? `${ref.table}(${ref.column})` : ref.table);
  }
  return parts.join(' ');
}

/** One editable row in the "add record" form. */
function emptyRowDraft(columns) {
  const draft = {};
  for (const c of columns) draft[c.name] = '';
  return draft;
}

// --- developer-integration snippet builders (real code, generated from the
//     current schema so what you read here is what your project would write) ---
function sampleLiteral(col) {
  switch (col.dataType) {
    case 'INTEGER': return '1';
    case 'REAL': return '1.5';
    case 'BOOLEAN': return 'false';
    default: return "'example'";
  }
}

function insertFields(table) {
  const cols = (table?.columns || []).filter((c) => !c.primaryKey).slice(0, 3);
  if (!cols.length) return "name: 'example'";
  return cols.map((c) => `${c.name}: ${sampleLiteral(c)}`).join(', ');
}

function camel(name) { return name.charAt(0).toUpperCase() + name.slice(1); }

export default function NovaDbView({ onNotify, asTab = false }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selectedDb, setSelectedDb] = useState('');
  const [selectedTable, setSelectedTable] = useState('');
  const [tableInfo, setTableInfo] = useState(null); // { columns, rows }
  const [loadingRows, setLoadingRows] = useState(false);

  // Create flows
  const [showNewDb, setShowNewDb] = useState(false);
  const [newDbName, setNewDbName] = useState('');
  const [showNewTable, setShowNewTable] = useState(false);
  const [newTableName, setNewTableName] = useState('');
  const [newColumns, setNewColumns] = useState([{ name: 'id', dataType: 'INTEGER', primaryKey: true, notNull: false, unique: false, references: { table: '', column: '' } }]);
  const [showAddRow, setShowAddRow] = useState(false);
  const [rowDraft, setRowDraft] = useState({});

  // Query editor
  const [query, setQuery] = useState('');
  const [queryResult, setQueryResult] = useState(null);

  // Developer-integration card
  const [showIntegrate, setShowIntegrate] = useState(false);

  // External connector (loopback TCP server for separate Node/Express programs)
  const [connector, setConnector] = useState(null);
  const [connectorBusy, setConnectorBusy] = useState(false);

  const refreshConnector = useCallback(async () => {
    try {
      setConnector(await client.novaDbConnectorStatus());
    } catch (err) {
      setError(toUserMessage(err));
    }
  }, []);

  // Load connector state the first time the Integrate card is opened.
  useEffect(() => {
    if (showIntegrate && connector === null) refreshConnector();
  }, [showIntegrate, connector, refreshConnector]);

  async function configureConnector(patch) {
    setConnectorBusy(true);
    try {
      setConnector(await client.novaDbConnectorConfigure(patch));
      setError('');
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setConnectorBusy(false);
    }
  }

  const refreshStatus = useCallback(async () => {
    try {
      const data = await client.novaDbStatus();
      setStatus(data);
      setError('');
      return data;
    } catch (err) {
      setError(toUserMessage(err));
      return null;
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Run a statement through the engine, then refresh the catalog snapshot.
  const runSql = useCallback(async (sql, params = []) => {
    const result = await client.novaDbExec(sql, params);
    await refreshStatus();
    return result;
  }, [refreshStatus]);

  const databases = useMemo(() => status?.databases || [], [status]);
  const activeDb = useMemo(
    () => databases.find((d) => d.name === selectedDb) || null,
    [databases, selectedDb],
  );
  const activeTable = useMemo(
    () => activeDb?.tables.find((t) => t.name === selectedTable) || null,
    [activeDb, selectedTable],
  );

  // Load the selected table's rows whenever the selection changes.
  const loadTableRows = useCallback(async (dbName, tableName) => {
    if (!isValidIdent(dbName) || !isValidIdent(tableName)) return;
    setLoadingRows(true);
    try {
      await client.novaDbExec(`USE ${dbName}`);
      const res = await client.novaDbExec(`SELECT * FROM ${tableName}`);
      setTableInfo({ columns: res.columns || [], rows: res.rows || [] });
    } catch (err) {
      setError(toUserMessage(err));
      setTableInfo(null);
    } finally {
      setLoadingRows(false);
      refreshStatus();
    }
  }, [refreshStatus]);

  useEffect(() => {
    if (selectedDb && selectedTable) loadTableRows(selectedDb, selectedTable);
    else setTableInfo(null);
  }, [selectedDb, selectedTable, loadTableRows]);

  // ---- database actions -----------------------------------------------------
  async function handleCreateDatabase() {
    const name = newDbName.trim();
    if (!isValidIdent(name)) { setError('Database name must be letters, digits or underscore, starting with a letter.'); return; }
    setBusy(true);
    try {
      await runSql(`CREATE DATABASE ${name}`);
      await runSql(`USE ${name}`);
      setSelectedDb(name);
      setSelectedTable('');
      setShowNewDb(false);
      setNewDbName('');
      onNotify?.(`Database "${name}" created`, 'ok');
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDropDatabase(dbName) {
    if (!window.confirm(`Drop database "${dbName}" and every table in it? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await runSql(`DROP DATABASE ${dbName}`);
      if (selectedDb === dbName) { setSelectedDb(''); setSelectedTable(''); setTableInfo(null); }
      onNotify?.(`Database "${dbName}" dropped`, 'ok');
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSelectDatabase(dbName) {
    setSelectedDb(dbName);
    setSelectedTable('');
    setBusy(true);
    try {
      await client.novaDbExec(`USE ${dbName}`);
      await refreshStatus();
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // ---- table actions --------------------------------------------------------
  function addColumn() {
    setNewColumns((cols) => [...cols, { name: '', dataType: 'TEXT', primaryKey: false, notNull: false, unique: false, references: { table: '', column: '' } }]);
  }

  function updateReference(index, patch) {
    setNewColumns((cols) => cols.map((c, i) => (i === index ? { ...c, references: { ...(c.references || {}), ...patch } } : c)));
  }

  function updateColumn(index, patch) {
    setNewColumns((cols) => cols.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  function removeColumn(index) {
    setNewColumns((cols) => cols.filter((_, i) => i !== index));
  }

  async function handleCreateTable() {
    const name = newTableName.trim();
    if (!isValidIdent(name)) { setError('Table name must be letters, digits or underscore, starting with a letter.'); return; }
    const columns = newColumns.map((c) => ({ ...c, name: c.name.trim() })).filter((c) => c.name);
    if (!columns.length) { setError('Add at least one column.'); return; }
    if (!columns.every((c) => isValidIdent(c.name))) { setError('Every column name must be letters, digits or underscore.'); return; }
    if (!activeDb) { setError('Select or create a database first.'); return; }
    setBusy(true);
    try {
      const cols = columns.map(buildColumnSql).join(', ');
      await runSql(`USE ${activeDb.name}`);
      await runSql(`CREATE TABLE ${name} (${cols})`);
      setShowNewTable(false);
      setNewTableName('');
      setNewColumns([{ name: 'id', dataType: 'INTEGER', primaryKey: true, notNull: false, unique: false, references: { table: '', column: '' } }]);
      setSelectedTable(name);
      onNotify?.(`Table "${name}" created`, 'ok');
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDropTable(dbName, tableName) {
    if (!window.confirm(`Drop table "${tableName}"?`)) return;
    setBusy(true);
    try {
      await runSql(`USE ${dbName}`);
      await runSql(`DROP TABLE ${tableName}`);
      if (selectedTable === tableName) { setSelectedTable(''); setTableInfo(null); }
      onNotify?.(`Table "${tableName}" dropped`, 'ok');
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // ---- record actions -------------------------------------------------------
  function openAddRow() {
    if (!activeTable) return;
    setRowDraft(emptyRowDraft(activeTable.columns));
    setShowAddRow(true);
  }

  async function handleInsertRow() {
    if (!activeTable) return;
    const cols = activeTable.columns;
    // Skip blank fields so INTEGER primary keys auto-increment and columns take
    // their default / NULL. Everything kept goes in as a bind parameter.
    const used = cols.filter((c) => String(rowDraft[c.name] ?? '').trim() !== '' || c.notNull);
    const names = used.map((c) => c.name);
    const values = used.map((c) => String(rowDraft[c.name] ?? '').trim());
    if (!names.length) { setError('Fill in at least one field.'); return; }
    const sql = `INSERT INTO ${activeTable.name} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`;
    setBusy(true);
    try {
      await runSql(`USE ${activeDb.name}`);
      await runSql(sql, values);
      setShowAddRow(false);
      await loadTableRows(activeDb.name, activeTable.name);
      onNotify?.('Record added', 'ok');
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteRow(row) {
    const pk = activeTable?.columns.find((c) => c.primaryKey);
    if (!pk) { setError('This table has no primary key, so single-row delete is unavailable.'); return; }
    if (row[pk.name] === null || row[pk.name] === undefined) { setError('Cannot delete a row without a primary key value.'); return; }
    setBusy(true);
    try {
      await runSql(`USE ${activeDb.name}`);
      await runSql(`DELETE FROM ${activeTable.name} WHERE ${pk.name} = ?`, [row[pk.name]]);
      await loadTableRows(activeDb.name, activeTable.name);
      onNotify?.('Record deleted', 'ok');
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // ---- query editor ---------------------------------------------------------
  async function handleRunQuery() {
    const text = query.trim();
    if (!text) return;
    setBusy(true);
    try {
      const result = await client.novaDbExec(text);
      setQueryResult(result);
      setError('');
      await refreshStatus();
    } catch (err) {
      setQueryResult(null);
      setError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const storageNote = status?.storagePath
    ? `Stored at ${status.storagePath}`
    : 'Storage path unavailable';

  // Generate real, copy-pasteable integration code from the current schema.
  const tables = activeDb?.tables || [];
  const dbUse = activeDb?.name || 'app';
  const t1 = tables[0] || null;
  const t1name = t1?.name || 'todos';
  const t1pk = t1?.columns?.find((c) => c.primaryKey)?.name || 'id';
  const fields = insertFields(t1);
  const nonPk = t1?.columns?.find((c) => !c.primaryKey)?.name || 'name';
  const t2 = tables.find((t) => t !== t1) || null;

  const rawExample =
`import { novaDb } from '../services/novaDbClient';

// Point at the database the GUI and the "novadb" terminal command share:
await novaDb.use('${dbUse}');

// Insert a record - values are always bound with ? , never concatenated:
await novaDb.insert('${t1name}', { ${fields} });

// Read it back:
const rows  = await novaDb.all('SELECT * FROM ${t1name}');
const first = await novaDb.get('SELECT * FROM ${t1name} WHERE ${t1pk} = ?', [1]);
const total = await novaDb.count('${t1name}');`;

  const modelExample =
`// Bind one table into a small CRUD model (all methods are async):
const ${camel(t1name)} = novaDb.model('${t1name}');

await ${camel(t1name)}.insert({ ${fields} });
const item  = await ${camel(t1name)}.get(1);
await ${camel(t1name)}.update(1, { ${nonPk}: 'changed' });
await ${camel(t1name)}.remove(1);`;

  const relationExample = t2
    ? `// Foreign keys are enforced by the engine: a child row must point at an
// existing parent, and a parent cannot be deleted while children reference it.

// Query across the relationship with a JOIN:
const joined = await novaDb.all(
  'SELECT * FROM ${t1name} JOIN ${t2.name} ON ${t1name}.${t1pk} = ${t2.name}.<their_fk_column>'
);`
    : `// Design a second table with a column that REFERENCES ${t1name}(${t1pk}) in
// the table designer to create a relationship, then JOIN across both tables:
const joined = await novaDb.all(
  'SELECT * FROM ${t1name} JOIN other ON ${t1name}.${t1pk} = other.${t1name}_id'
);`;

  // External connector defaults (used in the snippet before the first status load).
  const cHost = connector?.host || '127.0.0.1';
  const cPort = connector?.port || 33607;
  const cToken = connector?.token || '<TOKEN>';

  const externalExample =
`// A SEPARATE Node / Express program (not inside NovaCode).
// Copy novadb-client.js next to your file, then:
import express from 'express';
import { createNovaDb } from './novadb-client.js';

const novaDb = await createNovaDb({
  host: '${cHost}',
  port: ${cPort},
  token: '${cToken}',   // keep NovaCode running with the connector enabled
});

await novaDb.use('${dbUse}');
await novaDb.insert('${t1name}', { ${fields} });
const rows = await novaDb.all('SELECT * FROM ${t1name}');`;

  return (
    <div className={`novadb-panel${asTab ? ' ndb-tab' : ''}`} aria-label="NovaDB Database workspace">
      <header className="ndb-header">
        <div className="ndb-title">
          <DatabaseIcon size={18} />
          <span>Database</span>
          <span className="ndb-badge">NovaDB</span>
        </div>
        <div className="ndb-header-actions">
          <button type="button" className="small" onClick={() => refreshStatus()} disabled={busy}>
            <RefreshIcon size={13} /> Refresh
          </button>
        </div>
      </header>

      {!isDesktop && (
        <div className="ndb-notice">
          NovaDB runs in the desktop app. Launch it with “npm run dev” or the installed build to create and browse databases.
        </div>
      )}

      {error && <div className="ndb-error" role="alert">{error}</div>}

      <div className="ndb-body">
        {/* ---- catalog column ---- */}
        <aside className="ndb-catalog">
          <div className="ndb-catalog-head">
            <span className="ndb-section-label">Databases</span>
            <button type="button" className="icon-button" title="New database" aria-label="New database"
              onClick={() => { setShowNewDb(true); setError(''); }} disabled={!isDesktop}>
              <PlusIcon size={14} />
            </button>
          </div>

          {showNewDb && (
            <div className="ndb-inline-form">
              <input autoFocus value={newDbName} placeholder="database name"
                onChange={(e) => setNewDbName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateDatabase()} />
              <div className="ndb-inline-form-actions">
                <button type="button" className="small primary" onClick={handleCreateDatabase} disabled={busy}>Create</button>
                <button type="button" className="small" onClick={() => { setShowNewDb(false); setNewDbName(''); }}>Cancel</button>
              </div>
            </div>
          )}

          {databases.length === 0 && !showNewDb && (
            <p className="ndb-empty muted">No databases yet. Click + to create one — no SQL required.</p>
          )}

          <ul className="ndb-tree">
            {databases.map((db) => (
              <li key={db.name} className="ndb-db-item">
                <button type="button"
                  className={db.name === selectedDb ? 'ndb-db-name active' : 'ndb-db-name'}
                  onClick={() => handleSelectDatabase(db.name)}
                  title={db.isCurrent ? 'Current database' : 'Switch to this database'}>
                  <DatabaseIcon size={13} />
                  <span>{db.name}</span>
                  {db.isCurrent && <span className="ndb-current">●</span>}
                </button>
                <button type="button" className="icon-button ndb-db-add" title="New table" aria-label="New table"
                  onClick={() => { setSelectedDb(db.name); setShowNewTable(true); setError(''); }} disabled={!isDesktop}>
                  <PlusIcon size={13} />
                </button>
                <button type="button" className="icon-button ndb-db-del" title="Drop database" aria-label="Drop database"
                  onClick={() => handleDropDatabase(db.name)} disabled={busy}>
                  <TrashIcon size={13} />
                </button>

                {db.name === selectedDb && (
                  <ul className="ndb-tables">
                    {db.tables.length === 0 && <li className="ndb-empty muted tiny">No tables. Use + to design one.</li>}
                    {db.tables.map((t) => (
                      <li key={t.name} className="ndb-table-item">
                        <button type="button"
                          className={t.name === selectedTable ? 'ndb-table-name active' : 'ndb-table-name'}
                          onClick={() => setSelectedTable(t.name)}>
                          <span>{t.name}</span>
                          <span className="ndb-rowcount muted tiny">{t.rowCount}</span>
                        </button>
                        <button type="button" className="icon-button ndb-table-del" title="Drop table" aria-label="Drop table"
                          onClick={() => handleDropTable(db.name, t.name)} disabled={busy}>
                          <TrashIcon size={12} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>

          <p className="ndb-storage muted tiny">{storageNote}</p>
        </aside>

        {/* ---- detail column ---- */}
        <section className="ndb-detail">
          {showNewTable && activeDb && (
            <div className="ndb-card ndb-designer">
              <div className="ndb-card-head">
                <span className="ndb-section-label">New table in “{activeDb.name}”</span>
                <button type="button" className="icon-button" title="Close" aria-label="Close"
                  onClick={() => setShowNewTable(false)}>✕</button>
              </div>
              <input className="ndb-table-name-input" value={newTableName} placeholder="table name"
                onChange={(e) => setNewTableName(e.target.value)} />
              <div className="ndb-cols-editor">
                <div className="ndb-col-row ndb-col-head">
                  <span>Column</span><span>Type</span><span>PK</span><span>NOT NULL</span><span>UNIQUE</span><span>References</span><span></span>
                </div>
                {newColumns.map((col, i) => {
                  const refTable = col.references?.table || '';
                  const parentCols = activeDb?.tables.find((t) => t.name === refTable)?.columns || [];
                  return (
                    <div className="ndb-col-row" key={i}>
                      <input value={col.name} placeholder="name" onChange={(e) => updateColumn(i, { name: e.target.value })} />
                      <select value={col.dataType} onChange={(e) => updateColumn(i, { dataType: e.target.value })}>
                        {DATA_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <input type="checkbox" checked={col.primaryKey} onChange={(e) => updateColumn(i, { primaryKey: e.target.checked, notNull: e.target.checked ? false : col.notNull })} />
                      <input type="checkbox" checked={col.notNull} disabled={col.primaryKey} onChange={(e) => updateColumn(i, { notNull: e.target.checked })} />
                      <input type="checkbox" checked={col.unique} disabled={col.primaryKey} onChange={(e) => updateColumn(i, { unique: e.target.checked })} />
                      <div className="ndb-ref-cell">
                        <select value={refTable} disabled={col.primaryKey} title="Referenced (parent) table"
                          onChange={(e) => updateReference(i, { table: e.target.value, column: '' })}>
                          <option value="">— none —</option>
                          {(activeDb?.tables || []).filter((t) => t.name !== newTableName.trim()).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                        </select>
                        {refTable && (
                          <select value={col.references?.column || ''} title="Referenced column (defaults to primary key)"
                            onChange={(e) => updateReference(i, { column: e.target.value })}>
                            <option value="">(pk)</option>
                            {parentCols.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                          </select>
                        )}
                      </div>
                      <button type="button" className="icon-button" title="Remove column" aria-label="Remove column"
                        onClick={() => removeColumn(i)} disabled={newColumns.length === 1}>
                        <TrashIcon size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="ndb-designer-actions">
                <button type="button" className="small" onClick={addColumn} disabled={busy}><PlusIcon size={13} /> Add column</button>
                <button type="button" className="small primary" onClick={handleCreateTable} disabled={busy}>Create table</button>
              </div>
            </div>
          )}

          {!activeTable && !showNewTable && (
            <div className="ndb-placeholder">
              <DatabaseIcon size={40} />
              <h3>NovaDB Workspace</h3>
              <p className="muted">Create a database, design a table and add records — all visually, without writing SQL. Select a table on the left to browse its records.</p>
            </div>
          )}

          {activeTable && (
            <div className="ndb-card">
              <div className="ndb-card-head">
                <div>
                  <span className="ndb-table-title">{activeDb.name}.{activeTable.name}</span>
                  <span className="ndb-rowcount muted tiny">{tableInfo ? tableInfo.rows.length : activeTable.rowCount} record(s)</span>
                </div>
                <button type="button" className="small primary" onClick={openAddRow} disabled={busy || !isDesktop}>
                  <PlusIcon size={13} /> Add record
                </button>
              </div>

              {showAddRow && (
                <div className="ndb-add-form">
                  {activeTable.columns.map((c) => (
                    <label className="ndb-field" key={c.name}>
                      <span className="muted tiny">
                        {c.name} · {c.dataType}{c.primaryKey ? ' · PK' : ''}{c.notNull ? ' · required' : ''}
                      </span>
                      {c.dataType === 'BOOLEAN' ? (
                        <select value={rowDraft[c.name] ?? ''} onChange={(e) => setRowDraft((d) => ({ ...d, [c.name]: e.target.value }))}>
                          <option value="">(unset)</option>
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : (
                        <input
                          type={c.dataType === 'INTEGER' || c.dataType === 'REAL' ? 'number' : 'text'}
                          value={rowDraft[c.name] ?? ''}
                          placeholder={c.primaryKey && c.dataType === 'INTEGER' ? 'auto' : ''}
                          onChange={(e) => setRowDraft((d) => ({ ...d, [c.name]: e.target.value }))}
                        />
                      )}
                    </label>
                  ))}
                  <div className="ndb-add-actions">
                    <button type="button" className="small primary" onClick={handleInsertRow} disabled={busy}>Save record</button>
                    <button type="button" className="small" onClick={() => setShowAddRow(false)}>Cancel</button>
                  </div>
                </div>
              )}

              <div className="ndb-grid-wrap">
                <table className="ndb-grid">
                  <thead>
                    <tr>
                      {activeTable.columns.map((c) => (
                        <th key={c.name}>
                          {c.name}<span className="ndb-coltype">{c.dataType}</span>
                          {c.primaryKey && <span className="ndb-fk" title="Primary key"><KeyIcon size={11} />PK</span>}
                          {c.references && (
                            <span className="ndb-fk" title={`Foreign key → ${c.references.table}.${c.references.column}`}>
                              <KeyIcon size={11} /><span className="ndb-th-fk">→ {c.references.table}.{c.references.column}</span>
                            </span>
                          )}
                        </th>
                      ))}
                      <th className="ndb-col-actions"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {loadingRows && <tr><td className="muted" colSpan={activeTable.columns.length + 1}>Loading…</td></tr>}
                    {!loadingRows && tableInfo && tableInfo.rows.length === 0 && (
                      <tr><td className="muted" colSpan={activeTable.columns.length + 1}>No records yet — add one above.</td></tr>
                    )}
                    {!loadingRows && tableInfo && tableInfo.rows.map((row, i) => (
                      <tr key={i}>
                        {activeTable.columns.map((c) => (
                          <td key={c.name}>{row[c.name] === null || row[c.name] === undefined ? <span className="ndb-null">NULL</span> : String(row[c.name])}</td>
                        ))}
                        <td className="ndb-col-actions">
                          <button type="button" className="icon-button" title="Delete record" aria-label="Delete record"
                            onClick={() => handleDeleteRow(row)} disabled={busy}>
                            <TrashIcon size={12} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ---- query editor (works with the same statements as the terminal) ---- */}
          <div className="ndb-card ndb-query">
            <div className="ndb-card-head"><span className="ndb-section-label">Query editor</span></div>
            <textarea
              className="ndb-query-input"
              rows={3}
              spellCheck={false}
              value={query}
              placeholder='e.g. SELECT * FROM students WHERE age > ?  ·  or  INSERT INTO notes (text) VALUES (?)'
              onChange={(e) => setQuery(e.target.value)}
              disabled={!isDesktop}
            />
            <div className="ndb-query-actions">
              <button type="button" className="small primary" onClick={handleRunQuery} disabled={busy || !isDesktop}>
                <PlayIcon size={13} /> Run
              </button>
              {queryResult && (
                <span className="muted tiny">
                  {queryResult.type === 'select'
                    ? `${queryResult.rowCount ?? queryResult.rows?.length ?? 0} row(s)`
                    : (queryResult.message || `${queryResult.affectedRows ?? 0} affected`)}
                </span>
              )}
            </div>
            {queryResult && queryResult.columns && queryResult.rows && (
              <div className="ndb-grid-wrap ndb-result-wrap">
                <table className="ndb-grid">
                  <thead><tr>{queryResult.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>
                    {queryResult.rows.length === 0 && <tr><td className="muted" colSpan={queryResult.columns.length}>No rows returned.</td></tr>}
                    {queryResult.rows.map((row, i) => (
                      <tr key={i}>{queryResult.columns.map((c) => <td key={c}>{row[c] === null || row[c] === undefined ? <span className="ndb-null">NULL</span> : String(row[c])}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ---- developer integration (real, schema-aware snippets) ---- */}
          <div className="ndb-card ndb-integrate">
            <div className="ndb-card-head">
              <span className="ndb-section-label"><CodeIcon size={14} /> Integrate with your project</span>
              <button type="button" className="small" onClick={() => setShowIntegrate((v) => !v)}>
                {showIntegrate ? 'Hide' : 'Show'} code
              </button>
            </div>
            {showIntegrate && (
              <>
                <p className="ndb-integrate-note">
                  Your app talks to the same NovaDB engine through the <code>novaDbClient</code> SDK
                  (<code>src/services/novaDbClient.js</code>). Every value is bound with <code>?</code> and every
                  identifier is validated, so nothing below is string-interpolated user data. The examples use
                  your current <strong>{dbUse}</strong> schema.
                </p>

                <div className="ndb-integrate-label">1 · Basic queries</div>
                <pre>{rawExample}</pre>

                <div className="ndb-integrate-label">2 · A table as a CRUD model</div>
                <pre>{modelExample}</pre>

                <div className="ndb-integrate-label">3 · Relationships (foreign keys &amp; JOINs)</div>
                <pre>{relationExample}</pre>

                <div className="ndb-integrate-label">4 · Multi-step transaction</div>
                <pre>{`// All-or-nothing: if the callback throws, everything rolls back.
await novaDb.transaction(async () => {
  await novaDb.insert('${t1name}', { ${fields} });
  await novaDb.update('${t1name}', { ${nonPk}: 'updated' }, '${t1pk} = ?', [1]);
});`}</pre>

                <div className="ndb-integrate-label">5 · External connector (connect a separate program)</div>
                <div className="ndb-connector">
                  <div className="ndb-connector-row">
                    <span className="ndb-connector-state">
                      <span className={`ndb-dot${connector?.running ? ' on' : ''}`} aria-hidden="true" />
                      {connector?.running
                        ? 'Running'
                        : connector?.enabled
                          ? 'Enabled (not started)'
                          : 'Disabled'}
                    </span>
                    <label className="ndb-switch">
                      <input
                        type="checkbox"
                        checked={Boolean(connector?.enabled)}
                        disabled={connectorBusy || !isDesktop}
                        onChange={(e) => configureConnector({ enabled: e.target.checked })}
                      />
                      <span>Enable connector</span>
                    </label>
                  </div>

                  {connector?.enabled && (
                    <dl className="ndb-connector-info">
                      <div><dt>Host</dt><dd>{connector.host}</dd></div>
                      <div><dt>Port</dt><dd>{connector.port}</dd></div>
                      <div>
                        <dt>Token</dt>
                        <dd>
                          <code className="ndb-token">{connector.token || ''}</code>
                          <button
                            type="button"
                            className="small"
                            disabled={connectorBusy}
                            onClick={() => navigator.clipboard?.writeText(connector.token || '')}
                          >
                            Copy
                          </button>
                        </dd>
                      </div>
                    </dl>
                  )}

                  <div className="ndb-connector-actions">
                    <button
                      type="button"
                      className="small"
                      disabled={connectorBusy || !isDesktop}
                      onClick={() => configureConnector({ regenerateToken: true })}
                    >
                      Regenerate token
                    </button>
                    <button type="button" className="small" disabled={connectorBusy} onClick={refreshConnector}>
                      <RefreshIcon size={13} /> Refresh
                    </button>
                  </div>

                  <p className="ndb-connector-note">
                    Loopback-only (127.0.0.1) and token-authenticated — it never opens your database to the
                    network. Keep NovaCode running, copy <code>novadb-client.js</code> (repo root) into your
                    project, then use the settings above:
                  </p>
                  <pre>{externalExample}</pre>
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
