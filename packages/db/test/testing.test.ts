import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { migrationsFolder, runMigrations } from '../src/migrate.js';
import { createPool, endPool } from '../src/pool.js';
import {
  createTestDatabase,
  defaultTestDatabaseUrl,
  templatePrefix,
  type TestDatabase,
} from '../src/testing.js';

const serverUrl = process.env.TEST_DATABASE_URL ?? defaultTestDatabaseUrl;

async function onServer<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: serverUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function withPool<T>(database: TestDatabase, work: (pool: pg.Pool) => Promise<T>) {
  const pool = createPool({ connectionString: database.url });
  try {
    return await work(pool);
  } finally {
    await endPool(pool);
    await database.drop();
  }
}

async function templates() {
  const { rows } = await onServer((client) =>
    client.query<{ datname: string; datistemplate: boolean; datallowconn: boolean }>(
      'SELECT datname, datistemplate, datallowconn FROM pg_database WHERE starts_with(datname, $1)',
      [templatePrefix],
    ),
  );
  return rows;
}

describe('createTestDatabase', () => {
  it('copies a template with every migration applied', async () => {
    const journal = JSON.parse(
      await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: unknown[] };
    await withPool(await createTestDatabase(), async (pool) => {
      const applied = () => pool.query('SELECT hash FROM drizzle.__drizzle_migrations');
      expect((await applied()).rowCount).toBe(journal.entries.length);
      await runMigrations(pool);
      expect((await applied()).rowCount).toBe(journal.entries.length);
      const { rows } = await pool.query('SELECT id FROM schema_info');
      expect(rows).toEqual([{ id: 1 }]);
    });
  });

  it('creates an empty database for tests of the migrations', async () => {
    await withPool(await createTestDatabase({ empty: true }), async (pool) => {
      const { rows } = await pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')",
      );
      expect(rows).toEqual([]);
    });
  });

  it('keeps one template, named after the migration files, that accepts no connection', async () => {
    await (await createTestDatabase()).drop();
    const current = (await templates()).filter((row) =>
      new RegExp(`^${templatePrefix}[0-9a-f]{12}$`).test(row.datname),
    );
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ datistemplate: true, datallowconn: false });
  });

  it('drops the templates of other migration files and interrupted builds', async () => {
    const stale = [`${templatePrefix}000000000000`, `${templatePrefix}000000000000_building`];
    await onServer(async (client) => {
      for (const name of stale) {
        await client.query(`CREATE DATABASE "${name}"`);
        await client.query(
          `ALTER DATABASE "${name}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
        );
      }
    });
    // Another address of the same server: this process has not checked its template yet.
    const url = new URL(serverUrl);
    url.searchParams.set('application_name', 'template-cleanup-test');
    await (await createTestDatabase({ serverUrl: url.toString() })).drop();

    const names = (await templates()).map((row) => row.datname);
    for (const name of stale) expect(names).not.toContain(name);
    expect(names.length).toBeGreaterThan(0);
  });
});
