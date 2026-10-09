import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DodReport } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { stateFilePath } from '../src/run-files.js';
import { sessionName } from '../src/tmux.js';
import {
  TIMEOUT,
  answerTools,
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

// A run waiting for CI on the daemon (05, sections 4.7 and 4.9; lot 3 step G1a): an accepted
// `ticket_submit` answering `pending_ci` moves the run to `waiting_ci` at the turn's end, with no
// reminder, no working time and no idle timeout; `run.stop` `completed` ends it `submitted`; a
// session that ends during the wait does not end the run.

useRunnerHarness();

const SUBMISSION: DodReport = {
  criteria: [{ index: 0, status: 'met', justification: 'Notes are saved.' }],
  tests: { paths: [], justification: 'No code.' },
  docs: { paths: [], justification: 'No user-visible change.' },
  adrs: [],
  summary: 'Adds notes.',
};

const COMMIT = 'echo notes > notes.md && git add notes.md && git commit -q -m "Add notes"';

function pendingCi(): void {
  answerTools((call) =>
    call.tool === 'ticket_submit'
      ? { ok: true, output: { result: 'pending_ci', ticket: {} } }
      : { ok: true, output: {} },
  );
}

function stop(manager: ReturnType<typeof daemon>, runId: string, reason: 'completed') {
  return manager.handle({ type: 'run.stop', id: randomUUID(), payload: { runId, reason } });
}

async function waitingCi(runId: string): Promise<void> {
  await waitFor(
    () => states(runId).some((state) => state.state === 'waiting_ci'),
    30_000,
    'the run waiting for CI',
  );
}

describe('a run waiting for CI', () => {
  it(
    'waits after pending_ci without a reminder, then ends submitted on run.stop completed',
    async () => {
      pendingCi();
      const manager = daemon();
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'bash', command: COMMIT },
              { do: 'mcp', tool: 'ticket_submit', arguments: SUBMISSION },
              { do: 'text', text: 'Submitted; waiting for CI.' },
            ],
          },
        ],
      });
      const run = await start(manager);
      await waitingCi(run.runId);
      const waiting = states(run.runId).find((state) => state.state === 'waiting_ci');
      expect(waiting?.sessionAlive).toBe(true);
      expect(await stop(manager, run.runId, 'completed')).toEqual({ ok: true });
      const end = await ended(run.runId);
      expect(end.reason).toBe('submitted');
      // An accepted submission pushed already: no end push.
      expect(end.push).toBeNull();
      // No reminder: only the first message reached the session.
      expect(await messagesReceived()).toEqual(['Implement ticket NOTES-1.']);
    },
    TIMEOUT,
  );

  it(
    'counts no working time and no idle time while waiting',
    async () => {
      pendingCi();
      // One minute of a setting lasts 4.8 s: enough for the work before the submission.
      const manager = daemon({ secondMs: 80 });
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'bash', command: COMMIT },
              { do: 'mcp', tool: 'ticket_submit', arguments: SUBMISSION },
            ],
          },
        ],
      });
      const run = await start(manager, {
        limits: {
          maxRunDurationMinutes: 1,
          idleTimeoutMinutes: 1,
          maxNudgesPerRun: 2,
          sessionStartTimeoutSeconds: 600,
        },
      });
      await waitingCi(run.runId);
      const file = stateFilePath(home.paths, run.runId);
      const read = () => JSON.parse(readFileSync(file, 'utf8')) as { workingMs: number };
      const workedBefore = read().workingMs;
      // Proving that nothing happens needs the clock to pass both limits, twice each.
      const since = Date.now();
      await waitFor(() => Date.now() - since > 2 * 4800, 30_000, 'both limits passed twice');
      expect(states(run.runId).at(-1)?.state).toBe('waiting_ci');
      expect(read().workingMs).toBe(workedBefore);
      expect(await stop(manager, run.runId, 'completed')).toEqual({ ok: true });
      expect((await ended(run.runId)).reason).toBe('submitted');
      expect(await messagesReceived()).toEqual(['Implement ticket NOTES-1.']);
    },
    TIMEOUT,
  );

  it(
    'keeps waiting with its session closed when the session ends, then ends submitted',
    async () => {
      pendingCi();
      const manager = daemon({ secondMs: 50 });
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'bash', command: COMMIT },
              { do: 'mcp', tool: 'ticket_submit', arguments: SUBMISSION },
            ],
          },
        ],
      });
      const run = await start(manager, { limits: { sessionStartTimeoutSeconds: 600 } });
      await waitingCi(run.runId);
      // Claude Code goes away during the wait (it crashed, or was closed).
      await tmux.killSession(sessionName(run.runId));
      await waitFor(
        () =>
          states(run.runId).some((state) => state.state === 'waiting_ci' && !state.sessionAlive),
        30_000,
        'the wait reported with its session closed',
      );
      expect(states(run.runId).some((state) => state.state === 'ended')).toBe(false);
      expect(await stop(manager, run.runId, 'completed')).toEqual({ ok: true });
      expect((await ended(run.runId)).reason).toBe('submitted');
    },
    TIMEOUT,
  );

  it(
    'finds the wait again after a daemon restart',
    async () => {
      pendingCi();
      const first = daemon();
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'bash', command: COMMIT },
              { do: 'mcp', tool: 'ticket_submit', arguments: SUBMISSION },
            ],
          },
        ],
      });
      const run = await start(first);
      await waitingCi(run.runId);
      await first.shutdown();
      const second = daemon();
      await second.recover();
      expect(second.list().find((each) => each.runId === run.runId)?.state).toBe('waiting_ci');
      expect(await stop(second, run.runId, 'completed')).toEqual({ ok: true });
      expect((await ended(run.runId)).reason).toBe('submitted');
    },
    TIMEOUT,
  );
});
