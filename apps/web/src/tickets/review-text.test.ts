import type { NeedsYouItem, ReviewDecision, RunReview, TicketReview } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { formatDateTime } from '../github/text';
import {
  awaitingMergeText,
  readyForReviewText,
  reviewNotFinishedText,
  runReviewText,
  ticketReviewText,
} from './review-text';

// Reviews in the owner's words (02, sections 4, 6.4 and 7; owner's answers 2 to 5, lot 3 steps H
// and H4).

const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';
const HEAD = 'def5678abc1234def5678abc1234def5678abc12';
const AT = '2026-10-10T14:52:00.000Z';
const LATER = '2026-10-10T15:10:00.000Z';
const TICKET = { projectKey: 'BAK', number: 12, title: 'Contact form' };
const MACHINE = { id: '6f2b0c1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b', name: 'laptop' };

const APPROVAL: ReviewDecision = {
  kind: 'approved',
  commit: COMMIT,
  summary: 'Fine.',
  points: [],
  headChecked: true,
  at: AT,
};
const CHANGES: ReviewDecision = {
  kind: 'changes_requested',
  commit: COMMIT,
  summary: null,
  points: [
    { body: 'Test an empty address.', file: 'src/contact.ts', line: 42 },
    { body: 'Document it.', file: null, line: null },
    { body: 'Rename it.', file: 'src/form.ts', line: null },
  ],
  headChecked: true,
  at: AT,
};

type Ready = Extract<NeedsYouItem, { type: 'ready_for_review' }>;
function ready(more: Partial<Ready> = {}): Ready {
  return {
    type: 'ready_for_review',
    ticket: TICKET,
    pullRequest: { number: 12, url: 'https://github.com/o/r/pull/12' },
    commit: COMMIT,
    ci: 'passed',
    checkedAgainAt: null,
    workflowFlag: null,
    since: AT,
    ...more,
  };
}

describe('"Ready for review"', () => {
  it('CI passed, with the cost of each choice', () => {
    expect(readyForReviewText(ready())).toEqual({
      title: 'Ready for review: BAK-12 Contact form',
      ci: 'CI passed on GitHub for commit abc1234',
      workflows: null,
      cost: 'A review by Quality uses one Claude Code session; Skip review uses none.',
    });
  });

  it('CI passed when Check CI again read it', () => {
    expect(readyForReviewText(ready({ ci: 'passed_later', checkedAgainAt: LATER })).ci).toBe(
      `CI passed on GitHub for commit abc1234 (checked again by you at ${formatDateTime(LATER)})`,
    );
  });

  it('No CI found, alone and with workflow files changed in one sentence', () => {
    expect(readyForReviewText(ready({ ci: 'no_ci' })).ci).toBe('No CI found for commit abc1234');
    const both = readyForReviewText(ready({ ci: 'no_ci', workflowFlag: 'changed' }));
    expect(both.ci).toBe(
      'No CI found for commit abc1234, and this work changed files under .github/workflows/: it may have removed or weakened CI. Read them before reviewing or merging.',
    );
    expect(both.workflows).toBeNull();
    expect(
      readyForReviewText(ready({ ci: 'no_ci', workflowFlag: 'changed', checkedAgainAt: LATER })).ci,
    ).toContain(
      `No CI found for commit abc1234 (checked again by you at ${formatDateTime(LATER)}), and`,
    );
  });

  it('workflow files changed, or may have changed, on a line of their own with CI passed', () => {
    expect(readyForReviewText(ready({ workflowFlag: 'changed' })).workflows).toMatch(
      /^Workflow files changed: /,
    );
    for (const flag of ['not_listed', 'not_kept'] as const) {
      expect(readyForReviewText(ready({ workflowFlag: flag })).workflows).toMatch(
        /^Workflow files may have changed: /,
      );
    }
  });
});

type NotFinished = Extract<NeedsYouItem, { type: 'review_not_finished' }>;
function notFinished(end: NotFinished['end'], decision: ReviewDecision | null = null) {
  return reviewNotFinishedText({
    type: 'review_not_finished',
    ticket: TICKET,
    runId: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d',
    machine: MACHINE,
    decision,
    end,
    since: AT,
  });
}

describe('"Review did not finish"', () => {
  it('without a decision: the reason, not counted', () => {
    expect(notFinished({ why: 'gave_up', reason: 'The diff is empty.' })).toEqual({
      title: 'Review did not finish for BAK-12: Contact form',
      detail:
        'The review run on laptop ended without a decision: Quality gave up: The diff is empty. It does not count as a failed attempt.',
    });
    const reasons: [NotFinished['end'], string][] = [
      [{ why: 'gave_up', reason: null }, 'Quality gave up'],
      [
        { why: 'moved_before_start', head: HEAD },
        'the pull request changed on GitHub before the review started (now def5678)',
      ],
      [
        { why: 'moved_on_github', head: HEAD },
        'the pull request changed on GitHub during the review (now def5678)',
      ],
      [{ why: 'moved_on_machine' }, 'the branch changed on the machine during the review'],
      [{ why: 'failed', failureReason: 'timeout' }, 'it ran out of time'],
      [
        { why: 'failed', failureReason: 'crash' },
        'its Claude Code session stopped unexpectedly or never started',
      ],
      [{ why: 'failed', failureReason: 'machine_offline' }, 'its machine was offline'],
    ];
    for (const [end, words] of reasons) {
      expect(notFinished(end).detail).toBe(
        `The review run on laptop ended without a decision: ${words}. It does not count as a failed attempt.`,
      );
    }
  });

  it('a decision thrown away: which, when, and why (owner answer 2)', () => {
    const at = formatDateTime(AT);
    expect(notFinished({ why: 'stopped' }, APPROVAL).detail).toBe(
      `Quality approved commit abc1234 at ${at}, but the approval was not applied: you stopped the run before it ended. It does not count as a failed attempt.`,
    );
    expect(notFinished({ why: 'moved_on_machine' }, CHANGES).detail).toBe(
      `Quality requested changes on commit abc1234 (3 points) at ${at}, but the request was not applied: the branch changed on the machine before the run ended. It does not count as a failed attempt.`,
    );
    expect(notFinished({ why: 'failed', failureReason: 'machine_offline' }, APPROVAL).detail).toBe(
      `Quality approved commit abc1234 at ${at}, but the approval was not applied: machine laptop went offline before the run ended. It does not count as a failed attempt.`,
    );
    expect(notFinished({ why: 'failed', failureReason: 'timeout' }, APPROVAL).detail).toContain(
      'not applied: it ran out of time before the run ended.',
    );
  });
});

function review(latest: TicketReview['latest'], earlier = false): TicketReview {
  return { latest, current: { commit: HEAD, earlier }, offered: true };
}

describe('the ticket page', () => {
  it('a decision, its points count, and "head not checked"', () => {
    const at = formatDateTime(AT);
    expect(
      ticketReviewText(
        review({ kind: 'decision', runId: MACHINE.id, decision: APPROVAL, post: null }),
      ),
    ).toEqual({
      heading: `Approved by Quality · commit abc1234 · ${at}`,
      earlier: null,
      headNotChecked: null,
    });
    expect(
      ticketReviewText(
        review({
          kind: 'decision',
          runId: MACHINE.id,
          decision: { ...CHANGES, headChecked: false },
          post: null,
        }),
      ),
    ).toEqual({
      heading: `Changes requested by Quality · commit abc1234 · 3 points · ${at}`,
      earlier: null,
      headNotChecked:
        "The pull request's head could not be checked on GitHub when Quality decided: check it is still abc1234 before merging.",
    });
  });

  it('a review about an earlier submission says so (owner change to answer 4)', () => {
    const at = formatDateTime(AT);
    expect(
      ticketReviewText(
        review({ kind: 'decision', runId: MACHINE.id, decision: CHANGES, post: null }, true),
      ),
    ).toEqual({
      heading: `Changes requested by Quality · commit abc1234 · 3 points · ${at}, on an earlier submission.`,
      earlier: 'The work now in review is commit def5678 and has not been reviewed yet.',
      headNotChecked: null,
    });
    expect(ticketReviewText(review({ kind: 'skipped', at: AT }, true))).toEqual({
      heading: 'Review skipped by you on October 10, 2026, on an earlier submission.',
      earlier: 'The work now in review is commit def5678 and has not been reviewed yet.',
      headNotChecked: null,
    });
  });

  it('skipped, in progress, did not finish; none', () => {
    expect(ticketReviewText(review({ kind: 'skipped', at: AT }))?.heading).toBe(
      'Review skipped by you on October 10, 2026',
    );
    expect(
      ticketReviewText(review({ kind: 'in_progress', runId: MACHINE.id, machine: MACHINE }))
        ?.heading,
    ).toBe('Review in progress on laptop');
    expect(
      ticketReviewText(
        review({
          kind: 'not_finished',
          runId: MACHINE.id,
          machine: MACHINE,
          decision: null,
          end: { why: 'gave_up', reason: 'No diff' },
          endedAt: AT,
        }),
      )?.heading,
    ).toBe('Review did not finish: Quality gave up: No diff.');
    expect(ticketReviewText(review(null))).toBeNull();
  });

  it('Awaiting merge: the merge found at the next check, every GitHub check interval (step J1)', () => {
    expect(awaitingMergeText(12, 90)).toBe(
      'Merge pull request #12 on GitHub. The Orchestrator checks GitHub every 90 seconds (GitHub check interval, in Settings > Limits) and moves the ticket to Done when it finds the merge.',
    );
    expect(awaitingMergeText(12, null)).toBe(
      'Merge pull request #12 on GitHub. The Orchestrator checks GitHub at each GitHub check interval (Settings > Limits) and moves the ticket to Done when it finds the merge.',
    );
  });
});

describe('the run page', () => {
  const card = (more: Partial<RunReview>, endedAt: string | null = AT) =>
    runReviewText(
      {
        commit: COMMIT,
        pullRequest: 12,
        decision: null,
        applied: false,
        notApplied: null,
        post: null,
        ...more,
      },
      { machine: { name: 'laptop' }, endedAt },
    );

  it('the commit, the decision or none (owner answer 5 of H4)', () => {
    expect(card({}, null)).toEqual({
      reviewed: 'Reviewed commit abc1234 (pull request #12)',
      decision: 'Decision: none yet',
      notApplied: null,
      headNotChecked: null,
    });
    expect(card({ notApplied: { why: 'gave_up', reason: null } }).decision).toBe(
      'Decision: none, the run ended without one',
    );
    expect(card({ decision: APPROVAL, applied: true }).decision).toBe('Decision: approved');
    expect(card({ decision: CHANGES, applied: true }).decision).toBe(
      'Decision: changes requested (3 points)',
    );
  });

  it('a decision not applied, and "head not checked"', () => {
    expect(card({ decision: APPROVAL, notApplied: { why: 'stopped' } }).notApplied).toBe(
      'Decision not applied: you stopped the run before it ended.',
    );
    expect(
      card({ decision: { ...APPROVAL, headChecked: false }, applied: true }).headNotChecked,
    ).toBe(
      "The pull request's head could not be checked on GitHub when Quality decided: check it is still abc1234 before merging.",
    );
  });
});
