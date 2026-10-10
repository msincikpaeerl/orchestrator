import type {
  CheckCiAgainResponse,
  CiCheckView,
  NeedsYouItem,
  RunCiHistory,
  RunCiOutcome,
  TicketCi,
} from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { formatDateTime } from '../github/text';
import {
  checkCiAgainText,
  ciHistoryLines,
  ciTimeoutItemText,
  failedChecksText,
  ticketCiText,
} from './ci-outcome-text';

// What a run's CI came to, in the owner's words (owner's answers, lot 3 steps G2 and G2c): the
// ticket page's CI line, the ended run's CI card, the "Needs you" items of a run ended at CI wait
// at submission, and what Check CI again found. No internal name ever reaches the owner.

const A = 'abc1234def5678abc1234def5678abc1234def56';
const B = 'def5678abc1234def5678abc1234def5678abc12';
const AT = '2026-10-10T14:52:00.000Z';
const LATER = '2026-10-10T15:10:00.000Z';
const SUBMITTED = '2026-10-10T14:02:00.000Z';

const failedCheck: CiCheckView = { kind: 'workflow_run', name: 'test', state: 'failed', url: null };
const passedCheck: CiCheckView = { kind: 'status', name: 'deploy', state: 'passed', url: null };

function outcome(changes: Partial<RunCiOutcome>): RunCiOutcome {
  return {
    kind: 'not_finished',
    commit: A,
    at: AT,
    checks: [failedCheck, passedCheck],
    conflict: false,
    notSent: null,
    failures: 0,
    anyConflict: false,
    round: null,
    pullRequestHead: null,
    pullRequestOpened: true,
    acceptedLater: null,
    ...changes,
  };
}

function ci(changes: Partial<RunCiOutcome>, more: Partial<TicketCi> = {}): TicketCi {
  return {
    runId: '3f1e0e8c-2222-4000-8000-000000000001',
    attempt: 1,
    machine: { id: '3f1e0e8c-2222-4000-8000-000000000002', name: 'Laptop' },
    failureReason: 'ci_timeout',
    endedAt: AT,
    submittedAt: SUBMITTED,
    waitMinutes: 20,
    maxCiFailures: 2,
    base: 'main',
    outcome: outcome(changes),
    checkCiAgain: false,
    ...more,
  };
}

const TICKET = { projectKey: 'WEB', number: 12, workflowFlag: null };

/** Names from the code and GitHub's API the owner never reads. */
const INTERNAL = [/\w_\w/, /\bpending\b/i, /\bmergeable\b/i, /\bnull\b/, /\bundefined\b/];
function expectOwnerWords(text: string) {
  expect(text.trim()).not.toBe('');
  for (const pattern of INTERNAL) expect(text).not.toMatch(pattern);
}

describe('the failed checks', () => {
  it('names each failed check with what it is', () => {
    expect(failedChecksText([failedCheck, passedCheck, { ...passedCheck, state: 'failed' }])).toBe(
      'test · workflow, deploy · status',
    );
  });
});

describe("the ticket page's CI line", () => {
  it('while waiting, passed, and No CI found (with workflow files changed)', () => {
    expect(ticketCiText(ci({ kind: 'waiting' }, { failureReason: null }), TICKET)).toEqual([
      `CI: waiting on GitHub for commit abc1234 since ${formatDateTime(SUBMITTED)}. See the run for each check.`,
    ]);
    expect(ticketCiText(ci({ kind: 'passed' }, { failureReason: null }), TICKET)).toEqual([
      `CI passed on GitHub for commit abc1234 (checked at ${formatDateTime(AT)}).`,
    ]);
    expect(ticketCiText(ci({ kind: 'no_ci' }), TICKET)).toEqual([
      'No CI found: nothing ran on GitHub for commit abc1234, so the work was accepted without CI.',
    ]);
    expect(ticketCiText(ci({ kind: 'no_ci' }), { ...TICKET, workflowFlag: 'changed' })).toEqual([
      'No CI found, and the work changed workflow files: the agent may have removed or weakened CI. Read the changes in .github/workflows/ before merging.',
    ]);
  });

  it('after too many failures: counts failures, or failures or conflicts, never rounds (owner 3a, 3c)', () => {
    expect(
      ticketCiText(ci({ kind: 'too_many', failures: 3 }, { failureReason: 'ci_failed' }), TICKET),
    ).toEqual([
      'CI failed on GitHub for commit abc1234: test · workflow. The run ended after 3 CI failures (Most CI failures per run: 2).',
      "Run now gives the failure to the next run's agent. If you re-ran the failed jobs on GitHub, Check CI again reads the result again.",
    ]);
    expect(
      ticketCiText(
        ci({ kind: 'too_many', failures: 3, anyConflict: true }, { failureReason: 'ci_failed' }),
        TICKET,
      )[0],
    ).toContain('The run ended after 3 CI failures or conflicts (Most CI failures per run: 2).');
    expect(
      ticketCiText(
        ci(
          { kind: 'too_many', failures: 2, conflict: true, anyConflict: true, checks: [] },
          { failureReason: 'ci_failed', maxCiFailures: 1 },
        ),
        TICKET,
      ),
    ).toEqual([
      'The pull request conflicts with main, so GitHub ran no CI for commit abc1234. The run ended after 2 CI failures or conflicts (Most CI failures per run: 1).',
      'Run now lets the agent merge main and resolve the conflict.',
    ]);
  });

  it('CI did not finish, and a pull request never opened (owner 3e)', () => {
    expect(ticketCiText(ci({ kind: 'not_finished' }), TICKET)).toEqual([
      'CI had not finished on GitHub for commit abc1234 when CI wait at submission (20 minutes) was reached.',
      'If CI has finished since, Check CI again accepts the work without starting a session.',
    ]);
    expect(ticketCiText(ci({ kind: 'not_finished', pullRequestOpened: false }), TICKET)).toEqual([
      'The pull request could not be opened on GitHub before CI wait at submission (20 minutes) was reached, so CI never ran for commit abc1234.',
      'Use Try again in "Pull request not opened" first, then Check CI again.',
    ]);
    const open = { ...TICKET, pullRequest: { opened: { number: 12, state: 'open' } } };
    expect(ticketCiText(ci({ kind: 'not_finished', pullRequestOpened: false }), open)).toEqual([
      'The pull request could not be opened on GitHub before CI wait at submission (20 minutes) was reached, so CI never ran then for commit abc1234.',
      'Pull request #12 is open now: once CI has finished on GitHub, Check CI again accepts the work without starting a session.',
    ]);
  });

  it('CI failed and the agent did not get the result (owner answer 1)', () => {
    expect(
      ticketCiText(
        ci({ kind: 'not_received', notSent: { why: 'read_late', message: null } }),
        TICKET,
      ),
    ).toEqual([
      "CI failed on GitHub for commit abc1234 (failed: test · workflow), and the run's wait ended before the agent received the result.",
      "Run now gives the failure to the next run's agent. If you re-ran the failed jobs on GitHub, Check CI again reads the result again.",
    ]);
  });

  it('a conflict not resolved, with the machine refusal when there was one', () => {
    expect(
      ticketCiText(
        ci({
          kind: 'conflict',
          conflict: true,
          checks: [],
          notSent: {
            why: 'refused',
            message: 'Downloading main from GitHub failed: GitHub could not be reached',
          },
        }),
        TICKET,
      ),
    ).toEqual([
      "The pull request conflicts with main, so GitHub ran no CI for commit abc1234, and the run's wait ended before the agent merged it (machine Laptop: Downloading main from GitHub failed: GitHub could not be reached).",
      'Run now lets the agent merge main and resolve the conflict.',
    ]);
  });

  it('cancelled because the branch changed (owner 3b)', () => {
    expect(
      ticketCiText(
        ci({ kind: 'cancelled', pullRequestHead: B }, { failureReason: 'ci_cancelled' }),
        TICKET,
      ),
    ).toEqual([
      "CI was cancelled on GitHub because the branch changed there (the pull request's head is now def5678).",
      "Run now continues from GitHub's branch.",
    ]);
  });

  it('a run that ended after a round sent back, Run now only (owner 3g)', () => {
    expect(
      ticketCiText(ci({ kind: 'after_round', round: 1 }, { failureReason: 'timeout' }), TICKET),
    ).toEqual([
      'CI failed on GitHub for commit abc1234: test · workflow. The result was sent back to the agent as CI round 1, and the run then ended: it ran out of time.',
      'Run now starts the next run.',
    ]);
    expect(
      ticketCiText(
        ci(
          { kind: 'after_round', round: 2, conflict: true, checks: [] },
          { failureReason: 'cancelled' },
        ),
        TICKET,
      )[0],
    ).toBe(
      'The pull request conflicted with main for commit abc1234. This was sent back to the agent as CI round 2, and the run then ended: it was cancelled.',
    );
  });

  it('accepted later by Check CI again, the failed attempt taken back (owner 3d)', () => {
    expect(
      ticketCiText(
        ci({
          kind: 'too_many',
          acceptedLater: { at: LATER, state: 'passed', attemptTakenBack: true },
        }),
        TICKET,
      ),
    ).toEqual([
      `CI passed on GitHub for commit abc1234 (checked again by you at ${formatDateTime(LATER)}): the work was accepted without a session, and the failed attempt of that run no longer counts.`,
    ]);
  });

  it('every kind in plain words', () => {
    for (const kind of [
      'waiting',
      'passed',
      'no_ci',
      'too_many',
      'not_finished',
      'not_received',
      'conflict',
      'cancelled',
      'after_round',
      'ended',
    ] as const) {
      for (const line of ticketCiText(ci({ kind, round: 1 }), TICKET)) expectOwnerWords(line);
    }
  });
});

describe("the ended run's CI card, one line per round (owner answer 2)", () => {
  const history = (changes: Partial<RunCiOutcome>, rounds: RunCiHistory['rounds'] = []) => ({
    maxCiFailures: 2,
    waitMinutes: 20,
    base: 'main',
    rounds,
    outcome: outcome(changes),
  });
  const round = (number: number, kind: 'failed' | 'conflict', confirmed = true) => ({
    round: number,
    kind,
    commit: number === 1 ? B : A,
    readAt: AT,
    confirmedAt: confirmed ? AT : null,
    checks: kind === 'failed' ? [failedCheck] : [],
  });
  const run = {
    machine: { name: 'Laptop' },
    status: 'failed' as const,
    failureReason: 'ci_failed' as const,
  };
  const labels = (h: RunCiHistory, r: Parameters<typeof ciHistoryLines>[1] = run) =>
    ciHistoryLines(h, r).map((line) => line.label);

  it('rounds sent back, then the failure that ended the run, never numbered', () => {
    expect(
      labels(
        history({ kind: 'too_many', failures: 3 }, [round(1, 'failed'), round(2, 'conflict')]),
      ),
    ).toEqual([
      `Round 1 · commit def5678 · Failed at ${formatDateTime(AT)} · sent back to the agent`,
      `Round 2 · commit abc1234 · Conflicts with main at ${formatDateTime(AT)} · sent back to the agent`,
      `Not sent back · commit abc1234 · Failed at ${formatDateTime(AT)} · the run ended: one failure more than Most CI failures per run (2)`,
    ]);
  });

  it('a round the machine did not confirm', () => {
    const timedOut = { ...run, failureReason: 'ci_timeout' as const };
    expect(
      labels(
        history({ kind: 'not_received', notSent: { why: 'not_confirmed', message: null } }, [
          round(1, 'failed', false),
        ]),
        timedOut,
      ),
    ).toEqual([
      `Not confirmed · commit def5678 · Failed at ${formatDateTime(AT)} · machine Laptop did not confirm it received the result before CI wait at submission was reached; not counted`,
    ]);
    expect(
      labels(
        history({ kind: 'conflict', notSent: { why: 'not_confirmed', message: null } }, [
          round(1, 'conflict', false),
        ]),
        timedOut,
      ),
    ).toEqual([
      `Not confirmed · commit def5678 · Conflicts with main at ${formatDateTime(AT)} · machine Laptop did not confirm it received the message to merge main before CI wait at submission was reached; not counted`,
    ]);
  });

  it('a failure read only after the wait, and a round refused, from the refusal kept', () => {
    const timedOut = { ...run, failureReason: 'ci_timeout' as const };
    expect(
      labels(
        history({ kind: 'not_received', notSent: { why: 'read_late', message: null } }),
        timedOut,
      ),
    ).toEqual([
      `Not sent back · commit abc1234 · Failed at ${formatDateTime(AT)} · read on GitHub only after CI wait at submission was reached; not counted`,
    ]);
    expect(
      labels(
        history({
          kind: 'conflict',
          conflict: true,
          notSent: { why: 'refused', message: 'Downloading main from GitHub failed: x' },
        }),
        timedOut,
      ),
    ).toEqual([
      `Not sent back · commit abc1234 · Conflicts with main at ${formatDateTime(AT)} · Downloading main from GitHub failed: x; not counted`,
    ]);
  });

  it('accepted later, the attempt taken back', () => {
    expect(
      labels(
        history({
          kind: 'too_many',
          failures: 1,
          acceptedLater: { at: LATER, state: 'passed', attemptTakenBack: true },
        }),
      ).at(-1),
    ).toBe(
      `Accepted later · Check CI again found CI passed at ${formatDateTime(LATER)}; the failed attempt of this run no longer counts`,
    );
  });

  it('every end in plain words', () => {
    for (const kind of ['passed', 'no_ci', 'not_finished', 'cancelled', 'ended'] as const) {
      for (const label of labels(history({ kind, pullRequestHead: B }))) expectOwnerWords(label);
    }
  });
});

describe('"Needs you" after CI wait at submission (owner answer 1)', () => {
  const item = (changes: Partial<RunCiOutcome>, pullRequest: number | null = 12) =>
    ({
      type: 'ci_timeout',
      ticket: { projectKey: 'WEB', number: 12, title: 'Contact form' },
      runId: '3f1e0e8c-2222-4000-8000-000000000001',
      machine: { id: '3f1e0e8c-2222-4000-8000-000000000002', name: 'Laptop' },
      submittedAt: SUBMITTED,
      pullRequest,
      waitMinutes: 20,
      base: 'main',
      outcome: outcome(changes),
      since: AT,
    }) satisfies Extract<NeedsYouItem, { type: 'ci_timeout' }>;

  it('CI did not finish, with Check CI again', () => {
    expect(ciTimeoutItemText(item({}))).toEqual({
      title: 'CI did not finish for WEB-12: Contact form',
      detail: `The agent handed its work in at ${formatDateTime(SUBMITTED)} (commit abc1234, pull request #12), but CI on GitHub had not finished when CI wait at submission (20 minutes) was reached. The ticket is back in To do with its branch and pull request; this did not count as a failed attempt. If CI has finished since, Check CI again accepts the work without starting a session.`,
    });
  });

  it('a pull request never opened: Try again first, then Check CI again (owner 3e)', () => {
    expect(ciTimeoutItemText(item({ pullRequestOpened: false }, null)).detail).toBe(
      `The agent handed its work in at ${formatDateTime(SUBMITTED)} (commit abc1234), but its pull request could not be opened on GitHub before CI wait at submission (20 minutes) was reached, so CI never ran. The ticket is back in To do with its branch; this did not count as a failed attempt. Use Try again in "Pull request not opened for WEB-12" first, then Check CI again.`,
    );
  });

  it('a pull request opened since by Try again: Check CI again once CI has finished', () => {
    expect(ciTimeoutItemText(item({ pullRequestOpened: false }, 12)).detail).toBe(
      `The agent handed its work in at ${formatDateTime(SUBMITTED)} (commit abc1234), but its pull request could not be opened on GitHub before CI wait at submission (20 minutes) was reached, so CI never ran then. The ticket is back in To do with its branch; this did not count as a failed attempt. Pull request #12 is open now: once CI has finished on GitHub, Check CI again accepts the work without starting a session.`,
    );
  });

  it('CI failed, and the agent did not get the result', () => {
    expect(
      ciTimeoutItemText(
        item({ kind: 'not_received', notSent: { why: 'not_confirmed', message: null } }),
      ),
    ).toEqual({
      title: 'CI failed for WEB-12, and the agent did not get the result: Contact form',
      detail:
        "CI failed on GitHub for commit abc1234 (failed: test · workflow), but the run's wait (CI wait at submission, 20 minutes) ended before the agent received the result: machine Laptop did not confirm it received it. The ticket is back in To do; this did not count as a failed attempt. Run now starts a run whose agent reads the failure first.",
    });
  });

  it('a conflict not resolved', () => {
    expect(
      ciTimeoutItemText(
        item({
          kind: 'conflict',
          conflict: true,
          checks: [],
          notSent: { why: 'refused', message: 'Downloading main from GitHub failed: x' },
        }),
      ),
    ).toEqual({
      title: 'WEB-12 conflicts with main: Contact form',
      detail:
        "The pull request conflicts with main, so GitHub ran no CI, and the run's wait (CI wait at submission, 20 minutes) ended before the agent merged it: machine Laptop could not take the message (Downloading main from GitHub failed: x). The ticket is back in To do; this did not count as a failed attempt. Run now lets the agent merge main and resolve the conflict.",
    });
  });
});

describe('what Check CI again found (the owner’s table)', () => {
  const said = (answer: CheckCiAgainResponse) => checkCiAgainText(answer, 'WEB-12');
  it('in the words of the table', () => {
    expect(said({ outcome: 'accepted', state: 'passed', attemptTakenBack: false })).toBe(
      'CI passed: WEB-12 moved to In review.',
    );
    expect(said({ outcome: 'accepted', state: 'no_ci', attemptTakenBack: true })).toBe(
      'No CI found: WEB-12 moved to In review. Its failed attempt no longer counts.',
    );
    expect(said({ outcome: 'not_finished', finished: 2, total: 3, at: LATER })).toBe(
      `CI has still not finished on GitHub (2 of 3 checks finished, checked at ${formatDateTime(LATER)}). Try again later.`,
    );
    expect(said({ outcome: 'not_finished', finished: 0, total: 0, at: LATER })).toBe(
      `Nothing has appeared on GitHub yet (checked at ${formatDateTime(LATER)}). Try again later.`,
    );
    expect(said({ outcome: 'failed', checks: [failedCheck] })).toBe(
      'CI failed on GitHub: test · workflow. The work was not accepted: Run now gives the failure to the agent.',
    );
    expect(said({ outcome: 'conflict', base: 'main' })).toBe(
      'The pull request conflicts with main, so GitHub runs no CI. Run now lets the agent merge main and resolve the conflict.',
    );
    expect(said({ outcome: 'github_problem', message: 'GitHub could not be reached' })).toBe(
      'GitHub could not be checked: GitHub could not be reached. Try again later.',
    );
  });
});
