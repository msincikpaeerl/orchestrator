import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrationsFolder, runMigrations } from '../src/migrate.js';
import { createPool, endPool } from '../src/pool.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';

describe('runMigrations', () => {
  let database: TestDatabase;
  let pool: pg.Pool;

  beforeEach(async () => {
    database = await createTestDatabase({ empty: true });
    pool = createPool({ connectionString: database.url });
  });

  afterEach(async () => {
    await endPool(pool);
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

  it('marks the wizard finished for an owner created before version 0.6.0 (lot 5 step J)', async () => {
    // The migrations up to 0047 only: the database of a 0.5.0 install with its owner.
    const folder = await mkdtemp(join(tmpdir(), 'od-test-migrations-'));
    try {
      await cp(migrationsFolder, folder, { recursive: true });
      const journalPath = join(folder, 'meta', '_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
        entries: { tag: string }[];
      };
      const before = journal.entries.findIndex((entry) => entry.tag === '0048_wizard_finished');
      expect(before).toBeGreaterThan(0);
      journal.entries = journal.entries.slice(0, before);
      await writeFile(journalPath, JSON.stringify(journal));
      await migrate(drizzle(pool), { migrationsFolder: folder });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
    await pool.query(`INSERT INTO owner (username, password_hash) VALUES ('owner', 'hash')`);

    await runMigrations(pool);

    const { rows } = await pool.query<{ finished: boolean }>(
      'SELECT setup_finished_at IS NOT NULL AS finished FROM owner',
    );
    expect(rows).toEqual([{ finished: true }]);
  });
});
