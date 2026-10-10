import { CiCheckFailureReason, type CiCheckFailure, type RunCiWait } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { formatDateTime } from '../github/text';
import { findPage } from '../help/content';
import {
  WAITING_FOR_CI,
  ciCheckKindLabel,
  ciCheckStateLabel,
  ciProblemReason,
  ciProblemText,
  ciWaitText,
} from './ci-text';
import { cardRunText, runStateText } from './text';

// The run page's CI card (lot 3 step G1b, owner's addition 4): every state's sentence and every
// reason of the GitHub-problem line in the owner's words, no internal name, and the labels the
// card shows present in Help.

const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';
const SUBMITTED = '2026-10-09T10:00:00.000Z';
const SINCE = '2026-10-09T10:01:00.000Z';
const START_DEADLINE = '2026-10-09T10:06:00.000Z';
const DEADLINE = '2026-10-09T10:21:00.000Z';
const CHECKED = '2026-10-09T10:04:00.000Z';
const BEFORE_START_DEADLINE = new Date('2026-10-09T10:05:00.000Z');
const AFTER_START_DEADLINE = new Date('2026-10-09T10:07:00.000Z');

function wait(changes: Partial<RunCiWait> = {}): RunCiWait {
  return {
    commit: COMMIT,
    submittedAt: SUBMITTED,
    since: SINCE,
    waitingSince: SINCE,
    deadline: DEADLINE,
    startDeadline: START_DEADLINE,
    result: null,
    checkedAt: CHECKED,
    checkFailure: null,
    pullRequest: { number: 12, url: 'https://github.com/octo-owner/bakery/pull/12' },
    base: 'main',
    ...changes,
  };
}

const pending = (checks: number): NonNullable<RunCiWait['result']> => ({
  state: 'pending',
  checks: Array.from({ length: checks }, (_, index) => ({
    kind: 'workflow_run' as const,
    name: `CI ${String(index)}`,
    state: 'pending' as const,
    url: null,
    run_id: index + 1,
    cancelled: false,
  })),
  failed_jobs: [],
  jobs_read: false,
  jobs_problem: null,
});

/** Every state of the card, as the screens can meet it. */
const STATES: Record<string, { ci: RunCiWait; now: Date }> = {
  'waiting normally': { ci: wait({ result: pending(2) }), now: AFTER_START_DEADLINE },
  'the pull request not opened yet': {
    ci: wait({ since: null, startDeadline: null, pullRequest: null, checkedAt: null }),
    now: BEFORE_START_DEADLINE,
  },
  'nothing appeared yet': { ci: wait({ result: pending(0) }), now: BEFORE_START_DEADLINE },
  'not checked yet': { ci: wait({ checkedAt: null }), now: BEFORE_START_DEADLINE },
  'a conflict being worked out': { ci: wait({ result: pending(0) }), now: AFTER_START_DEADLINE },
  'a conflict': {
    ci: wait({ result: { ...pending(0), state: 'conflict' } }),
    now: AFTER_START_DEADLINE,
  },
};

function stateOf(name: string): RunCiWait {
  const found = STATES[name];
  if (!found) throw new Error(`no state ${name}`);
  return found.ci;
}

const failure = (reason: CiCheckFailureReason, changes: Partial<CiCheckFailure> = {}) => ({
  reason,
  message: 'Resource not accessible by personal access token',
  fields: reason === 'unreadable' ? ['state: expected a text'] : [],
  since: '2026-10-09T10:02:00.000Z',
  at: CHECKED,
  retryAt: null,
  ...changes,
});

/** Names from the code and GitHub's API the owner never reads. */
const INTERNAL = [
  /\w_\w/, // pending_ci, waiting_ci, ci_timeout, no_ci, head_sha, run_id...
  /\bpending\b/i,
  /\bmergeable\b/i,
  /\bsha\b/i,
  /\bcompleted\b/,
  /\bconclusion\b/i,
  /\bqueued\b/i,
  /\bnull\b/,
  /\bundefined\b/,
];

function expectOwnerWords(text: string) {
  expect(text.trim()).not.toBe('');
  for (const pattern of INTERNAL) expect(text).not.toMatch(pattern);
}

describe('the CI card while a run waits for CI', () => {
  it.each(Object.entries(STATES))('%s: in plain words', (_, { ci, now }) => {
    for (const line of ciWaitText(ci, now)) expectOwnerWords(line);
  });

  it('says what the run waits for, since and until when, and when GitHub was last checked', () => {
    expect(ciWaitText(stateOf('waiting normally'), AFTER_START_DEADLINE)).toEqual([
      `Waiting for CI on GitHub for commit abc1234 (pull request #12) since ${formatDateTime(SINCE)}. If CI has not finished by ${formatDateTime(DEADLINE)}, the run stops without counting as a failed attempt.`,
      `Last checked at ${formatDateTime(CHECKED)}.`,
    ]);
  });

  it('says the pull request is not opened yet, from when the work was accepted', () => {
    expect(ciWaitText(stateOf('the pull request not opened yet'), BEFORE_START_DEADLINE)).toEqual([
      `The work was accepted at ${formatDateTime(SUBMITTED)}, but the pull request is not opened yet, so CI cannot start. The Orchestrator tries again at every check; see the ticket for why. If it is still not opened at ${formatDateTime(DEADLINE)}, the run stops without counting as a failed attempt.`,
    ]);
  });

  it('says nothing appeared yet and by when, then that a conflict is being worked out', () => {
    expect(ciWaitText(stateOf('nothing appeared yet'), BEFORE_START_DEADLINE)[2]).toBe(
      `No CI run or status has appeared on GitHub yet. If none appears by ${formatDateTime(START_DEADLINE)}, the work is accepted as “No CI found”, unless the pull request conflicts with main.`,
    );
    expect(ciWaitText(stateOf('a conflict being worked out'), AFTER_START_DEADLINE)[2]).toBe(
      'Nothing appeared on GitHub. GitHub is still working out whether the pull request conflicts with main; it is checked again shortly.',
    );
  });

  it('says a conflict keeps the work from being accepted', () => {
    expect(ciWaitText(stateOf('a conflict'), AFTER_START_DEADLINE)[2]).toBe(
      'The pull request conflicts with main, so GitHub started no CI and the work cannot be accepted: the agent is told to merge main and resolve the conflict, then hand its work in again.',
    );
  });
});

describe('the line when GitHub could not be checked', () => {
  it.each(CiCheckFailureReason.options)('%s has its reason in plain words', (reason) => {
    expectOwnerWords(ciProblemText(failure(reason)));
  });

  it('says since when, why, and that the run keeps waiting', () => {
    expect(ciProblemText(failure('unreachable'))).toBe(
      `GitHub could not be checked at ${formatDateTime(CHECKED)} (since ${formatDateTime('2026-10-09T10:02:00.000Z')}): GitHub could not be reached, or answered with a server error. The run keeps waiting and the Orchestrator asks again.`,
    );
  });

  it('gives the time GitHub allows requests again, when GitHub said', () => {
    const retryAt = '2026-10-09T10:30:00.000Z';
    expect(ciProblemReason(failure('rate_limited', { retryAt }))).toBe(
      `GitHub's request limit was reached; it allows requests again at ${formatDateTime(retryAt)}`,
    );
    expect(ciProblemReason(failure('rate_limited'))).toBe(
      "GitHub's request limit was reached; GitHub did not say when it allows requests again",
    );
  });

  it("never shows the server's own words about the token", () => {
    const decrypt = failure('token', {
      message:
        'The saved GitHub token cannot be decrypted (ORCHESTRATOR_SECRET_KEY changed): save the token again in Settings',
    });
    expect(ciProblemReason(decrypt)).toBe('the saved token cannot be used');
    expect(
      ciProblemReason(
        failure('token', { message: 'No GitHub token is saved: connect GitHub in Settings' }),
      ),
    ).toBe('no GitHub token is saved');
  });
});

describe('the status line of a run waiting for CI', () => {
  const machine = { id: '3f1e0e8c-2222-4000-8000-000000000000', name: 'Laptop', online: true };

  it('reads "Waiting for CI" instead of "Running", on the run page and the board', () => {
    const run = {
      status: 'running' as const,
      pauseReason: null,
      failureReason: null,
      machine,
      ci: wait(),
    };
    expect(runStateText(run)).toBe(WAITING_FOR_CI);
    expect(runStateText({ ...run, ci: null })).toBe('Running');
    const card = { id: machine.id, status: 'running' as const, pauseReason: null, machine };
    expect(cardRunText({ ...card, progress: null, waitingForCi: true }).status).toBe(
      'Waiting for CI on Laptop',
    );
    expect(cardRunText({ ...card, progress: null, waitingForCi: false }).status).toBe(
      'Running on Laptop',
    );
  });
});

describe('Help > Runs uses the words of the CI card', () => {
  const runs = findPage('runs')?.markdown ?? '';

  it('names the status and every state of a check', () => {
    expect(runs).toContain(`**${WAITING_FOR_CI}**`);
    for (const label of Object.values(ciCheckStateLabel)) expect(runs).toContain(`**${label}**`);
  });

  it('says what a workflow run and a status are, by the words of the check lines', () => {
    for (const kind of Object.values(ciCheckKindLabel)) expect(runs).toContain(`· ${kind}`);
  });
});
