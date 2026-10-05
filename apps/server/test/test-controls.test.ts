import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, endPool } from '@orchestrator/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { GITHUB_CONTROLS } from './fake-github-controls.js';
import { LogCapture, TEST_SECRET_KEY } from './helpers.js';

// The end-to-end server's test-only controls (reset, GitHub failures, the scripted daemon) live
// in test/e2e-server.ts, on a listener of their own. The Orchestrator itself never has them.

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every control of test/e2e-server.ts. */
const CONTROLS = [
  '/reset',
  '/github/fail-next',
  ...GITHUB_CONTROLS,
  '/daemon/connect',
  '/daemon/run',
  '/daemon/request',
  '/daemon/disconnect',
];

// A 404 needs no database: the pool is never used.
const pool = createPool({ connectionString: 'postgres://nobody:secret@127.0.0.1:1/none' });
let webRoot: string;

beforeAll(async () => {
  webRoot = await mkdtemp(join(tmpdir(), 'orchestrator-controls-'));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>UI</title>');
});

afterAll(async () => {
  await rm(webRoot, { recursive: true });
  await endPool(pool);
});

async function sourceFiles(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('the test-only controls', () => {
  it('are absent from the Orchestrator, as built for production with its UI', async () => {
    const app = buildApp({
      pool,
      logger: createLogger('info', new LogCapture()),
      secretKey: TEST_SECRET_KEY,
      publicUrl: 'http://localhost:8080',
      webRoot,
    });
    for (const url of CONTROLS) {
      const response = await app.inject({
        method: 'POST',
        url,
        payload: { code: 'ABCD', method: 'GET', path: '/user', status: 503 },
      });
      expect(response.statusCode, url).toBe(404);
    }
    await app.close();
  });

  it('are never compiled or shipped: the build takes only src, which never loads test code', async () => {
    const build = JSON.parse(await readFile(join(serverRoot, 'tsconfig.build.json'), 'utf8')) as {
      include: string[];
    };
    expect(build.include).toEqual(['src']);
    const manifest = JSON.parse(await readFile(join(serverRoot, 'package.json'), 'utf8')) as {
      files: string[];
    };
    expect(manifest.files).toEqual(['dist']);

    const files = await sourceFiles(join(serverRoot, 'src'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      const name = relative(serverRoot, file);
      expect(text, name).not.toMatch(/from ['"][./]*\/test\//);
      expect(text, name).not.toMatch(/e2e-server|daemon-client|fake-github/);
    }
  });
});
