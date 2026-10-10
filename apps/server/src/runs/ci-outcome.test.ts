import type { CiResult, CiRound } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { checkCiAgainOffered, ciHistory, ciOutcome, type CiRunRow } from './ci-outcome.js';

// What a run's CI came to, from what the run keeps (owner's answers, lot 3 step G2c).

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const AT = new Date('2026-10-10T10:20:00.000Z');

const failed: CiResult = {
  state: 'failed',
  checks: [
    { kind: 'workflow_run', name: 'CI', state: 'failed', url: null, run_id: 7, cancelled: false },
  ],
  failed_jobs: [],
  jobs_read: false,
  jobs_problem: null,
};
const conflict: CiResult = { ...failed, state: 'conflict', checks: [] };
const pending: CiResult = { ...failed, state: 'pending', checks: [] };

function round(number: number, kind: 'failed' | 'conflict', commit: string, confirmed = true) {
  return {
    round: number,
    kind,
    commit,
    messageId: '00000000-0000-4000-8000-00000000000' + String(number),
    via: 'input',
    decidedAt: AT.toISOString(),
    sentAt: AT.toISOString(),
    confirmedAt: confirmed ? AT.toISOString() : null,
    result: kind === 'failed' ? failed : conflict,
    readAt: AT.toISOString(),
  } satisfies CiRound;
}

function row(overrides: Partial<CiRunRow>): CiRunRow {
  return {
    status: 'failed',
    failureReason: 'ci_timeout',
    ciCommit: A,
    ciWaitStartedAt: AT,
    ciWaitTimeoutMinutes: 20,
    ciResult: pending,
    ciCheckedAt: AT,
    ciRounds: [],
    ciRoundRefusal: null,
    maxCiFailures: 2,
    ciPullRequestHead: null,
    ciAcceptedLater: null,
    baseBranch: 'main',
    ...overrides,
  };
}

describe('ciOutcome', () => {
  it('CI not finished, and a pull request never opened', () => {
    expect(ciOutcome(row({}))).toMatchObject({ kind: 'not_finished', pullRequestOpened: true });
    expect(ciOutcome(row({ ciWaitStartedAt: null, ciResult: null }))).toMatchObject({
      kind: 'not_finished',
      pullRequestOpened: false,
      at: AT.toISOString(),
    });
  });

  it('a failure the agent did not get: not confirmed, refused, read late', () => {
    expect(
      ciOutcome(row({ ciResult: failed, ciRounds: [round(1, 'failed', A, false)] })),
    ).toMatchObject({
      kind: 'not_received',
      notSent: { why: 'not_confirmed', message: null },
    });
    expect(
      ciOutcome(
        row({
          ciResult: failed,
          ciRoundRefusal: { kind: 'failed', message: 'session gone', at: AT.toISOString() },
        }),
      ),
    ).toMatchObject({ kind: 'not_received', notSent: { why: 'refused', message: 'session gone' } });
    expect(ciOutcome(row({ ciResult: failed }))).toMatchObject({
      kind: 'not_received',
      notSent: { why: 'read_late' },
    });
  });

  it('a conflict not resolved: Check CI again not offered', () => {
    const outcome = ciOutcome(
      row({
        ciResult: conflict,
        ciRoundRefusal: {
          kind: 'conflict',
          message: 'Downloading main from GitHub failed: x',
          at: AT.toISOString(),
        },
      }),
    );
    expect(outcome).toMatchObject({
      kind: 'conflict',
      conflict: true,
      notSent: { why: 'refused' },
    });
    expect(outcome && checkCiAgainOffered(outcome)).toBe(false);
  });

  it('too many: counts the confirmed rounds and the last result, says when one conflicted', () => {
    const outcome = ciOutcome(
      row({
        failureReason: 'ci_failed',
        ciResult: failed,
        ciRounds: [round(1, 'conflict', B), round(2, 'failed', B)],
      }),
    );
    expect(outcome).toMatchObject({ kind: 'too_many', failures: 3, anyConflict: true });
    expect(outcome && checkCiAgainOffered(outcome)).toBe(true);
    const lastConflict = ciOutcome(
      row({ failureReason: 'ci_failed', ciResult: conflict, ciRounds: [round(1, 'failed', B)] }),
    );
    expect(lastConflict).toMatchObject({ kind: 'too_many', failures: 2, conflict: true });
    expect(lastConflict && checkCiAgainOffered(lastConflict)).toBe(false);
  });

  it('after a confirmed round, the run ended without handing in again', () => {
    const outcome = ciOutcome(
      row({
        failureReason: 'timeout',
        ciCommit: null,
        ciResult: null,
        ciRounds: [round(1, 'failed', B)],
      }),
    );
    expect(outcome).toMatchObject({ kind: 'after_round', commit: B, round: 1 });
    expect(outcome && checkCiAgainOffered(outcome)).toBe(false);
    // Still working after the round: nothing to show.
    expect(
      ciOutcome(
        row({
          status: 'running',
          failureReason: null,
          ciCommit: null,
          ciRounds: [round(1, 'failed', B)],
        }),
      ),
    ).toBeNull();
  });

  it('cancelled because the branch moved, with the head read then', () => {
    expect(
      ciOutcome(row({ failureReason: 'ci_cancelled', ciResult: failed, ciPullRequestHead: B })),
    ).toMatchObject({ kind: 'cancelled', pullRequestHead: B });
  });

  it('accepted later by Check CI again', () => {
    const acceptedLater = { at: AT.toISOString(), state: 'passed', attemptTakenBack: true };
    const outcome = ciOutcome(
      row({ failureReason: 'ci_failed', ciResult: failed, ciAcceptedLater: acceptedLater }),
    );
    expect(outcome).toMatchObject({ kind: 'too_many', acceptedLater });
    expect(outcome && checkCiAgainOffered(outcome)).toBe(false);
  });

  it('none for a run that never waited for CI', () => {
    expect(ciOutcome(row({ ciCommit: null, ciResult: null }))).toBeNull();
    expect(ciHistory(row({ ciCommit: null, ciResult: null }))).toBeNull();
  });
});
