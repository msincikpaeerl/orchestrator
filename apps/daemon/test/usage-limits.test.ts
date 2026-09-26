import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunQuotaLimited } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { sessionName } from '../src/tmux.js';
import type { ScenarioInput } from './fake-claude/scenario.js';
import {
  TIMEOUT,
  daemon,
  ended,
  fake,
  home,
  messagesReceived,
  sent,
  start,
  states,
  tmux,
  useRunnerHarness,
} from './runner-harness.js';
import { waitFor } from './testing.js';

// Usage limits with the real tmux and the fake `claude` emitting each signal (05, section
// 4.10): detected or suspected, the session closed with the worktree kept, never a nudge.

useRunnerHarness();

const LIMIT = "You've hit your session limit · resets 3:45pm";

function quotaReports(runId: string): RunQuotaLimited['payload'][] {
  return sent
    .filter((message): message is RunQuotaLimited => message.type === 'run.quota_limited')
    .map((message) => message.payload)
    .filter((payload) => payload.runId === runId);
}

/** Plays `scenario`, waits for the pause, and checks what every pause has in common. */
async function paused(
  scenario: ScenarioInput,
  options: { secondMs?: number; idleTimeoutMinutes?: number } = {},
) {
  const manager = daemon({ secondMs: options.secondMs });
  await fake.play(scenario);
  const run = await start(manager, {
    limits: {
      maxNudgesPerRun: 2,
      sessionStartTimeoutSeconds: 600,
      idleTimeoutMinutes: options.idleTimeoutMinutes ?? 10,
    },
  });
  await waitFor(
    () => states(run.runId).at(-1)?.state === 'quota_paused',
    30_000,
    'the run paused on the usage limit',
  );
  expect(states(run.runId).at(-1)).toMatchObject({ state: 'quota_paused', sessionAlive: false });
  expect(await tmux.hasSession(sessionName(run.runId))).toBe(false);
  await stat(join(home.paths.home, 'worktrees', run.runId));
  // No nudge: only the first message reached the agent.
  expect(await messagesReceived()).toEqual([run.initialPrompt]);
  const [report, ...others] = quotaReports(run.runId);
  expect(others).toEqual([]);
  return { manager, run, report };
}

const stopFailure = (error: string, message: string): ScenarioInput => ({
  turns: [
    { steps: [{ do: 'text', text: 'Working.' }], end: { kind: 'stopFailure', error, message } },
  ],
});

describe('detected usage limit', () => {
  it(
    'reads the reset time of the documented message, as local time',
    async () => {
      const { report } = await paused(stopFailure('rate_limit', LIMIT));
      expect(report).toMatchObject({
        kind: 'detected',
        evidence: { signal: 'stop_failure', error: 'rate_limit', message: LIMIT, statusLine: null },
      });
      const resetsAt = new Date(report?.kind === 'detected' ? (report.resetsAt ?? '') : '');
      expect([resetsAt.getHours(), resetsAt.getMinutes()]).toEqual([15, 45]);
      expect(+resetsAt).toBeGreaterThan(Date.now());
      expect(+resetsAt - Date.now()).toBeLessThanOrEqual(24 * 3600 * 1000);
    },
    TIMEOUT,
  );

  it(
    "takes the status line's reset time when a window is full",
    async () => {
      const resetsAt = Math.floor(Date.now() / 1000) + 7200;
      const { report } = await paused({
        turns: [
          {
            steps: [
              {
                do: 'statusLine',
                input: {
                  cost: { total_cost_usd: 3.1 },
                  rate_limits: {
                    five_hour: { used_percentage: 100, resets_at: resetsAt },
                    seven_day: { used_percentage: 40, resets_at: resetsAt + 86_400 },
                  },
                },
              },
            ],
            end: { kind: 'stopFailure', error: 'rate_limit', message: LIMIT },
          },
        ],
      });
      expect(report).toMatchObject({
        kind: 'detected',
        resetsAt: new Date(resetsAt * 1000).toISOString(),
        evidence: { statusLine: { window: 'five_hour', usedPercentage: 100 } },
      });
    },
    TIMEOUT,
  );

  it(
    'has no reset time when neither the message nor the status line gives one',
    async () => {
      const { report } = await paused(stopFailure('rate_limit', "You've hit your weekly limit"));
      expect(report).toMatchObject({ kind: 'detected', resetsAt: null });
    },
    TIMEOUT,
  );

  it(
    'resumes the paused session on run.resume',
    async () => {
      const { manager, run } = await paused(stopFailure('rate_limit', LIMIT));
      const sessionId = states(run.runId).at(-1)?.claudeSessionId ?? '';
      await fake.play({ turns: [{ steps: [{ do: 'text', text: 'Continuing.' }] }] });
      expect(
        await manager.handle({
          type: 'run.resume',
          id: randomUUID(),
          payload: { runId: run.runId, claudeSessionId: sessionId, message: 'Please continue.' },
        }),
      ).toEqual({ ok: true });
      await waitFor(
        async () => (await messagesReceived()).includes('Please continue.'),
        20_000,
        'the message after --resume',
      );
      expect(
        await manager.handle({
          type: 'run.stop',
          id: randomUUID(),
          payload: { runId: run.runId, reason: 'owner_stopped' },
        }),
      ).toEqual({ ok: true });
      expect((await ended(run.runId)).reason).toBe('stopped');
      const launches = (await fake.log()).filter((entry) => entry.event === 'start');
      expect(launches[1]?.event === 'start' && launches[1].args).toContain('--resume');
    },
    TIMEOUT,
  );
});

describe('suspected usage limit', () => {
  it.each([
    ['rate_limit without a known message', 'rate_limit', 'API Error: Rate limited'],
    ['overloaded', 'overloaded', 'API Error: Overloaded'],
    ['server_error', 'server_error', 'API Error: 500 Internal server error'],
  ])(
    'for a StopFailure %s',
    async (_name, error, message) => {
      const { report } = await paused(stopFailure(error, message));
      expect(report).toEqual({
        runId: report?.runId,
        kind: 'suspected',
        evidence: { signal: 'stop_failure', error, message, statusLine: null },
      });
    },
    TIMEOUT,
  );

  it(
    'for an API-error turn with no tool use',
    async () => {
      const { report } = await paused({
        turns: [{ steps: [{ do: 'apiError', text: 'API Error: Request timed out' }] }],
      });
      expect(report).toMatchObject({
        kind: 'suspected',
        evidence: {
          signal: 'api_error_turn',
          error: null,
          message: 'API Error: Request timed out',
        },
      });
    },
    TIMEOUT,
  );

  it(
    'for an idle timeout right after an API error',
    async () => {
      // One minute lasts 1.2 s: the session shows the error, then hangs without a hook.
      const { report } = await paused(
        {
          turns: [
            { steps: [{ do: 'apiError', text: 'API Error: Connection error.' }, { do: 'hang' }] },
          ],
        },
        { secondMs: 20, idleTimeoutMinutes: 1 },
      );
      expect(report).toMatchObject({
        kind: 'suspected',
        evidence: { signal: 'idle_after_api_error', message: 'API Error: Connection error.' },
      });
    },
    TIMEOUT,
  );

  it(
    'not for an API-error turn after a tool use: the turn is nudged as usual',
    async () => {
      const manager = daemon();
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'bash', command: 'true' },
              { do: 'apiError', text: 'API Error: Connection error.' },
            ],
          },
        ],
      });
      const run = await start(manager, { limits: { maxNudgesPerRun: 1 } });
      expect((await ended(run.runId)).reason).toBe('nudges_exhausted');
      expect(quotaReports(run.runId)).toEqual([]);
      expect(await messagesReceived()).toEqual([run.initialPrompt, run.nudgeMessage]);
    },
    TIMEOUT,
  );
});
