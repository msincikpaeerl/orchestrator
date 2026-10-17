import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { runSocketPath } from '../src/run-socket.js';
import {
  TIMEOUT,
  daemon,
  ended,
  fake,
  home,
  start,
  states,
  useRunnerHarness,
} from './runner-harness.js';
import { captureLogger, waitFor } from './testing.js';

// The log of a session kill (05, section 4.11; lot 3 decision Q32): the `Stop` hook of a run of
// lot 2's check failed as the run ended, most likely killed with the session while it was
// exiting, and nothing in the daemon's log could show it. The daemon now logs, with the run id,
// the kill and each connection to the run's socket still open at that moment.

useRunnerHarness();

interface Line {
  msg: string;
  runId?: string;
  why?: string;
  openConnections?: number;
  request?: string;
  answered?: boolean;
  openMs?: number;
}

/** A hook command's connection, kept open on its side as a command still running would. */
function connect(path: string): Promise<{ socket: Socket; received: () => string }> {
  return new Promise((resolve, reject) => {
    let received = '';
    const socket = createConnection({ path, allowHalfOpen: true }, () => {
      resolve({ socket, received: () => received });
    });
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (received += chunk));
    socket.once('error', reject);
  });
}

describe('the session kill in the log', () => {
  it(
    'logs the kill and each hook connection still open when a hook is still running at the run end',
    async () => {
      const { log, lines } = captureLogger();
      const manager = daemon({ log });
      await fake.play({ turns: [{ steps: [{ do: 'hang' }] }] });
      const run = await start(manager);
      await waitFor(
        () => states(run.runId).some((state) => state.state === 'working'),
        30_000,
        'the session start',
      );
      const path = runSocketPath(home.paths, run.runId);

      // A hook that has its answer but has not exited yet, as lot 2's Stop hook.
      const exiting = await connect(path);
      exiting.socket.write(
        `${JSON.stringify({
          type: 'hook',
          event: 'Notification',
          input: { session_id: 'session', message: 'Claude is waiting for your input' },
        })}\n`,
      );
      await waitFor(() => exiting.received().includes('\n'), 10_000, "the hook's answer");
      // A hook still sending its input.
      const sending = await connect(path);
      sending.socket.write('{"type":"hook","event":"Stop"');

      expect(
        await manager.handle({
          type: 'run.stop',
          id: randomUUID(),
          payload: { runId: run.runId, reason: 'owner_stopped' },
        }),
      ).toEqual({ ok: true });
      expect((await ended(run.runId)).reason).toBe('stopped');
      exiting.socket.destroy();
      sending.socket.destroy();

      const logged = lines().map((line) => JSON.parse(line) as Line);
      const kill = logged.find((line) => line.msg === 'killing the Claude Code session');
      expect(kill).toMatchObject({
        runId: run.runId,
        why: 'the run ends (stopped)',
        openConnections: 2,
      });
      const open = logged.filter(
        (line) => line.msg === "connection to the run's socket still open as the session is killed",
      );
      expect(open).toEqual([
        expect.objectContaining({
          runId: run.runId,
          request: 'hook Notification',
          answered: true,
          openMs: expect.any(Number) as unknown,
        }),
        expect.objectContaining({ runId: run.runId, request: 'not read yet', answered: false }),
      ]);
      // In the order they happened: the kill, then the end.
      const index = (message: string) => logged.findIndex((line) => line.msg === message);
      expect(index('killing the Claude Code session')).toBeLessThan(index('run ended'));
    },
    TIMEOUT,
  );

  it(
    'logs a kill with no connection open at the end of an ordinary run',
    async () => {
      const { log, lines } = captureLogger();
      const manager = daemon({ log });
      await fake.play({ turns: [{ steps: [{ do: 'hang' }] }] });
      const run = await start(manager);
      await waitFor(
        () => states(run.runId).some((state) => state.state === 'working'),
        30_000,
        'the session start',
      );
      await manager.handle({
        type: 'run.stop',
        id: randomUUID(),
        payload: { runId: run.runId, reason: 'owner_stopped' },
      });
      await ended(run.runId);
      const logged = lines().map((line) => JSON.parse(line) as Line);
      expect(logged.find((line) => line.msg === 'killing the Claude Code session')).toMatchObject({
        runId: run.runId,
        openConnections: 0,
      });
      expect(logged.some((line) => line.msg.startsWith("connection to the run's socket"))).toBe(
        false,
      );
    },
    TIMEOUT,
  );
});
