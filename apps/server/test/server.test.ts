import { HealthResponse, PROTOCOL_VERSION, VersionResponse } from '@orchestrator/protocol';
import { createTestDatabase, type TestDatabase } from '@orchestrator/db/testing';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { endPool, runMigrations } from '@orchestrator/db';
import { buildApp } from '../src/app.js';
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
    database = await createTestDatabase();
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

  it('returns the server version and daemon protocol 1', async () => {
    const response = await fetch(`${baseUrl}/version`);
    expect(response.status).toBe(200);
    expect(VersionResponse.parse(await response.json())).toEqual({
      server: '0.2.0',
      protocol: 1,
    });
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('health when the database is unreachable', () => {
  let pool: pg.Pool;

  afterEach(async () => {
    await endPool(pool);
  });

  it('answers 503 and names the database', async () => {
    pool = new pg.Pool({ connectionString: 'postgres://nobody:secret@127.0.0.1:1/none' });
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
    const pool = new pg.Pool({ connectionString: database.url });
    try {
      await runMigrations(pool);
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
  it('logs the terminated connections and keeps working', async () => {
    const database = await createTestDatabase();
    const lines: string[] = [];
    const captured = pino({ level: 'info' }, { write: (line: string) => lines.push(line) });
    const server = await startServer({ databaseUrl: database.url, port: 0, ...keys }, captured);
    const admin = new pg.Client({ connectionString: database.url });
    try {
      const address = server.app.server.address();
      if (address === null || typeof address === 'string') throw new Error('no TCP address');
      const health = () => fetch(`http://127.0.0.1:${String(address.port)}/health`);
      // Several idle connections in the server's pool.
      await Promise.all(Array.from({ length: 4 }, health));

      await admin.connect();
      const { rows } = await admin.query<{ pid: number }>(
        `SELECT pg_terminate_backend(pid) AS terminated, pid FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()`,
      );
      expect(rows.length).toBeGreaterThan(0);
      await waitFor(
        () => lines.some((line) => line.includes('database connection lost')),
        5000,
        'the lost connection logged',
      );
      const logged = lines
        .map((line) => JSON.parse(line) as { msg: string; err?: { code?: string } })
        .find((entry) => entry.msg === 'database connection lost');
      expect(logged?.err?.code).toBe('57P01');

      // New connections replace them.
      const response = await health();
      expect(response.status).toBe(200);
      expect(HealthResponse.parse(await response.json())).toEqual({
        status: 'ok',
        database: 'ok',
      });
    } finally {
      await admin.end();
      await server.close();
      await database.drop();
    }
  });
});
