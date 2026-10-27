import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { RunStateFile, readJson, stateFilePath, writeJsonAtomic } from '../src/run-files.js';
import { sessionName } from '../src/tmux.js';
import {
  TIMEOUT,
  daemon,
  ended,
  fake,
  home,
  messagesReceived,
  start,
  states,
  tmux,
  useRunnerHarness,
} from './runner-harness.js';
import { waitFor } from './testing.js';

// A launch's message that Claude Code never takes (lot 5 step 5bis E): once `SessionStart` came,
// the message must reach its `UserPromptSubmit` hook within the session start timeout, or the run
// ends `launch_failed`, not counted. With `secondMs: 100`, 60 "seconds" are 6 seconds.

useRunnerHarness();

const SECOND_MS = 100;
const WINDOW_SECONDS = 60;
const WINDOW_MS = WINDOW_SECONDS * SECOND_MS;

const NOT_TAKEN = `Claude Code started but did not take its first message within ${String(WINDOW_SECONDS)} seconds, the "Session start timeout" setting: a startup dialog or a change in Claude Code is suspected. Running it again on this machine will not help until that is fixed, and it is not the ticket's fault.`;

const limits = { sessionStartTimeoutSeconds: WINDOW_SECONDS };

/** The run's `state.json`, read again. */
function savedState(runId: string) {
  return RunStateFile.parse(readJson(stateFilePath(home.paths, runId)));
}

const isEnded = (runId: string) => states(runId).some((state) => state.state === 'ended');

async function stop(manager: ReturnType<typeof daemon>, runId: string): Promise<void> {
  await manager.handle({
    type: 'run.stop',
    id: randomUUID(),
    payload: { runId, reason: 'owner_stopped' },
  });
  expect((await ended(runId)).reason).toBe('stopped');
}

describe('the first message of a launch', () => {
  it(
    'ends a start whose message is never taken launch_failed, without Claude Code left running',
    async () => {
      const manager = daemon({ secondMs: SECOND_MS });
      await fake.play({ firstMessageNotTaken: true });
      const run = await start(manager, { limits });
      await waitFor(() => states(run.runId).some((state) => state.state === 'working'), 20_000);
      expect(savedState(run.runId).messageTaken).toBe(false);

      const end = await ended(run.runId);
      expect(end).toMatchObject({ reason: 'launch_failed', sessionAlive: false });
      expect(end.detail).toBe(NOT_TAKEN);
      expect(await messagesReceived()).toEqual([]);
      expect(await tmux.hasSession(sessionName(run.runId))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'ends a resume whose message is never taken launch_failed',
    async () => {
      const manager = daemon({ secondMs: SECOND_MS });
      await fake.play({
        turns: [
          {
            steps: [{ do: 'text', text: 'Working.' }],
            end: {
              kind: 'stopFailure',
              error: 'rate_limit',
              message: "You've hit your session limit · resets 3:45pm",
            },
          },
        ],
      });
      const run = await start(manager, { limits });
      await waitFor(
        () => states(run.runId).at(-1)?.state === 'quota_paused',
        30_000,
        'the run paused on the usage limit',
      );
      expect(savedState(run.runId).messageTaken).toBe(true);
      const sessionId = states(run.runId).at(-1)?.claudeSessionId ?? '';

      await fake.play({ firstMessageNotTaken: true });
      expect(
        await manager.handle({
          type: 'run.resume',
          id: randomUUID(),
          payload: { runId: run.runId, claudeSessionId: sessionId, message: 'Go on.' },
        }),
      ).toEqual({ ok: true });
      const end = await ended(run.runId);
      expect(end).toMatchObject({ reason: 'launch_failed', sessionAlive: false });
      expect(end.detail).toBe(NOT_TAKEN);
      expect(await messagesReceived()).toEqual([run.initialPrompt]);
      expect(await tmux.hasSession(sessionName(run.runId))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'goes on when the message is taken late, but within the window',
    async () => {
      const manager = daemon({ secondMs: SECOND_MS });
      await fake.play({
        firstMessageDelayMs: WINDOW_MS / 3,
        turns: [{ steps: [{ do: 'hang' }] }],
      });
      const run = await start(manager, { limits });
      await waitFor(() => states(run.runId).some((state) => state.state === 'working'), 20_000);
      const working = Date.now();
      await waitFor(() => savedState(run.runId).messageTaken, 20_000, 'the message taken');
      await sleep(Math.max(0, working + WINDOW_MS + 1500 - Date.now()));
      expect(isEnded(run.runId)).toBe(false);
      // The hook gets in no one's way: exit 0, nothing added to the agent's context.
      const hooks = (await fake.log()).filter(
        (entry) => entry.event === 'hook' && entry.hook === 'UserPromptSubmit',
      );
      expect(hooks).toEqual([{ event: 'hook', hook: 'UserPromptSubmit', exitCode: 0, stdout: '' }]);
      await stop(manager, run.runId);
    },
    TIMEOUT,
  );

  it(
    "goes on when the hook's prompt differs from the message by trailing white space (owner's rule)",
    async () => {
      const manager = daemon({ secondMs: SECOND_MS });
      await fake.play({ promptTrimmed: true, turns: [{ steps: [{ do: 'hang' }] }] });
      const run = await start(manager, {
        limits,
        initialPrompt: 'Implement ticket NOTES-1.\n\n  ',
      });
      await waitFor(() => states(run.runId).some((state) => state.state === 'working'), 20_000);
      const working = Date.now();
      await waitFor(() => savedState(run.runId).messageTaken, 20_000, 'the message taken');
      await sleep(Math.max(0, working + WINDOW_MS + 1500 - Date.now()));
      expect(isEnded(run.runId)).toBe(false);
      expect(await messagesReceived()).toEqual(['Implement ticket NOTES-1.\n\n  ']);
      await stop(manager, run.runId);
    },
    TIMEOUT,
  );

  it(
    'gives a fresh window after a daemon restart, from the restart',
    async () => {
      const first = daemon({ secondMs: SECOND_MS });
      await fake.play({ firstMessageNotTaken: true });
      const run = await start(first, { limits });
      await waitFor(() => states(run.runId).some((state) => state.state === 'working'), 20_000);
      await first.shutdown();
      // Longer than the window: the first daemon's clock is not carried over.
      await sleep(WINDOW_MS + 500);

      const second = daemon({ secondMs: SECOND_MS });
      const recovered = Date.now();
      await second.recover();
      await sleep(WINDOW_MS / 2);
      expect(isEnded(run.runId)).toBe(false);
      const end = await ended(run.runId);
      expect(Date.now() - recovered).toBeGreaterThanOrEqual(WINDOW_MS);
      expect(end).toMatchObject({ reason: 'launch_failed', detail: NOT_TAKEN });
      expect(await tmux.hasSession(sessionName(run.runId))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'counts the message taken for a state.json written by an older daemon',
    async () => {
      const first = daemon({ secondMs: SECOND_MS });
      await fake.play({ firstMessageNotTaken: true });
      const run = await start(first, { limits });
      await waitFor(() => states(run.runId).some((state) => state.state === 'working'), 20_000);
      await first.shutdown();
      const file = stateFilePath(home.paths, run.runId);
      const older = readJson(file) as Record<string, unknown>;
      delete older.messageTaken;
      writeJsonAtomic(file, older);

      const second = daemon({ secondMs: SECOND_MS });
      await second.recover();
      await sleep(WINDOW_MS + 1500);
      expect(isEnded(run.runId)).toBe(false);
      await stop(second, run.runId);
    },
    TIMEOUT,
  );
});
