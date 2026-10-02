import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeConfig } from '../src/config.js';
import { ScriptedServer } from './scripted-server.js';
import {
  createTestHome,
  healthyTools,
  spawnDaemon,
  stopHomeProcesses,
  waitFor,
  type TestHome,
} from './testing.js';

// Stopping the daemon never waits for the server (05, section 6). Found in the owner's systemd
// test run (lot 2 step N): the WebSocket close waits for the server's answer, and a server that
// does not answer kept the daemon 30 seconds (the `ws` library's close timeout) after its own
// stopping work was done. Here the server cannot answer because this test process, which runs
// it, is blocked in `spawnSync`, as the systemd test is in `systemctl --user stop`.

const TIMEOUT = 90_000;
/** Far below the 30 seconds of the `ws` close timeout, with room for a slow machine. */
const QUICK_MS = 10_000;

let home: TestHome;
let server: ScriptedServer;

beforeEach(async () => {
  home = await createTestHome();
  await healthyTools(home);
  server = new ScriptedServer();
  await server.listen();
  await writeConfig(home.paths.config, {
    serverUrl: server.url,
    machineId: randomUUID(),
    machineName: 'Desktop',
    machineToken: `omt_${'d'.repeat(43)}`,
    ca: null,
  });
});
afterEach(async () => {
  await stopHomeProcesses(home);
  await server.close();
  await home.remove();
});

async function connectedDaemon() {
  const daemon = spawnDaemon(['start'], home.env);
  await waitFor(() => server.hellos().length === 1, 30_000, 'hello');
  return daemon;
}

describe('stopping the daemon', () => {
  it(
    'is quick when the server answers the close',
    async () => {
      const daemon = await connectedDaemon();
      const began = Date.now();
      daemon.child.kill('SIGTERM');
      expect(await daemon.exited).toBe(0);
      expect(Date.now() - began).toBeLessThan(QUICK_MS);
    },
    TIMEOUT,
  );

  it(
    'is quick when the server cannot answer the close',
    async () => {
      const daemon = await connectedDaemon();
      const pid = daemon.child.pid ?? 0;
      const began = Date.now();
      // Blocks this process, and so the server, until the daemon is gone. It stays a zombie
      // (`Z`) until this process can reap it, so a zombie counts as gone.
      spawnSync(
        'sh',
        [
          '-c',
          `kill -TERM ${String(pid)}; while ps -o stat= -p ${String(pid)} | grep -qv Z; do sleep 0.1; done`,
        ],
        { timeout: 60_000 },
      );
      const elapsed = Date.now() - began;
      expect(await daemon.exited).toBe(0);
      expect(elapsed).toBeLessThan(QUICK_MS);
    },
    TIMEOUT,
  );
});
