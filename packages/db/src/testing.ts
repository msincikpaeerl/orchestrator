import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { migrationsFolder, runMigrations } from './migrate.js';
import { createPool, endPool } from './pool.js';

/**
 * The test PostgreSQL of `docker/compose.dev.yml` (`postgres-test`, durability turned off for
 * speed); `TEST_DATABASE_URL` overrides it.
 */
export const defaultTestDatabaseUrl =
  'postgres://orchestrator:orchestrator@localhost:5433/orchestrator';

/** Prefix of the migrated templates; the rest of the name is a hash of the migration files. */
export const templatePrefix = 'test_template_';

/** Advisory lock held while a template is checked or built, by any test process on the server. */
const templateLock = 7_336_101;

export interface TestDatabase {
  /** Connection string of the new database. */
  url: string;
  /** Drops the database, closing any connection still open on it. */
  drop(): Promise<void>;
}

export interface TestDatabaseOptions {
  /** A PostgreSQL server (the database part is ignored); `TEST_DATABASE_URL` by default. */
  serverUrl?: string;
  /** An empty database, for tests of the migrations themselves, instead of a migrated one. */
  empty?: boolean;
}

/**
 * Creates a throw-away database on the test PostgreSQL, so that integration tests run against a
 * real database without touching development data or each other. Unless `empty`, it is a copy of
 * a template migrated once per version of the migration files: copying is much faster than
 * migrating each database.
 */
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const serverUrl = options.serverUrl ?? process.env.TEST_DATABASE_URL ?? defaultTestDatabaseUrl;
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  const template = options.empty ? 'template1' : await migratedTemplate(serverUrl);
  await onServer(serverUrl, (client) =>
    client.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`),
  );
  return {
    url: databaseUrl(serverUrl, name),
    drop: async () => {
      await onServer(serverUrl, (client) =>
        client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
      );
    },
  };
}

function databaseUrl(serverUrl: string, name: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** The template of each server, checked once per process. */
const templates = new Map<string, Promise<string>>();

function migratedTemplate(serverUrl: string): Promise<string> {
  let template = templates.get(serverUrl);
  if (!template) {
    template = ensureTemplate(serverUrl);
    templates.set(serverUrl, template);
    // A failure is reported by the test that waited for it; the next one tries again.
    template.catch(() => templates.delete(serverUrl));
  }
  return template;
}

/**
 * The migrated template of the current migration files, built if missing, under a lock shared by
 * every test process on the server (Vitest workers, other checkouts). It is built under another
 * name and renamed once complete, so an interrupted build is never copied, and it accepts no
 * connection, which copying requires. Templates of other migration files, and interrupted builds,
 * are dropped: two test runs with different migration files cannot share a server at the same
 * time (the first one's databases can no longer be created).
 */
async function ensureTemplate(serverUrl: string): Promise<string> {
  const name = `${templatePrefix}${await migrationsHash()}`;
  await onServer(serverUrl, async (client) => {
    await client.query('SELECT pg_advisory_lock($1)', [templateLock]);
    try {
      const { rows } = await client.query<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE starts_with(datname, $1)',
        [templatePrefix],
      );
      for (const { datname } of rows.filter((row) => row.datname !== name)) {
        try {
          await client.query(`ALTER DATABASE "${datname}" WITH IS_TEMPLATE false`);
          await client.query(`DROP DATABASE "${datname}" WITH (FORCE)`);
        } catch {
          // Being copied by a test run with other migration files: a later check drops it.
        }
      }
      if (rows.some((row) => row.datname === name)) return;
      const building = `${name}_building`;
      await client.query(`CREATE DATABASE "${building}"`);
      const pool = createPool({ connectionString: databaseUrl(serverUrl, building) });
      try {
        await runMigrations(pool);
      } finally {
        await endPool(pool);
      }
      await client.query(`ALTER DATABASE "${building}" RENAME TO "${name}"`);
      await client.query(`ALTER DATABASE "${name}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [templateLock]);
    }
  });
  return name;
}

/** First 12 hexadecimal digits of the SHA-256 of the migration files, names and contents. */
async function migrationsHash(): Promise<string> {
  const entries = await readdir(migrationsFolder, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${relative(migrationsFolder, file)}\n`);
    hash.update(await readFile(file));
  }
  return hash.digest('hex').slice(0, 12);
}

async function onServer<T>(serverUrl: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: serverUrl });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Cannot reach PostgreSQL at ${new URL(serverUrl).host} for integration tests. ` +
        'Start it with: docker compose -f docker/compose.dev.yml up -d --wait',
      { cause: error },
    );
  }
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/**
 * Applies the migrations up to `tag` included (`0005_settings`), as an older version would, so a
 * test can write data in the old shape and then check a later migration with `runMigrations`.
 * The database must be created `empty`.
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
