import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '@orchestrator/protocol';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { LogCapture, TEST_SECRET_KEY } from './helpers.js';

// Serving the UI needs no database: the pool is never used.
const pool = new pg.Pool({ connectionString: 'postgres://nobody:secret@127.0.0.1:1/none' });
let webRoot: string;

function appServing(root: string | null, logs = new LogCapture()) {
  return buildApp({
    pool,
    logger: createLogger('info', logs),
    secretKey: TEST_SECRET_KEY,
    publicUrl: 'http://localhost:8080',
    webRoot: root,
  });
}

beforeAll(async () => {
  webRoot = await mkdtemp(join(tmpdir(), 'orchestrator-web-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>UI</title>');
  await mkdir(join(webRoot, 'assets'));
  await writeFile(join(webRoot, 'assets', 'index-abc123.js'), 'console.log(1);');
});

afterAll(async () => {
  await rm(webRoot, { recursive: true });
  await pool.end();
});

describe('the built UI', () => {
  it('is served at / and for every screen address, never cached', async () => {
    const app = appServing(webRoot);
    for (const url of ['/', '/settings/github', '/help/getting-started?q=token']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.body).toContain('<title>UI</title>');
    }
  });

  it('serves its assets with a long cache, since their names change with their content', async () => {
    const response = await appServing(webRoot).inject({
      method: 'GET',
      url: '/assets/index-abc123.js',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('answers unknown API addresses, missing files and other methods with an error, not the UI', async () => {
    const app = appServing(webRoot);
    for (const [method, url] of [
      ['GET', '/api/nothing'],
      ['GET', '/api'],
      ['POST', '/settings'],
      ['GET', '/assets/missing.js'],
    ] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(ApiError.parse(response.json()).error.code).toBe('not_found');
    }
  });
});

describe('without a built UI', () => {
  it('serves the API only and says why in the logs', async () => {
    const logs = new LogCapture();
    const app = appServing(join(webRoot, 'missing'), logs);
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(404);
    expect(logs.text).toContain('UI not built: serving the API only');
  });
});
