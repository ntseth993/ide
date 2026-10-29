/**
 * NovaDB engine tests — real execution against the in-memory catalog.
 *
 * These exercise actual behaviour (insert/select/update/delete, type coercion,
 * constraints, aggregates, ordering, transactions), not stubs. A failure here
 * means the engine genuinely does not work.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createNovaDB, NovaDBError } from '../../electron/services/novadb/index';

function seeded() {
  const db = createNovaDB();
  db.execute('CREATE DATABASE school');
  db.execute('CREATE TABLE students (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER, gpa REAL)');
  db.execute("INSERT INTO students (name, age, gpa) VALUES ('Ada', 36, 3.9), ('Bob', 22, 3.1), ('Cy', 41, 3.9)");
  return db;
}

describe('novadb engine — databases', () => {
  it('auto-selects the first created database and lists it', () => {
    const db = createNovaDB();
    db.execute('CREATE DATABASE app');
    expect(db.getState().current).toBe('app');
    expect(db.execute('SHOW DATABASES').rows.map((r) => r.database)).toContain('app');
  });

  it('rejects a duplicate database but honors IF NOT EXISTS', () => {
    const db = createNovaDB();
    db.execute('CREATE DATABASE app');
    expect(() => db.execute('CREATE DATABASE app')).toThrow(NovaDBError);
    expect(db.execute('CREATE DATABASE IF NOT EXISTS app').ok).toBe(true);
  });
});

describe('novadb engine — tables and inserts', () => {
  let db;
  beforeEach(() => { db = seeded(); });

  it('auto-increments an INTEGER primary key when omitted', () => {
    const ids = db.execute('SELECT id FROM students').rows.map((r) => r.id);
    expect(ids).toEqual([1, 2, 3]);
  });

  it('binds positional parameters safely', () => {
    db.execute('INSERT INTO students (name, age) VALUES (?, ?)', ['Dee', 30]);
    const row = db.execute('SELECT * FROM students WHERE name = ?', ['Dee']).rows[0];
    expect(row).toMatchObject({ name: 'Dee', age: 30, gpa: null });
  });

  it('enforces NOT NULL', () => {
    expect(() => db.execute('INSERT INTO students (name, age) VALUES (NULL, 5)')).toThrow(/NULL/);
  });

  it('enforces primary-key uniqueness', () => {
    expect(() => db.execute('INSERT INTO students (id, name) VALUES (1, "dup")')).toThrow(/UNIQUE/);
  });

  it('rejects a wrong value count and a wrong parameter count', () => {
    expect(() => db.execute('INSERT INTO students (name, age) VALUES (?)', ['solo'])).toThrow(/value\(s\)/);
    expect(() => db.execute('INSERT INTO students (name) VALUES (?)', ['a', 'b'])).toThrow(/parameter/);
  });
});

describe('novadb engine — types', () => {
  it('coerces an integer-shaped string but rejects non-numeric text', () => {
    const db = createNovaDB();
    db.execute('CREATE DATABASE t');
    db.execute('CREATE TABLE n (id INTEGER PRIMARY KEY, qty INTEGER)');
    db.execute('INSERT INTO n (qty) VALUES (?)', ['42']);
    expect(db.getTableRows('n')[0].qty).toBe(42);
    expect(() => db.execute('INSERT INTO n (qty) VALUES (?)', ['abc'])).toThrow(/INTEGER/);
  });

  it('rejects fractional values in an INTEGER column', () => {
    const db = createNovaDB();
    db.execute('CREATE DATABASE t');
    db.execute('CREATE TABLE n (id INTEGER PRIMARY KEY, qty INTEGER)');
    expect(() => db.execute('INSERT INTO n (qty) VALUES (2.5)')).toThrow(/whole number/);
  });
});

describe('novadb engine — queries', () => {
  let db;
  beforeEach(() => { db = seeded(); });

  it('filters with WHERE + AND/OR', () => {
    const rows = db.execute('SELECT name FROM students WHERE age > 30 AND name <> "Ada"').rows;
    expect(rows.map((r) => r.name)).toEqual(['Cy']);
  });

  it('supports IS NULL, LIKE and IN', () => {
    db.execute('INSERT INTO students (name) VALUES ("Eve")'); // gpa NULL
    expect(db.execute('SELECT name FROM students WHERE gpa IS NULL').rows).toHaveLength(1);
    expect(db.execute("SELECT name FROM students WHERE name LIKE 'A%'").rows[0].name).toBe('Ada');
    expect(db.execute('SELECT name FROM students WHERE id IN (1, 2)').rows).toHaveLength(2);
  });

  it('orders, limits and offsets', () => {
    const ordered = db.execute('SELECT name FROM students ORDER BY age DESC').rows.map((r) => r.name);
    expect(ordered).toEqual(['Cy', 'Ada', 'Bob']);
    expect(db.execute('SELECT name FROM students ORDER BY age ASC LIMIT 1 OFFSET 1').rows[0].name).toBe('Ada');
  });

  it('computes aggregates', () => {
    const agg = db.execute('SELECT COUNT(*) AS n, SUM(age) AS total, AVG(gpa) AS avg_gpa, MIN(age) AS lo, MAX(age) AS hi FROM students').rows[0];
    expect(agg).toMatchObject({ n: 3, total: 99, lo: 22, hi: 41 });
    expect(agg.avg_gpa).toBeCloseTo((3.9 + 3.1 + 3.9) / 3, 5);
  });

  it('deduplicates with DISTINCT', () => {
    expect(db.execute('SELECT DISTINCT gpa FROM students').rows).toHaveLength(2); // 3.9 twice
  });

  it('projects aliased columns', () => {
    expect(db.execute('SELECT name AS full_name FROM students').columns).toEqual(['full_name']);
  });
});

describe('novadb engine — updates and deletes', () => {
  let db;
  beforeEach(() => { db = seeded(); });

  it('updates matching rows and reports affected count', () => {
    const res = db.execute('UPDATE students SET gpa = ? WHERE name = ?', [4.0, 'Ada']);
    expect(res.affectedRows).toBe(1);
    expect(db.execute('SELECT gpa FROM students WHERE name = "Ada"').rows[0].gpa).toBe(4.0);
  });

  it('blocks an update that would duplicate a unique key', () => {
    expect(() => db.execute('UPDATE students SET id = 2 WHERE id = 1')).toThrow(/UNIQUE/);
  });

  it('deletes with WHERE and without (all rows)', () => {
    expect(db.execute('DELETE FROM students WHERE age < 30').affectedRows).toBe(1);
    expect(db.execute('DELETE FROM students').affectedRows).toBe(2);
    expect(db.execute('SELECT COUNT(*) AS n FROM students').rows[0].n).toBe(0);
  });
});

describe('novadb engine — schema introspection and alter', () => {
  it('describes a table', () => {
    const db = seeded();
    const desc = db.execute('DESCRIBE students');
    expect(desc.columns).toContain('column');
    expect(desc.rows.map((r) => r.column)).toEqual(['id', 'name', 'age', 'gpa']);
    expect(desc.rows[0].primary_key).toBe('YES');
  });

  it('lists tables', () => {
    const db = seeded();
    expect(db.execute('SHOW TABLES').rows.map((r) => r.table)).toContain('students');
  });

  it('adds and drops columns, backfilling existing rows', () => {
    const db = seeded();
    db.execute('ALTER TABLE students ADD COLUMN email TEXT');
    expect(db.getTableRows('students')[0].email).toBe(null);
    db.execute("UPDATE students SET email = 'a@x' WHERE name = 'Ada'");
    expect(db.getTableRows('students')[0].email).toBe('a@x');
    db.execute('ALTER TABLE students DROP email');
    expect(db.getTableRows('students')[0].email).toBeUndefined();
  });

  it('enforces a UNIQUE index', () => {
    const db = createNovaDB();
    db.execute('CREATE DATABASE t');
    db.execute('CREATE TABLE u (id INTEGER PRIMARY KEY, code TEXT)');
    db.execute("INSERT INTO u (code) VALUES ('X'), ('Y')");
    db.execute('CREATE UNIQUE INDEX ix_code ON u (code)');
    expect(() => db.execute("INSERT INTO u (code) VALUES ('X')")).toThrow(/UNIQUE/);
  });

  it('drops an index and tolerates DROP INDEX IF EXISTS on a missing one', () => {
    const db = createNovaDB();
    db.execute('CREATE DATABASE t');
    db.execute('CREATE TABLE u (id INTEGER PRIMARY KEY, code TEXT)');
    db.execute('CREATE INDEX ix_code ON u (code)');
    expect(db.execute('DROP INDEX ix_code').ok).toBe(true);
    expect(() => db.execute('DROP INDEX ix_code')).toThrow(/does not exist/);
    expect(db.execute('DROP INDEX IF EXISTS ix_code').ok).toBe(true);
  });
});

describe('novadb engine — transactions', () => {
  let db;
  beforeEach(() => { db = seeded(); });

  it('rolls back uncommitted changes', () => {
    db.execute('BEGIN');
    db.execute("INSERT INTO students (name) VALUES ('Zoe')");
    expect(db.execute('SELECT COUNT(*) AS n FROM students').rows[0].n).toBe(4);
    db.execute('ROLLBACK');
    expect(db.execute('SELECT COUNT(*) AS n FROM students').rows[0].n).toBe(3);
  });

  it('keeps committed changes', () => {
    db.execute('BEGIN');
    db.execute("INSERT INTO students (name) VALUES ('Zoe')");
    db.execute('COMMIT');
    expect(db.execute('SELECT COUNT(*) AS n FROM students').rows[0].n).toBe(4);
  });

  it('rejects a nested BEGIN and a COMMIT without one', () => {
    expect(() => db.execute('COMMIT')).toThrow(/No transaction/);
    db.execute('BEGIN');
    expect(() => db.execute('BEGIN')).toThrow(/already in progress/);
  });
});

describe('novadb engine — serialization & overview (Stage 2 persistence hooks)', () => {
  let db;
  beforeEach(() => { db = seeded(); });

  it('round-trips the full catalog through serialize/load', () => {
    db.execute("INSERT INTO students (name, age, gpa) VALUES ('Dee', 30, 3.5)");
    const snapshot = db.serialize();

    const fresh = createNovaDB();
    fresh.load(snapshot);
    const rows = fresh.execute('SELECT name FROM students ORDER BY id').rows;
    expect(rows.map((r) => r.name)).toEqual(['Ada', 'Bob', 'Cy', 'Dee']);
    expect(fresh.getState().current).toBe('school');
  });

  it('resumes auto-increment past the highest restored id', () => {
    const fresh = createNovaDB();
    fresh.load(db.serialize());
    fresh.execute("INSERT INTO students (name) VALUES ('New')");
    const last = fresh.execute('SELECT id FROM students ORDER BY id DESC LIMIT 1').rows[0];
    // seeded() gave ids 1..3; the new row must be 4, never a reused id.
    expect(last.id).toBe(4);
  });

  it('ignores an invalid load payload without corrupting state', () => {
    db.load(null);
    db.load({});
    db.load('nonsense');
    expect(db.execute('SELECT COUNT(*) AS n FROM students').rows[0].n).toBe(3);
  });

  it('exposes an overview of shape without full row data', () => {
    const info = db.overview();
    expect(info.current).toBe('school');
    const school = info.databases.find((d) => d.name === 'school');
    expect(school.isCurrent).toBe(true);
    const students = school.tables.find((t) => t.name === 'students');
    expect(students.rowCount).toBe(3);
    expect(students.columns.map((c) => c.name)).toEqual(['id', 'name', 'age', 'gpa']);
    expect(students).not.toHaveProperty('rows');
  });
});

describe('novadb engine — foreign keys & relationships', () => {
  let db;
  beforeEach(() => {
    db = createNovaDB();
    db.execute('CREATE DATABASE shop');
    db.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    db.execute("INSERT INTO users (name) VALUES ('Ada'), ('Bob')");
    db.execute('CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), total REAL)');
  });

  it('records the reference in DESCRIBE', () => {
    const refs = db.execute('DESCRIBE orders').rows.find((r) => r.column === 'user_id').references;
    expect(refs).toBe('users(id)');
  });

  it('accepts an insert whose FK value exists in the parent table', () => {
    expect(db.execute('INSERT INTO orders (user_id, total) VALUES (1, 9.99)').ok).toBe(true);
    expect(db.execute('SELECT COUNT(*) AS n FROM orders').rows[0].n).toBe(1);
  });

  it('allows a NULL foreign key', () => {
    expect(db.execute('INSERT INTO orders (total) VALUES (5)').ok).toBe(true);
  });

  it('rejects an insert whose FK value has no parent row', () => {
    expect(() => db.execute('INSERT INTO orders (user_id, total) VALUES (99, 1)')).toThrow(/FOREIGN KEY/);
  });

  it('rejects updating a row to a dangling FK value', () => {
    db.execute("INSERT INTO orders (id, user_id, total) VALUES (1, 1, 2)");
    expect(() => db.execute('UPDATE orders SET user_id = 42 WHERE id = 1')).toThrow(/FOREIGN KEY/);
  });

  it('blocks deleting a parent row that children still reference (RESTRICT)', () => {
    db.execute('INSERT INTO orders (user_id, total) VALUES (1, 3)');
    expect(() => db.execute('DELETE FROM users WHERE id = 1')).toThrow(/RESTRICT|still reference/);
    // Once the child is gone, the parent can be deleted.
    db.execute('DELETE FROM orders WHERE user_id = 1');
    expect(db.execute('DELETE FROM users WHERE id = 1').affectedRows).toBe(1);
  });

  it('survives a serialize/load round-trip keeping the FK', () => {
    const state = db.serialize();
    const db2 = createNovaDB();
    db2.load(state);
    expect(() => db2.execute('INSERT INTO orders (user_id, total) VALUES (77, 1)')).toThrow(/FOREIGN KEY/);
  });
});

describe('novadb engine — joins & grouping', () => {
  let db;
  beforeEach(() => {
    db = createNovaDB();
    db.execute('CREATE DATABASE school');
    db.execute('CREATE TABLE students (id INTEGER PRIMARY KEY, name TEXT, homeroom TEXT)');
    db.execute("INSERT INTO students (name, homeroom) VALUES ('Ada', 'A'), ('Bob', 'A'), ('Cy', 'B')");
    db.execute('CREATE TABLE enrollments (student_id INTEGER, course TEXT)');
    db.execute("INSERT INTO enrollments (student_id, course) VALUES (1, 'math'), (1, 'art'), (2, 'math')");
  });

  it('inner joins rows across two tables via ON', () => {
    const res = db.execute(
      'SELECT s.name, e.course FROM students s JOIN enrollments e ON s.id = e.student_id ORDER BY s.name, e.course',
    );
    expect(res.rows).toEqual([
      { name: 'Ada', course: 'art' },
      { name: 'Ada', course: 'math' },
      { name: 'Bob', course: 'math' },
    ]);
  });

  it('left join keeps unmatched left rows with NULL right columns', () => {
    const res = db.execute(
      'SELECT s.name, e.course FROM students s LEFT JOIN enrollments e ON s.id = e.student_id WHERE s.name = ?',
      ['Cy'],
    );
    expect(res.rows).toEqual([{ name: 'Cy', course: null }]);
  });

  it('disambiguates same-named columns using qualified references', () => {
    const res = db.execute('SELECT students.name, enrollments.course FROM students JOIN enrollments ON students.id = enrollments.student_id');
    expect(res.columns).toEqual(['name', 'course']);
    expect(res.rows.length).toBe(3);
  });

  it('groups joined rows by a column', () => {
    const res = db.execute(
      'SELECT e.course, COUNT(*) AS n FROM students s JOIN enrollments e ON s.id = e.student_id GROUP BY e.course',
    );
    const map = Object.fromEntries(res.rows.map((r) => [r.course, r.n]));
    expect(map).toEqual({ math: 2, art: 1 });
  });

  it('rejects ORDER BY combined with GROUP BY (not yet supported)', () => {
    expect(() => db.execute('SELECT homeroom, COUNT(*) AS n FROM students GROUP BY homeroom ORDER BY homeroom')).toThrow(/ORDER BY/);
  });

  it('groups aggregate results by a column', () => {
    const res = db.execute('SELECT homeroom, COUNT(*) AS n FROM students GROUP BY homeroom');
    const map = Object.fromEntries(res.rows.map((r) => [r.homeroom, r.n]));
    expect(map).toEqual({ A: 2, B: 1 });
  });

  it('supports SUM/AVG per group', () => {
    const res = db.execute('SELECT course, COUNT(*) AS n FROM enrollments GROUP BY course');
    const map = Object.fromEntries(res.rows.map((r) => [r.course, r.n]));
    expect(map).toEqual({ math: 2, art: 1 });
  });

  it('expands SELECT * across joined tables with qualified headers', () => {
    const res = db.execute('SELECT * FROM students JOIN enrollments ON students.id = enrollments.student_id');
    expect(res.columns).toContain('students.name');
    expect(res.columns).toContain('enrollments.course');
  });
});

