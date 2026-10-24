import {
  HealthResponse,
  PROTOCOL_VERSION,
  STREAM_RETRY_MS,
  VersionResponse,
} from '@orchestrator/protocol';
import { createTestDatabase, type TestDatabase } from '@orchestrator/db/testing';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, endPool } from '@orchestrator/db';
import { buildApp } from '../src/app.js';
import { defaultDaemonPackageDir, providedDaemonBuild } from '../src/downloads.js';
import { INTERRUPTED_REASON } from '../src/projects/setup.js';
import { startServer, type RunningServer } from '../src/server.js';
import { waitFor } from '@orchestrator/daemon/testing';
import { TEST_SECRET_KEY } from './helpers.js';

const logger = pino({ level: 'silent' });
const keys = { secretKey: TEST_SECRET_KEY, publicUrl: 'http://localhost:8080' };

describe('server started on a new database', () => {
  let database: TestDatabase;
  let server: RunningServer;
  let baseUrl: string;

  beforeAll(async () => {
    database = await createTestDatabase({ empty: true });
    server = await startServer({ databaseUrl: database.url, port: 0, ...keys }, logger);
    const address = server.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP address');
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await server.close();
    await database.drop();
  });

  it('applies the migrations at start', async () => {
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    try {
      const { rows } = await client.query('SELECT id FROM schema_info');
      expect(rows).toEqual([{ id: 1 }]);
    } finally {
      await client.end();
    }
  });

  it('reports itself healthy over HTTP', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(HealthResponse.parse(await response.json())).toEqual({ status: 'ok', database: 'ok' });
  });

  it('returns the server version, daemon protocol 3 and the build it provides', async () => {
    const response = await fetch(`${baseUrl}/version`);
    expect(response.status).toBe(200);
    expect(VersionResponse.parse(await response.json())).toEqual({
      server: '0.5.0',
      protocol: 3,
      // Null when `pnpm build` has not built the daemon package yet.
      daemonBuild: providedDaemonBuild(defaultDaemonPackageDir()),
    });
    expect(PROTOCOL_VERSION).toBe(3);
  });
});

describe('health when the database is unreachable', () => {
  let pool: pg.Pool;

  afterEach(async () => {
    await endPool(pool);
  });

  it('answers 503 and names the database', async () => {
    pool = createPool({ connectionString: 'postgres://nobody:secret@127.0.0.1:1/none' });
    const app = buildApp({ pool, logger, ...keys });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(HealthResponse.parse(response.json())).toEqual({ status: 'error', database: 'error' });
  });
});

describe('start when the database is unreachable', () => {
  it('fails instead of listening without migrations', async () => {
    await expect(
      startServer(
        { databaseUrl: 'postgres://nobody:secret@127.0.0.1:1/none', port: 0, ...keys },
        logger,
      ),
    ).rejects.toThrow();
  });
});

describe('start after a restart during a project setup', () => {
  it('marks the interrupted setup as failed, so the owner can try again', async () => {
    const database = await createTestDatabase();
    const pool = createPool({ connectionString: database.url });
    try {
      await pool.query(
        `INSERT INTO projects (key, name, slug, description, kind, repo_owner, repo_name,
           repo_origin, repo_private, setup_status, setup_step)
         VALUES ('SHOP', 'Shop', 'shop', '', 'web_app', 'octo-owner', 'shop', 'created', true,
           'in_progress', 'skeleton')`,
      );
      const server = await startServer({ databaseUrl: database.url, port: 0, ...keys }, logger);
      await server.close();
      const { rows } = await pool.query(
        'SELECT setup_status, setup_step, setup_failure FROM projects',
      );
      expect(rows).toEqual([
        { setup_status: 'failed', setup_step: 'skeleton', setup_failure: INTERRUPTED_REASON },
      ]);
    } finally {
      await endPool(pool);
      await database.drop();
    }
  });
});

describe('database connections lost, as in a PostgreSQL restart', () => {
  // Above the deadlines below, so that a missed deadline is what the failure names.
  it('logs each terminated connection, idle, in use or listening, and recovers', async () => {
    const database = await createTestDatabase();
    const lines: string[] = [];
    const captured = pino({ level: 'info' }, { write: (line: string) => lines.push(line) });
    const server = await startServer({ databaseUrl: database.url, port: 0, ...keys }, captured);
    const admin = new pg.Client({ connectionString: database.url });
    let held: pg.PoolClient | null = null;
    const logged = (message: string) =>
      lines
        .map((line) => JSON.parse(line) as { msg: string; err?: { code?: string } })
        .filter((entry) => entry.msg === message);
    const lost = () => logged('database connection lost');
    /** The backend holding the realtime stream's `LISTEN`, if any. */
    const listener = async () => {
      const { rows } = await admin.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND query LIKE 'LISTEN %'`,
      );
      return rows[0]?.pid;
    };
    try {
      const address = server.app.server.address();
      if (address === null || typeof address === 'string') throw new Error('no TCP address');
      const health = () => fetch(`http://127.0.0.1:${String(address.port)}/health`);
      // One connection in use, as in a transaction waiting between two queries (without a
      // listener of its own, its loss crashes the process), and one idle in the pool. Made
      // directly, and checked: parallel requests may share one connection on a slow machine.
      held = await server.pool.connect();
      const idle = await server.pool.connect();
      idle.release();
      // Startup may have left other idle connections: all are terminated below.
      expect(server.pool.idleCount).toBeGreaterThanOrEqual(1);

      await admin.connect();
      // The realtime stream's listener, terminated with the others below.
      const listening = await listener();
      expect(listening).toBeDefined();
      // One running a query, as the server's own work does (the GitHub check loop's queries):
      // its loss was never logged (CI of lot 3 step J2c, pull request #70).
      const running = server.pool.query('SELECT pg_sleep(30)').catch(() => undefined);
      await waitFor(
        async () =>
          (
            await admin.query(
              `SELECT 1 FROM pg_stat_activity
                WHERE datname = current_database() AND state = 'active'
                  AND query = 'SELECT pg_sleep(30)'`,
            )
          ).rows.length === 1,
        5000,
        'the query running',
      );
      const { rows } = await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
      // Each connection reports its loss when its error arrives, which takes longer on a slow
      // machine: wait for all of them, with a deadline.
      await waitFor(
        () => lost().length >= rows.length,
        5000,
        `${String(rows.length)} "database connection lost" logs`,
      );
      expect(lost().map((entry) => entry.err?.code)).toEqual(rows.map(() => '57P01'));
      await running;
      held.release(true);
      held = null;

      // A request may still meet a connection whose loss is not seen yet and answer 503: what
      // must hold is that the server recovers, with a deadline.
      await waitFor(
        async () => {
          try {
            const response = await health();
            return (
              response.status === 200 &&
              HealthResponse.parse(await response.json()).database === 'ok'
            );
          } catch {
            // Not listening any more: the deadline fails the test.
            return false;
          }
        },
        5000,
        '/health answering 200 with the database ok',
      );
      // The realtime stream listens again, on a new connection, after its retry delay.
      await waitFor(
        async () => {
          const pid = await listener();
          return pid !== undefined && pid !== listening;
        },
        STREAM_RETRY_MS + 5000,
        'a new LISTEN connection',
      );
      expect(logged('realtime: database listener lost')).toHaveLength(1);
      expect(logged('realtime: database listener reconnected')).toHaveLength(1);
    } finally {
      held?.release(true);
      await admin.end();
      await server.close();
      await database.drop();
    }
  }, 30_000);
});
