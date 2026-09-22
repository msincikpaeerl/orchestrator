import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';

describe('runMigrations', () => {
  let database: TestDatabase;
  let pool: pg.Pool;

  beforeEach(async () => {
    database = await createTestDatabase();
    pool = new pg.Pool({ connectionString: database.url });
  });

  afterEach(async () => {
    await pool.end();
    await database.drop();
  });

  it('creates the schema and records when the database was initialised', async () => {
    await runMigrations(pool);

    const { rows } = await pool.query<{ id: number }>('SELECT id FROM schema_info');
    expect(rows).toEqual([{ id: 1 }]);
  });

  it('is safe to run again on an up-to-date database', async () => {
    await runMigrations(pool);
    await runMigrations(pool);

    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM schema_info');
    expect(rows).toEqual([{ count: '1' }]);
  });
});
