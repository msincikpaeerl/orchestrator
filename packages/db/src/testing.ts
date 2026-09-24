import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { migrationsFolder } from './migrate.js';

/** The PostgreSQL of `docker/compose.dev.yml`; `TEST_DATABASE_URL` overrides it. */
export const defaultTestDatabaseUrl =
  'postgres://orchestrator:orchestrator@localhost:5432/orchestrator';

export interface TestDatabase {
  /** Connection string of a new, empty database. */
  url: string;
  /** Drops the database, closing any connection still open on it. */
  drop(): Promise<void>;
}

/**
 * Creates a throw-away database on the development PostgreSQL, so that integration tests
 * run against a real database without touching development data or each other.
 */
export async function createTestDatabase(
  serverUrl = process.env.TEST_DATABASE_URL ?? defaultTestDatabaseUrl,
): Promise<TestDatabase> {
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await runOnServer(serverUrl, `CREATE DATABASE "${name}"`);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: () => runOnServer(serverUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
  };
}

async function runOnServer(serverUrl: string, statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: serverUrl });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Cannot reach PostgreSQL at ${new URL(serverUrl).host} for integration tests. ` +
        'Start it with: docker compose -f docker/compose.dev.yml up -d postgres',
      { cause: error },
    );
  }
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

/**
 * Applies the migrations up to `tag` included (`0005_settings`), as an older version would, so a
 * test can write data in the old shape and then check a later migration with `runMigrations`.
 */
export async function migrateUpTo(pool: pg.Pool, tag: string): Promise<void> {
  const journalPath = join(migrationsFolder, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  const last = journal.entries.findIndex((entry) => entry.tag === tag);
  if (last === -1) throw new Error(`no migration ${tag}`);
  const folder = await mkdtemp(join(tmpdir(), 'orchestrator-migrations-'));
  try {
    await cp(migrationsFolder, folder, { recursive: true });
    const entries = journal.entries.slice(0, last + 1);
    await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
