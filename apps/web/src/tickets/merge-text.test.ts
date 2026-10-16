import type {
  NeedsYouItem,
  PullRequestFailure,
  PullRequestReopenFailure,
} from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { formatDateTime } from '../github/text';
import {
  closeWantedText,
  closedItemText,
  closedStateText,
  conflictFlagText,
  headMovedText,
  mergedElsewhereText,
  reopenFailureText,
  toMergeText,
  watchFailureText,
} from './merge-text';

// Pull requests to merge and closed pull requests in the owner's words (02, section 4; owner's
// answers 3 and 4 of step J, lot 3 step J4a).

const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';
const HEAD = 'def5678abc1234def5678abc1234def5678abc12';
const AT = '2026-10-14T16:02:00.000Z';
const LATER = '2026-10-14T16:10:00.000Z';
const TICKET = { projectKey: 'BAK', number: 12, title: 'Contact form' };
const PULL = { number: 12, url: 'https://github.com/o/r/pull/12' };

type ToMerge = Extract<NeedsYouItem, { type: 'pull_request_to_merge' }>;
function toMerge(more: Partial<ToMerge> = {}): ToMerge {
  return {
    type: 'pull_request_to_merge',
    ticket: TICKET,
    pullRequest: PULL,
    review: { kind: 'approved', commit: COMMIT, summary: 'Fine.', at: AT },
    ci: { result: 'passed', commit: COMMIT, checkedAgainAt: null },
    workflowFlag: null,
    conflict: null,
    headMoved: null,
    watchFailure: null,
    since: AT,
    ...more,
  };
}

type Closed = Extract<NeedsYouItem, { type: 'pull_request_closed' }>;
function closed(more: Partial<Closed> = {}): Closed {
  return {
    type: 'pull_request_closed',
    ticket: TICKET,
    status: 'awaiting_merge',
    pullRequest: PULL,
    mergedInto: null,
    reopenFailure: null,
    since: AT,
    ...more,
  };
}

function refusal(more: Partial<PullRequestReopenFailure> = {}): PullRequestReopenFailure {
  return {
    reason: 'refused',
    message: 'Validation Failed: state cannot be changed.',
    permission: null,
    fields: [],
    at: AT,
    branchGone: false,
    ...more,
  };
}

describe('a pull request to merge', () => {
  it('approved, CI passed: what to do on GitHub', () => {
    expect(toMergeText(toMerge())).toEqual({
      title: 'Pull request to merge: BAK-12 Contact form',
      review: `Quality approved commit abc1234 at ${formatDateTime(AT)}.`,
      ci: 'CI passed on GitHub for commit abc1234',
      workflows: null,
      merge:
        'Merge it on GitHub: BAK-12 moves to Done by itself when the Orchestrator finds the merge, at its next GitHub check.',
    });
  });

  it('review skipped, CI checked again', () => {
    const text = toMergeText(
      toMerge({
        review: { kind: 'skipped', at: AT },
        ci: { result: 'passed_later', commit: COMMIT, checkedAgainAt: LATER },
      }),
    );
    expect(text.review).toBe(
      `Review skipped: you skipped Quality's review at ${formatDateTime(AT)}. Check the pull request yourself before merging it.`,
    );
    expect(text.ci).toBe(
      `CI passed on GitHub for commit abc1234 (checked again by you at ${formatDateTime(LATER)})`,
    );
  });

  it('"No CI found" and workflow files changed in one sentence (owner\'s answer 3, step G1)', () => {
    const text = toMergeText(
      toMerge({
        ci: { result: 'no_ci', commit: COMMIT, checkedAgainAt: null },
        workflowFlag: 'changed',
      }),
    );
    expect(text.ci).toBe(
      'No CI found for commit abc1234, and this work changed files under .github/workflows/: it may have removed or weakened CI. Read them before reviewing or merging.',
    );
    expect(text.workflows).toBeNull();
  });

  it('the workflow line on its own when CI passed, and no review or CI recorded', () => {
    const text = toMergeText(toMerge({ workflowFlag: 'not_listed', review: null, ci: null }));
    expect(text.workflows).toMatch(/^Workflow files may have changed/);
    expect(text.review).toBe(
      'No review by Quality is recorded for this work: check the pull request yourself before merging it.',
    );
    expect(text.ci).toBe('No CI result is recorded for this work.');
  });

  it('the conflict flag', () => {
    expect(conflictFlagText('main')).toBe('Conflicts with main: GitHub cannot merge it as it is.');
  });

  it("the watch's failure", () => {
    expect(
      watchFailureText({
        reason: 'permission_missing',
        message: 'Pull requests (Read)',
        fields: [],
        pullRequests: [12],
        since: AT,
        at: LATER,
        retryAt: null,
      }),
    ).toBe(
      `GitHub could not be checked for this pull request at ${formatDateTime(LATER)} (since ${formatDateTime(AT)}): the token is missing a permission: Pull requests (Read). A merge is not found while this lasts; the Orchestrator asks again at each GitHub check.`,
    );
  });
});

describe("the moved head (owner's answer 3 of step J)", () => {
  const moved = { after: 'approved' as const, commit: COMMIT, head: HEAD };

  it('after the approval, the commits added and how many more', () => {
    expect(
      headMovedText(
        { ...moved, comparison: { kind: 'ahead', titles: ['Merge main', 'Fix'], more: 3 } },
        12,
      ),
    ).toEqual({
      sentence:
        "Pull request #12's head on GitHub is now def5678, not abc1234, which Quality approved: it changed on GitHub since Quality's review.",
      added: ['Merge main', 'Fix'],
      more: 'and 3 more',
      notPart: null,
    });
  });

  it('after the skip, the commit no longer part of it', () => {
    const text = headMovedText(
      { ...moved, after: 'skipped', comparison: { kind: 'not_part', status: 'diverged' } },
      12,
    );
    expect(text.sentence).toBe(
      "Pull request #12's head on GitHub is now def5678, not abc1234, the commit you skipped the review of.",
    );
    expect(text.notPart).toBe(
      'abc1234, the commit you skipped the review of, is no longer part of pull request #12: its history was rewritten on GitHub.',
    );
  });

  it('a failed or missing comparison shows the sentence alone', () => {
    for (const comparison of [
      null,
      { kind: 'failed' as const, reason: 'unreachable' as const, message: 'down' },
    ]) {
      expect(headMovedText({ ...moved, comparison }, 12)).toMatchObject({
        added: [],
        more: null,
        notPart: null,
      });
    }
  });
});

describe("the closed item (owner's answers 1 and 4 of step J)", () => {
  it('closed without merging', () => {
    expect(closedItemText(closed())).toEqual({
      title: 'Pull request closed without merging for BAK-12: Contact form',
      detail: `Pull request #12 was closed on GitHub at ${formatDateTime(AT)} without merging. The ticket is unchanged (Awaiting merge).`,
      reopenFailure: null,
    });
  });

  it("a refused reopen, with GitHub's words, and its branch gone", () => {
    expect(closedItemText(closed({ reopenFailure: refusal() })).reopenFailure).toBe(
      'GitHub refused to reopen it: Validation Failed: state cannot be changed.',
    );
    expect(reopenFailureText('BAK-12', refusal({ branchGone: true }))).toBe(
      'GitHub refused to reopen it: Validation Failed: state cannot be changed. Its branch is gone from GitHub. The next accepted submission opens a new pull request.',
    );
    expect(
      reopenFailureText(
        'BAK-12',
        refusal({ reason: 'unreachable', message: 'GitHub could not be reached' }),
      ),
    ).toBe('Not reopened: GitHub could not be reached. Try again later.');
  });

  it('merged into another base', () => {
    const text = closedItemText(closed({ mergedInto: 'release', status: 'in_review' }));
    expect(text.title).toBe('Pull request merged into release for BAK-12: Contact form');
    expect(text.detail).toBe(
      `Pull request #12 was merged into release on GitHub at ${formatDateTime(AT)}, not into the project's default branch, so the work is not done. The ticket is unchanged (In review). GitHub never reopens a merged pull request: the next accepted submission opens a new pull request into the default branch. If the work is done this way, mark the ticket as done; if not, cancel it.`,
    );
    expect(text.reopenFailure).toBeNull();
  });
});

describe('merged into another base on the ticket page (lot 3 step J4c)', () => {
  it("the closed item's words while the ticket goes on, the first sentence once it is done", () => {
    expect(mergedElsewhereText({ into: 'release', at: AT }, 12, 'awaiting_merge')).toBe(
      `Pull request #12 was merged into release on GitHub at ${formatDateTime(AT)}, not into the project's default branch, so the work is not done. The ticket is unchanged (Awaiting merge). GitHub never reopens a merged pull request: the next accepted submission opens a new pull request into the default branch. If the work is done this way, mark the ticket as done; if not, cancel it.`,
    );
    expect(mergedElsewhereText({ into: 'release', at: AT }, 12, 'done')).toBe(
      `Pull request #12 was merged into release on GitHub at ${formatDateTime(AT)}, not into the project's default branch.`,
    );
    expect(mergedElsewhereText({ into: 'release', at: null }, 12, 'cancelled')).toBe(
      "Pull request #12 was merged into release on GitHub, not into the project's default branch.",
    );
  });
});

describe('the closed state on the ticket page (lot 3 step J4b)', () => {
  it("closed on GitHub: the closed item's words while the ticket goes on", () => {
    expect(closedStateText({ at: AT, by: 'github' }, 12, 'BAK-12', 'in_review')).toBe(
      `Pull request #12 was closed on GitHub at ${formatDateTime(AT)} without merging. The ticket is unchanged (In review). Reopen it to go on with this pull request, or cancel the ticket.`,
    );
    expect(closedStateText({ at: null, by: 'github' }, 12, 'BAK-12', 'done')).toBe(
      'Pull request #12 was closed on GitHub without merging.',
    );
  });

  it('closed at Cancel, then the ticket reopened', () => {
    expect(closedStateText({ at: AT, by: 'orchestrator' }, 12, 'BAK-12', 'cancelled')).toBe(
      `Pull request #12 was closed on GitHub at ${formatDateTime(AT)} without merging, since BAK-12 was cancelled.`,
    );
    expect(closedStateText({ at: AT, by: 'orchestrator' }, 12, 'BAK-12', 'todo')).toBe(
      `Pull request #12 was closed on GitHub at ${formatDateTime(AT)} without merging, since BAK-12 was cancelled. BAK-12 was reopened since: the pull request stays closed until the next accepted submission, which reopens it.`,
    );
  });

  it("Cancel's close under way, failed with GitHub's words, or another reason", () => {
    expect(closeWantedText({ since: AT, failure: null }, 12, 'BAK-12')).toEqual({
      sentence: `Closing pull request #12 on GitHub, since BAK-12 was cancelled at ${formatDateTime(AT)}.`,
      where: null,
    });
    const refused: PullRequestFailure = {
      reason: 'refused',
      message: 'Validation Failed: state cannot be changed.',
      permission: null,
      fields: [],
      at: LATER,
    };
    expect(closeWantedText({ since: AT, failure: refused }, 12, 'BAK-12').sentence).toBe(
      `Pull request #12 not closed on GitHub yet, though BAK-12 was cancelled at ${formatDateTime(AT)}: at ${formatDateTime(LATER)}, GitHub refused it: Validation Failed: state cannot be changed. The Orchestrator tries again at each GitHub check.`,
    );
    const permission = {
      ...refused,
      reason: 'permission_missing' as const,
      permission: 'pull_requests' as const,
    };
    expect(closeWantedText({ since: AT, failure: permission }, 12, 'BAK-12')).toEqual({
      sentence: `Pull request #12 not closed on GitHub yet, though BAK-12 was cancelled at ${formatDateTime(AT)}: at ${formatDateTime(LATER)}, the token needs Pull requests (Read and write). The Orchestrator tries again at each GitHub check.`,
      where: 'tokens',
    });
  });
});
