import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SWEEP_GRACE_MS, markedProcesses } from '../src/processes.js';
import { LEFT_BEHIND, leftPids, running } from './left-behind.js';
import {
  TIMEOUT,
  addSystemPath,
  daemon,
  ended,
  fake,
  home,
  start,
  states,
  useRunnerHarness,
} from './runner-harness.js';
import { waitFor } from './testing.js';

// The processes a run's session leaves (05, section 4.11; lot 2 plan step K): closing the tmux
// session does not stop a `nohup`, `setsid` or double-forked process, so the daemon stops every
// process carrying the run's marker. Without systemd here; `systemd.test.ts` adds the scopes.

useRunnerHarness();

describe('processes left by a session', () => {
  it(
    'are stopped when the run ends, whatever they did to their session',
    async () => {
      addSystemPath();
      const manager = daemon();
      await fake.play({ turns: [{ steps: [...LEFT_BEHIND, { do: 'text', text: 'Done.' }] }] });
      const run = await start(manager, { limits: { maxNudgesPerRun: 0 } });
      await ended(run.runId);
      const pids = await leftPids();
      expect(pids).toHaveLength(4);
      await waitFor(
        () => pids.every((pid) => !running(pid, run.runId)),
        10_000,
        'the four processes stopped',
      );
      expect(markedProcesses(run.runId)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "are stopped when a waiting run's session is closed after its lifetime",
    async () => {
      addSystemPath();
      const manager = daemon({ secondMs: 20 });
      await fake.play({
        turns: [
          {
            steps: [
              ...LEFT_BEHIND,
              { do: 'mcp', tool: 'ticket_ask', arguments: { question: 'Which address?' } },
            ],
          },
        ],
      });
      // One minute lasts 1.2 s; the session start is not what this test times.
      const run = await start(manager, {
        limits: {
          waitingRunLifetimeMinutes: 1,
          sessionStartTimeoutSeconds: 600,
          maxNudgesPerRun: 0,
        },
      });
      await waitFor(
        () =>
          states(run.runId).some((state) => state.state === 'waiting_human' && !state.sessionAlive),
        20_000,
        'the waiting session closed',
      );
      const pids = await leftPids();
      expect(pids).toHaveLength(4);
      await waitFor(
        () => pids.every((pid) => !running(pid, run.runId)),
        10_000,
        'the four processes stopped',
      );
      expect(markedProcesses(run.runId)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'are all gone before the run is reported ended, even one forked while they were stopped',
    async () => {
      // A command that ignores SIGHUP and SIGTERM and, from just before the SIGKILL, keeps
      // starting writers that append to a file outside the worktree every 0.2 s: a writer
      // started between the sweep's last look at /proc and its SIGKILL was left running.
      addSystemPath();
      const manager = daemon();
      const file = join(home.root, 'writes.txt');
      const quiet = ((SWEEP_GRACE_MS - 500) / 1000).toFixed(1);
      const writer = `( trap "" TERM HUP; while :; do echo x >> ${file}; sleep 0.2; done ) &`;
      const spawner =
        `trap "" HUP; trap "t=1" TERM; t=0; while [ $t = 0 ]; do sleep 0.05; done; ` +
        `sleep ${quiet}; while :; do ${writer} sleep 0.01; done`;
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'bash', command: `( ${spawner} ) > /dev/null 2>&1 & echo "pid $!"` },
              { do: 'text', text: 'Done.' },
            ],
          },
        ],
      });
      const run = await start(manager, { limits: { maxNudgesPerRun: 0 } });
      await ended(run.runId, 30_000);
      // Checked at once: nothing of the run may be left when its end is reported.
      expect(markedProcesses(run.runId)).toEqual([]);
      const size = async () => (await stat(file).catch(() => ({ size: 0 }))).size;
      const before = await size();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(await size()).toBe(before);
    },
    TIMEOUT,
  );
});
