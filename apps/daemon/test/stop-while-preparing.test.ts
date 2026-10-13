import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { McpCall } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { findExecutable } from '../src/exec.js';
import { markedProcesses } from '../src/processes.js';
import { runFolder } from '../src/run-socket.js';
import type { RunManager } from '../src/runs.js';
import { sessionName } from '../src/tmux.js';
import { worktreePath } from '../src/workspace.js';
import {
  TIMEOUT,
  answerTools,
  daemon,
  fake,
  home,
  start,
  states,
  tmux,
  useRunnerHarness,
} from './runner-harness.js';
import { fakeExecutable, waitFor } from './testing.js';

// A run stopped while its session is being set up (05, section 4.11; lot 3 step J2s), with the
// real Git and tmux and the fake `claude`: wherever the stop lands (the download, the worktree,
// its configuration, the launch itself; at `run.start`, at `run.resume`, at a CI round resuming
// a closed session), no session is launched, the end is reported once, and nothing of the run
// is left on the machine.

useRunnerHarness();

const SLEEP = findExecutable('sleep', process.env.PATH) ?? '/bin/sleep';

/**
 * Wraps `name` (Git, or the fake `claude`) so that, once armed, its first call whose arguments
 * contain `pattern` waits until released. Each call checks the files, so a test arms it only
 * for the step it stops in.
 */
interface Hold {
  /** The wrapper's path. */
  path: string;
  arm: () => Promise<void>;
  reached: () => Promise<void>;
  release: () => Promise<void>;
}

async function holding(real: string, name: string, pattern: string): Promise<Hold> {
  const folder = join(home.root, `hold-${name}`);
  await mkdir(folder);
  const armed = join(folder, 'armed');
  const reached = join(folder, 'reached');
  const released = join(folder, 'released');
  const path = await fakeExecutable(
    home.bin,
    `held-${name}`,
    [
      `case " $* " in *' ${pattern} '*)`,
      `  if [ -e '${armed}' ] && [ ! -e '${reached}' ]; then`,
      `    : > '${reached}'`,
      `    while [ ! -e '${released}' ]; do '${SLEEP}' 0.05; done`,
      '  fi;;',
      'esac',
      `exec '${real}' "$@"`,
    ].join('\n'),
  );
  return {
    path,
    arm: () => writeFile(armed, ''),
    reached: () => waitFor(() => existsSync(reached), 30_000, `${name} held at "${pattern}"`),
    release: () => writeFile(released, ''),
  };
}

/** A daemon whose own Git commands wait at the first one matching `pattern`, once armed. */
async function gitHeldAt(pattern: string) {
  const hold = await holding(join(home.bin, 'git'), 'git', pattern);
  return { hold, manager: daemon({ git: hold.path, secondMs: 50 }) };
}

/** The fake `claude` waits at `claude --version`, the launch's first step, once armed. */
async function launchHeld() {
  const real = join(home.root, 'claude-real');
  await rename(join(home.bin, 'claude'), real);
  const hold = await holding(real, 'claude', '--version');
  await rename(hold.path, join(home.bin, 'claude'));
  return hold;
}

function stop(manager: RunManager, runId: string) {
  return manager.handle({
    type: 'run.stop',
    id: randomUUID(),
    payload: { runId, reason: 'owner_stopped' },
  });
}

async function sessionsStarted(): Promise<number> {
  return (await fake.log()).filter((entry) => entry.event === 'start').length;
}

/**
 * The stop lands while the step is held: the step is released, and the run must have ended
 * once, reported nothing after its end, launched no session, and left nothing on the machine.
 */
async function stopWhileHeld(
  manager: RunManager,
  runId: string,
  hold: Hold,
  sessionsBefore: number,
  setUp: Promise<unknown> = Promise.resolve(),
): Promise<void> {
  await hold.reached();
  const stopping = stop(manager, runId);
  // Whatever the stop does at once, it does it while the step is still held.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await hold.release();
  expect(await stopping).toEqual({ ok: true });
  await setUp;
  await waitFor(
    () => states(runId).some((state) => state.state === 'ended'),
    30_000,
    'the end of the run',
  );
  // Its folder goes once its reports are acknowledged.
  await waitFor(() => !existsSync(runFolder(home.paths, runId)), 30_000, "the run's folder gone");
  // Whatever the set-up still had to do is over: the daemon awaits it as it stops.
  await manager.shutdown();

  const reported = states(runId);
  expect(reported.filter((state) => state.state === 'ended')).toHaveLength(1);
  expect(reported.at(-1)).toMatchObject({ state: 'ended', reason: 'stopped', sessionAlive: false });
  expect(await sessionsStarted()).toBe(sessionsBefore);
  expect(await tmux.hasSession(sessionName(runId))).toBe(false);
  expect(markedProcesses(runId)).toEqual([]);
  expect(existsSync(worktreePath(home.paths, runId))).toBe(false);
  // Nothing wrote it again.
  expect(existsSync(runFolder(home.paths, runId))).toBe(false);
}

describe('a run stopped while it is prepared', () => {
  for (const [step, pattern] of [
    ['the download from GitHub', 'fetch'],
    ['the worktree', 'worktree add'],
    ["the worktree's configuration", 'user.email'],
  ] as const) {
    it(
      `launches no session when the stop lands during ${step}`,
      async () => {
        const { hold, manager } = await gitHeldAt(pattern);
        await hold.arm();
        const run = await start(manager);
        await stopWhileHeld(manager, run.runId, hold, 0);
      },
      TIMEOUT,
    );
  }

  it(
    'launches no session when the stop lands just before the launch',
    async () => {
      const hold = await launchHeld();
      const manager = daemon({ secondMs: 50 });
      await hold.arm();
      const run = await start(manager);
      await stopWhileHeld(manager, run.runId, hold, 0);
    },
    TIMEOUT,
  );
});

describe('a closed session stopped while it is resumed', () => {
  const ASK = {
    do: 'mcp' as const,
    tool: 'ticket_ask',
    arguments: { question: 'Which colour?' },
  };

  it(
    'launches no session for a waiting run when the stop lands before the launch',
    async () => {
      const hold = await launchHeld();
      const manager = daemon({ secondMs: 50 });
      await fake.play({ turns: [{ steps: [ASK] }] });
      const run = await start(manager, {
        limits: { waitingRunLifetimeMinutes: 1, sessionStartTimeoutSeconds: 600 },
      });
      await waitFor(
        () =>
          states(run.runId).some((state) => state.state === 'waiting_human' && !state.sessionAlive),
        30_000,
        'the waiting run with its session closed',
      );
      const before = await sessionsStarted();
      await hold.arm();
      const resuming = manager.handle({
        type: 'run.resume',
        id: randomUUID(),
        payload: {
          runId: run.runId,
          claudeSessionId: states(run.runId).at(-1)?.claudeSessionId ?? '',
          message: 'Blue.',
          fetchBase: false,
        },
      });
      await stopWhileHeld(manager, run.runId, hold, before, resuming);
    },
    TIMEOUT,
  );

  for (const [step, held] of [
    ['the download of the base branch', 'fetch'],
    ['the launch', 'launch'],
  ] as const) {
    it(
      `launches no session for a CI round when the stop lands during ${step}`,
      async () => {
        const launch = held === 'launch' ? await launchHeld() : null;
        const git = held === 'fetch' ? await gitHeldAt('fetch') : null;
        const manager = git?.manager ?? daemon({ secondMs: 50 });
        const hold = launch ?? git?.hold;
        if (!hold) throw new Error('nothing held');
        answerTools((call: McpCall['payload']) =>
          call.tool === 'ticket_submit'
            ? { ok: true, output: { result: 'pending_ci', ticket: {} } }
            : { ok: true, output: {} },
        );
        await fake.play({
          turns: [
            {
              steps: [
                {
                  do: 'mcp',
                  tool: 'ticket_submit',
                  arguments: {
                    criteria: [{ index: 0, status: 'met', justification: 'Done.' }],
                    tests: { paths: [], justification: 'No code.' },
                    docs: { paths: [], justification: 'No user-visible change.' },
                    adrs: [],
                    summary: 'Nothing to change.',
                  },
                },
              ],
            },
          ],
        });
        const run = await start(manager, { limits: { sessionStartTimeoutSeconds: 600 } });
        await waitFor(
          () => states(run.runId).some((state) => state.state === 'waiting_ci'),
          30_000,
          'the run waiting for CI',
        );
        // Claude Code goes away during the wait: the CI round resumes the closed session.
        await tmux.killSession(sessionName(run.runId));
        await waitFor(
          () =>
            states(run.runId).some((state) => state.state === 'waiting_ci' && !state.sessionAlive),
          30_000,
          'the wait reported with its session closed',
        );
        const before = await sessionsStarted();
        await hold.arm();
        const resuming = manager.handle({
          type: 'run.resume',
          id: randomUUID(),
          payload: {
            runId: run.runId,
            claudeSessionId: states(run.runId).at(-1)?.claudeSessionId ?? '',
            message: 'Your pull request conflicts with main: run git merge origin/main.',
            fetchBase: true,
          },
        });
        await stopWhileHeld(manager, run.runId, hold, before, resuming);
      },
      TIMEOUT,
    );
  }
});
