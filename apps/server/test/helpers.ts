import { Writable } from 'node:stream';
import { createTestDatabase, type TestDatabase } from '@orchestrator/db/testing';
import pg from 'pg';
import { buildApp, type App } from '../src/app.js';
import { createDatabase, type Database } from '../src/database.js';
import { createLogger } from '../src/logger.js';
import { runMigrations, schema } from '@orchestrator/db';
import type { SettingName, SettingValues } from '@orchestrator/protocol';

export const TEST_SECRET_KEY = 'test-secret-key-that-is-at-least-32-characters';
export const OWNER = { username: 'owner', password: 'correct horse battery' };

/** Log lines written by the application, to prove secrets never reach them. */
export class LogCapture extends Writable {
  lines: string[] = [];
  override _write(chunk: Buffer, _encoding: string, callback: () => void) {
    this.lines.push(chunk.toString('utf8'));
    callback();
  }
  get text(): string {
    return this.lines.join('');
  }
}

export interface TestApp {
  app: App;
  db: Database;
  pool: pg.Pool;
  logs: LogCapture;
  database: TestDatabase;
  close(): Promise<void>;
}

/** The application on a new migrated database, with logs captured at the most verbose level. */
export async function startTestApp(
  options: {
    githubApiUrl?: string;
    /** Global values stored before the application starts, as if the owner had set them. */
    settings?: Partial<SettingValues>;
    secretKey?: string;
    now?: () => Date;
  } = {},
): Promise<TestApp> {
  const database = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: database.url });
  await runMigrations(pool);
  const db = createDatabase(pool);
  const values = Object.entries(options.settings ?? {}).map(([name, value]) => ({
    name: name as SettingName,
    value,
  }));
  if (values.length > 0) await db.insert(schema.settingValues).values(values);
  const logs = new LogCapture();
  const app = buildApp({
    pool,
    logger: createLogger('trace', logs),
    secretKey: options.secretKey ?? TEST_SECRET_KEY,
    publicUrl: 'http://localhost:8080',
    githubApiUrl: options.githubApiUrl,
    now: options.now,
  });
  await app.ready();
  return {
    app,
    db,
    pool,
    logs,
    database,
    async close() {
      await app.close();
      await pool.end();
      await database.drop();
    },
  };
}

/** Creates the owner through the API and returns the session cookie, `name=value`. */
export async function createOwner(app: App): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/setup/owner', payload: OWNER });
  if (response.statusCode !== 201) throw new Error(`owner creation failed: ${response.body}`);
  return sessionCookie(response.headers['set-cookie']);
}

export function sessionCookie(header: string | string[] | undefined): string {
  const first = Array.isArray(header) ? header[0] : header;
  const pair = first?.split(';')[0];
  if (!pair?.startsWith('orchestrator_session=')) throw new Error('no session cookie');
  return pair;
}
