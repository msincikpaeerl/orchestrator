import { createPool, endPool } from '@orchestrator/db';
import { createTestDatabase, type TestDatabase } from '@orchestrator/db/testing';
import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { emptyTables, resetTables } from './e2e-reset.js';

// The "deadlock detected" the server logged once on a Needs you request during lot 3 step J4c's
// end-to-end run (lot 3 step K1). The reset between two tests empties every table with one
// TRUNCATE, which takes each table's exclusive lock in turn, while a request of the previous
// test's page may still be reading: a query joining two tables takes their shared locks in its
// own order. No order of the TRUNCATE suits every query, so the reset gives way instead.

let database: TestDatabase;
let pool: pg.Pool;

beforeAll(async () => {
  database = await createTestDatabase();
  pool = createPool({ connectionString: database.url });
});

afterAll(async () => {
  await endPool(pool);
  await database.drop();
});

it('gives way to a request reading two tables in the opposite order, then empties them', async () => {
  const tables = await resetTables(pool);
  const first = tables[0];
  const last = tables.at(-1);
  if (!first || !last || first === last) throw new Error('the reset needs two tables');
  await pool.query("INSERT INTO claude_accounts (label, plan) VALUES ('Personal', 'max_5x')");
  // The request: it has read the table the reset locks last, and reads the first one next.
  const request = await pool.connect();
  try {
    await request.query('BEGIN');
    await request.query(`SELECT 1 FROM "${last}" LIMIT 1`);
    const reset = emptyTables(pool).then(
      () => null,
      (error: unknown) => error,
    );
    // The reset holds the first table and waits for the last one.
    for (const deadline = Date.now() + 5_000; ;) {
      const { rows } = await pool.query<{ waiting: number }>(
        "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'TRUNCATE%'",
      );
      if (rows[0]?.waiting === 1) break;
      if (Date.now() > deadline) throw new Error('the reset never waited for the request');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await expect(request.query(`SELECT 1 FROM "${first}" LIMIT 1`)).resolves.toBeDefined();
    await request.query('COMMIT');
    expect(await reset).toBeNull();
  } finally {
    request.release();
  }
  const { rows } = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM claude_accounts',
  );
  expect(rows[0]?.count).toBe(0);
});
