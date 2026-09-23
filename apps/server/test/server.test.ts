import { HealthResponse, PROTOCOL_VERSION, VersionResponse } from '@orchestrator/protocol';
import { createTestDatabase, type TestDatabase } from '@orchestrator/db/testing';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { startServer, type RunningServer } from '../src/server.js';
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

  it('returns the server and protocol versions', async () => {
    const response = await fetch(`${baseUrl}/version`);
    expect(response.status).toBe(200);
    expect(VersionResponse.parse(await response.json())).toEqual({
      server: '0.1.0',
      protocol: PROTOCOL_VERSION,
    });
  });
});

describe('health when the database is unreachable', () => {
  let pool: pg.Pool;

  afterEach(async () => {
    await pool.end();
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
