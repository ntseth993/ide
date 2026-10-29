/**
 * NovaDB developer SDK tests — verify the SQL the SDK generates and that the
 * identifier / parameter guards actually fire. The bridge is mocked, so these
 * assert the SDK's contract (safe SQL, bind params, row shaping), not the engine.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];

vi.mock('../src/services/novaClient', () => ({
  client: {
    novaDbExec: vi.fn(async (sql, params = []) => {
      calls.push({ sql, params });
      return { ok: true, type: 'select', columns: ['id'], rows: [{ id: 1 }, { id: 2 }], rowCount: 2, affectedRows: 1 };
    }),
  },
  isDesktop: true,
  toUserMessage: (e) => String(e),
}));

// Imported after the mock is registered.
const { novaDb } = await import('../src/services/novaDbClient');

beforeEach(() => { calls.length = 0; });

describe('novaDbClient SDK', () => {
  it('builds a parameterized INSERT from an object', async () => {
    await novaDb.insert('todos', { title: 'Ship', done: false });
    expect(calls[0].sql).toBe('INSERT INTO todos (title, done) VALUES (?, ?)');
    expect(calls[0].params).toEqual(['Ship', false]);
  });

  it('returns all rows from a SELECT', async () => {
    const rows = await novaDb.all('SELECT * FROM todos');
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('appends LIMIT 1 for get() and returns the first row', async () => {
    const row = await novaDb.get('SELECT * FROM todos WHERE id = ?', [1]);
    expect(calls[0].sql).toMatch(/LIMIT 1$/i);
    expect(row).toEqual({ id: 1 });
  });

  it('builds UPDATE with SET params before WHERE params', async () => {
    await novaDb.update('todos', { done: true }, 'id = ?', [7]);
    expect(calls[0].sql).toBe('UPDATE todos SET done = ? WHERE id = ?');
    expect(calls[0].params).toEqual([true, 7]);
  });

  it('rejects an identifier that is not a safe SQL name', async () => {
    await expect(novaDb.insert('bad table; DROP', { a: 1 })).rejects.toThrow(/invalid table name/);
    await expect(novaDb.insert('todos', { 'a b': 1 })).rejects.toThrow(/invalid column name/);
  });

  it('rejects a WHERE clause whose placeholder count does not match', async () => {
    await expect(novaDb.remove('todos', 'id = ? AND done = ?', [1])).rejects.toThrow(/placeholder/);
  });

  it('wraps a callback in BEGIN/COMMIT', async () => {
    await novaDb.transaction(async () => { await novaDb.count('todos'); });
    expect(calls.map((c) => c.sql)).toEqual(['BEGIN', 'SELECT COUNT(*) AS n FROM todos', 'COMMIT']);
  });

  it('rolls back when the transaction callback throws', async () => {
    await expect(novaDb.transaction(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(calls.map((c) => c.sql)).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('exposes a bound model with CRUD shortcuts', async () => {
    const Todos = novaDb.model('todos');
    await Todos.insert({ title: 'x' });
    expect(calls[0].sql).toBe('INSERT INTO todos (title) VALUES (?)');
    await Todos.update(3, { title: 'y' });
    expect(calls[1].sql).toBe('UPDATE todos SET title = ? WHERE id = ?');
    expect(calls[1].params).toEqual(['y', 3]);
  });
});
