import { Writable } from 'node:stream';
import { createTestDatabase, type TestDatabase } from '@orchestrator/db/testing';
import pg from 'pg';
import { loadShippedAgents } from '../src/agents/files.js';
import { seedAgentProfiles } from '../src/agents/seed.js';
import { buildApp, type App } from '../src/app.js';
import { createDatabase, type Database } from '../src/database.js';
import { createLogger } from '../src/logger.js';
import { markAllOffline } from '../src/machines/gateway.js';
import { endPool, schema } from '@orchestrator/db';
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
  /** `http://127.0.0.1:<port>` when started with `listen`, for daemons and WebSockets. */
  url: string;
  db: Database;
  pool: pg.Pool;
  logs: LogCapture;
  database: TestDatabase;
  /**
   * Stops the application and starts it again on the same database and port, as a server
   * restart does (machines left online become offline); `app` is then the new one.
   */
  restart(): Promise<void>;
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
    /** Listens on a free local port, for tests with a WebSocket or `fetch`. */
    listen?: boolean;
    /** Milliseconds in one second of the heartbeat settings, to test offline quickly. */
    daemonSecondMs?: number;
    /** Folder of the daemon package served at `/downloads/`. */
    daemonPackageDir?: string;
    /** Interval of the realtime stream's keep-alive and session check. */
    streamKeepAliveMs?: number;
  } = {},
): Promise<TestApp> {
  const database = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: database.url });
  const db = createDatabase(pool);
  // As the server's start does (`startServer`).
  await seedAgentProfiles(db, await loadShippedAgents());
  const values = Object.entries(options.settings ?? {}).map(([name, value]) => ({
    name: name as SettingName,
    value,
  }));
  if (values.length > 0) await db.insert(schema.settingValues).values(values);
  const logs = new LogCapture();
  const build = () =>
    buildApp({
      pool,
      logger: createLogger('trace', logs),
      secretKey: options.secretKey ?? TEST_SECRET_KEY,
      publicUrl: 'http://localhost:8080',
      githubApiUrl: options.githubApiUrl,
      now: options.now,
      daemonSecondMs: options.daemonSecondMs,
      daemonPackageDir: options.daemonPackageDir,
      streamKeepAliveMs: options.streamKeepAliveMs,
    });
  const app = build();
  await app.ready();
  const url = options.listen ? await app.listen({ port: 0, host: '127.0.0.1' }) : '';
  const testApp: TestApp = {
    app,
    url,
    db,
    pool,
    logs,
    database,
    async restart() {
      await testApp.app.close();
      await markAllOffline(db);
      testApp.app = build();
      await testApp.app.ready();
      if (options.listen) {
        await testApp.app.listen({ port: Number(new URL(url).port), host: '127.0.0.1' });
      }
    },
    async close() {
      await testApp.app.close();
      await endPool(pool);
      await database.drop();
    },
  };
  return testApp;
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
