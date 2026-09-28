import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@orchestrator/db/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { OWNER, sessionCookie, TEST_SECRET_KEY } from './helpers.js';
import { StreamClient } from './stream-client.js';

// The server process's shutdown with open realtime streams (lot 2 step L1): `docker stop` sends
// SIGTERM, then kills the process after its timeout (10 seconds by default). Every open browser
// holds a stream, so the shutdown must end them at once instead of waiting for them.

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = createRequire(join(serverRoot, 'package.json')).resolve('tsx/cli');

/** Docker's default stop timeout, before it kills the process. */
const DOCKER_STOP_TIMEOUT_MS = 10_000;

let database: TestDatabase | undefined;
let child: ChildProcess | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  child = undefined;
  await database?.drop();
  database = undefined;
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('no port'));
      });
    });
  });
}

async function waitForHealth(url: string, process: ChildProcess, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (process.exitCode !== null) throw new Error('the server exited while starting');
    try {
      if ((await fetch(`${url}/health`)).status === 200) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`no healthy server within ${String(timeoutMs)} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function exited(process: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    if (process.exitCode !== null || process.signalCode !== null) {
      resolve({ code: process.exitCode, signal: process.signalCode });
      return;
    }
    process.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
}

describe('shutdown with open realtime streams', () => {
  it('ends the streams at once and exits well before Docker would kill it', async () => {
    database = await createTestDatabase();
    const port = await freePort();
    const url = `http://127.0.0.1:${String(port)}`;
    const output: string[] = [];
    child = spawn(
      process.execPath,
      [tsxCli, '--conditions=source', join(serverRoot, 'src', 'main.ts')],
      {
        cwd: serverRoot,
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: database.url,
          ORCHESTRATOR_SECRET_KEY: TEST_SECRET_KEY,
          PORT: String(port),
          LOG_LEVEL: 'info',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const collect = (chunk: Buffer) => output.push(chunk.toString('utf8'));
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const exit = exited(child);

    await waitForHealth(url, child, 60_000);
    const created = await fetch(`${url}/api/setup/owner`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(OWNER),
    });
    expect(created.status).toBe(201);
    const cookie = sessionCookie(created.headers.getSetCookie());
    // Two browsers, each with its stream open.
    const streams = [await StreamClient.open(url, cookie), await StreamClient.open(url, cookie)];

    const signalled = Date.now();
    child.kill('SIGTERM');
    for (const [index, stream] of streams.entries()) {
      await stream.end(`shutdown, stream ${String(index + 1)}`, DOCKER_STOP_TIMEOUT_MS);
    }
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      exit,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(`no exit within ${String(DOCKER_STOP_TIMEOUT_MS)} ms:\n${output.join('')}`),
          );
        }, DOCKER_STOP_TIMEOUT_MS);
      }),
    ]).finally(() => {
      clearTimeout(timer);
    });
    const elapsed = Date.now() - signalled;

    expect(result, output.join('')).toEqual({ code: 0, signal: null });
    // "Well under" Docker's timeout: a shutdown waiting on the streams would take all of it.
    expect(elapsed).toBeLessThan(3000);
  }, 90_000);
});
