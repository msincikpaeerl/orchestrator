import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeConfig } from '../src/config.js';
import {
  createTestHome,
  healthyTools,
  homeProcesses,
  spawnDaemon,
  stopHomeProcesses,
  waitFor,
  type TestHome,
} from './testing.js';

// The test helpers' own guarantees: a daemon a test started is gone, with every process of it,
// once the test stopped it. `spawnDaemon` runs the daemon through tsx, which starts the daemon in
// a child process of its own: a SIGKILL sent to tsx alone never reaches that child, and such
// daemons were found running days after their tests (lot 2 step M, owner's review).

let home: TestHome;

beforeEach(async () => {
  home = await createTestHome();
  await healthyTools(home);
});

afterEach(async () => {
  await stopHomeProcesses(home);
  await home.remove();
});

/** A local port where nothing listens: the daemon keeps trying to connect. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

describe('test helpers', () => {
  it.each(['SIGKILL', 'SIGTERM'] as const)(
    'a daemon stopped with %s leaves no process of its test home',
    async (signal) => {
      await writeConfig(home.paths.config, {
        serverUrl: `http://127.0.0.1:${String(await closedPort())}`,
        machineId: randomUUID(),
        machineName: 'Desktop',
        machineToken: `omt_${'d'.repeat(43)}`,
        ca: null,
      });
      const daemon = spawnDaemon(['start'], home.env);
      // tsx, then the daemon it starts.
      await waitFor(() => homeProcesses(home).length >= 2, 20_000, 'the daemon running');
      await daemon.stop(signal);
      expect(homeProcesses(home)).toEqual([]);
    },
    60_000,
  );
});
