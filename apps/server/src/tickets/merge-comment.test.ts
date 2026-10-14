import type { RunCiOutcome } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import {
  mergeComment,
  mergedAfterCancelComment,
  mergedAfterDoneComment,
  type MergeFacts,
} from './merge-comment.js';

// The comment of a pull request found merged (owner's answer 2, lot 3 step J1): every sentence.

const HEAD = 'def5678'.padEnd(40, '0');
const CHECKED = 'abc1234'.padEnd(40, '0');

function ci(change: Partial<RunCiOutcome> = {}): RunCiOutcome {
  return {
    kind: 'passed',
    commit: HEAD,
    at: '2026-10-11T15:50:00.000Z',
    checks: [],
    conflict: false,
    notSent: null,
    failures: 0,
    anyConflict: false,
    round: null,
    pullRequestHead: null,
    pullRequestOpened: true,
    acceptedLater: null,
    ...change,
  };
}

const facts = (change: Partial<MergeFacts> = {}): MergeFacts => ({
  number: 12,
  reference: 'BAK-12',
  mergedAt: new Date('2026-10-11T16:02:30.000Z'),
  head: HEAD,
  stoppedOn: null,
  ci: ci(),
  review: { kind: 'approved', commit: HEAD },
  ...change,
});

const OPENING = 'Pull request #12 was merged on GitHub at 2026-10-11 16:02 UTC (head def5678).';

describe('the comment of a merge', () => {
  it('names the merged head, CI and the approval of that commit', () => {
    expect(mergeComment(facts())).toBe(
      `${OPENING} CI passed for this commit. Quality approved this commit.`,
    );
  });

  it('names the stopped run', () => {
    expect(mergeComment(facts({ stoppedOn: 'laptop', review: { kind: 'none' } }))).toBe(
      `${OPENING} The run on laptop was stopped. CI passed for this commit. It was merged before Quality's review.`,
    );
  });

  it('says when CI checked another commit than the merged head', () => {
    expect(mergeComment(facts({ ci: ci({ commit: CHECKED }) }))).toContain(
      "The merged head is not the commit CI checked (abc1234): the Orchestrator's CI result does not cover it.",
    );
    expect(
      mergeComment(
        facts({
          ci: ci({
            kind: 'too_many',
            commit: CHECKED,
            acceptedLater: {
              at: '2026-10-11T15:55:00.000Z',
              state: 'passed',
              attemptTakenBack: true,
            },
          }),
        }),
      ),
    ).toContain('The merged head is not the commit CI checked (abc1234)');
  });

  it('counts a result accepted later, and "No CI found"', () => {
    expect(
      mergeComment(
        facts({
          ci: ci({
            kind: 'not_finished',
            acceptedLater: {
              at: '2026-10-11T15:55:00.000Z',
              state: 'passed',
              attemptTakenBack: false,
            },
          }),
        }),
      ),
    ).toContain('CI passed for this commit.');
    expect(mergeComment(facts({ ci: ci({ kind: 'no_ci' }) }))).toContain(
      'No CI was found for this commit: nothing was tested on GitHub.',
    );
  });

  it('says CI had not passed, and why', () => {
    const line = (change: Partial<RunCiOutcome>) =>
      mergeComment(facts({ ci: ci({ commit: CHECKED, ...change }) }));
    expect(line({ kind: 'waiting' })).toContain(
      'CI had not passed for this work: CI was still being checked for abc1234.',
    );
    expect(line({ kind: 'not_finished' })).toContain(
      'CI had not passed for this work: CI had not finished for abc1234 when CI wait at submission was reached.',
    );
    expect(line({ kind: 'conflict' })).toContain(
      'CI had not passed for this work: abc1234 conflicted with the base branch.',
    );
    expect(line({ kind: 'cancelled' })).toContain(
      'CI had not passed for this work: the CI runs of abc1234 were cancelled on GitHub.',
    );
    for (const kind of ['too_many', 'not_received', 'after_round', 'ended'] as const) {
      expect(line({ kind })).toContain('CI had not passed for this work: CI failed for abc1234.');
    }
    expect(mergeComment(facts({ ci: null }))).toContain(
      'CI had not passed for this work: no CI result was read for it.',
    );
  });

  it("names Quality's review, or its absence", () => {
    const line = (review: MergeFacts['review']) => mergeComment(facts({ review }));
    expect(line({ kind: 'approved', commit: CHECKED })).toMatch(
      /Quality approved abc1234, not the merged head\.$/,
    );
    expect(line({ kind: 'skipped', commit: CHECKED })).toMatch(
      /You skipped the review of abc1234\.$/,
    );
    expect(line({ kind: 'skipped', commit: null })).toMatch(/You skipped the review\.$/);
    expect(line({ kind: 'none' })).toMatch(/It was merged before Quality's review\.$/);
  });

  it("names Quality's decision the merge stopped before it was applied", () => {
    const decision = {
      commit: CHECKED,
      summary: 'Two points.',
      points: [{ body: 'Test it.', file: null, line: null }],
      headChecked: true,
      at: '2026-10-11T16:01:00.000Z',
    };
    expect(
      mergeComment(
        facts({
          review: { kind: 'not_applied', decision: { ...decision, kind: 'changes_requested' } },
        }),
      ),
    ).toMatch(
      /Quality had asked for changes on abc1234 just before the merge; that decision was not applied\.$/,
    );
    expect(
      mergeComment(
        facts({
          review: { kind: 'not_applied', decision: { ...decision, kind: 'approved', points: [] } },
        }),
      ),
    ).toMatch(
      /Quality had approved abc1234 just before the merge; that decision was not applied\.$/,
    );
  });

  it('says a request for changes was not addressed', () => {
    expect(
      mergeComment(
        facts({
          review: {
            kind: 'request_standing',
            request: {
              by: 'quality',
              commit: CHECKED,
              runId: '00000000-0000-4000-8000-000000000001',
              round: 1,
              at: '2026-10-11T16:00:00.000Z',
            },
          },
        }),
      ),
    ).toMatch(/Quality's request for changes on abc1234 was not addressed\.$/);
    expect(
      mergeComment(
        facts({
          review: {
            kind: 'request_standing',
            request: {
              by: 'owner',
              commit: null,
              commentId: '00000000-0000-4000-8000-000000000002',
              after: null,
              conflict: null,
              at: '2026-10-11T16:00:00.000Z',
            },
          },
        }),
      ),
    ).toMatch(/Your request for changes was not addressed\.$/);
  });
});

describe('a merge found on a done or cancelled ticket', () => {
  it('after Mark as done manually', () => {
    expect(mergedAfterDoneComment(facts())).toBe(
      'Pull request #12 was merged on GitHub at 2026-10-11 16:02 UTC (head def5678), after you marked BAK-12 as done.',
    );
  });

  it('after a cancellation: the ticket stays cancelled', () => {
    expect(mergedAfterCancelComment(facts())).toBe(
      'Pull request #12 was merged on GitHub at 2026-10-11 16:02 UTC (head def5678), after BAK-12 was cancelled. The ticket stays cancelled: to record it as done, use Reopen, then Mark as done manually.',
    );
  });
});
