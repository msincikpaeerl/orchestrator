import { randomUUID } from 'node:crypto';
import pg from 'pg';

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
