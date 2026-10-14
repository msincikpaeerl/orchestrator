import type { TicketChangeRequest, TicketReviewLatest, TicketStop } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { formatDateTime } from '../github/text';
import {
  RUN_NOW_AFTER_TRY_AGAIN,
  requestChangesText,
  requestedAfterText,
  stopText,
  todoRequestText,
} from './change-text';

// Changes after a review in the owner's words (02, sections 4 and 6.4; owner's answers 2, 6 and
// 7, lot 3 step I, and 2 to 4, step I2).

const commit = 'abc1234def5678abc1234def5678abc1234def56';
const at = '2026-10-11T15:10:00Z';

const quality = (round: number, standing = true, limit = 2): TicketChangeRequest => ({
  request: { by: 'quality', commit, runId: crypto.randomUUID(), round, at },
  standing,
  limit,
});
const owner = (after: 'approved' | 'skipped' | null, standing = true): TicketChangeRequest => ({
  request: { by: 'owner', commit, commentId: crypto.randomUUID(), after, conflict: null, at },
  standing,
  limit: 2,
});

describe('the To do line after a request (answer 7, step I; answer 4, step I2)', () => {
  it("says the run addresses Quality's points, with the round", () => {
    expect(todoRequestText(quality(1), 1)).toBe(
      "Run now starts a run that addresses Quality's points (round 1 of at most 2).",
    );
  });

  it("leaves the round out for Quality's request made before Try again", () => {
    expect(todoRequestText(quality(3), 0)).toBe(
      "Run now starts a run that addresses Quality's points.",
    );
  });

  it("says the run addresses the owner's request", () => {
    expect(todoRequestText(owner('approved'), 0)).toBe(
      'Run now starts a run that addresses your request.',
    );
  });

  it('says nothing without a request standing', () => {
    expect(todoRequestText(null, 0)).toBeNull();
    expect(todoRequestText(quality(1, false), 1)).toBeNull();
  });
});

describe("the review section after the owner's request on Awaiting merge (answer 6)", () => {
  it('says the owner requested changes after the approval or the skip, while it stands', () => {
    expect(requestedAfterText(owner('approved'))).toBe(
      `You requested changes after this approval, at ${formatDateTime(at)}.`,
    );
    expect(requestedAfterText(owner('skipped'))).toBe(
      `You requested changes after skipping the review, at ${formatDateTime(at)}.`,
    );
  });

  it('says nothing for a request in review, by Quality, or answered', () => {
    expect(requestedAfterText(owner(null))).toBeNull();
    expect(requestedAfterText(quality(1))).toBeNull();
    expect(requestedAfterText(owner('approved', false))).toBeNull();
    expect(requestedAfterText(null)).toBeNull();
  });
});

describe('the Request changes dialog (answer 7)', () => {
  const approved: TicketReviewLatest = {
    kind: 'decision',
    runId: crypto.randomUUID(),
    decision: {
      kind: 'approved',
      commit,
      at,
      summary: null,
      points: [],
      headChecked: true,
    },
    post: null,
  };

  it('on Awaiting merge names what the request comes after', () => {
    expect(requestChangesText('awaiting_merge', approved)).toBe(
      'Quality approved commit abc1234. The ticket goes back to To do with your comment, and its next run addresses it; the pull request stays open.',
    );
    expect(requestChangesText('awaiting_merge', { kind: 'skipped', at })).toBe(
      'You skipped the review. The ticket goes back to To do with your comment, and its next run addresses it; the pull request stays open.',
    );
  });

  it('in review keeps the words of lot 2', () => {
    expect(requestChangesText('in_review', null)).toBe(
      'The ticket goes back to To do with your comment. Its branch and commits are kept, and the next run continues from them with your comment in its instructions. This does not count as a failed attempt.',
    );
  });
});

describe('the stop (answer 2, step I2)', () => {
  const stop: TicketStop = { cause: 'review_rounds', count: 3, limit: 2, at };

  it("uses the Needs you item's words, with what Try again does", () => {
    expect(stopText(stop)).toEqual({
      title: 'Stopped after too many review rounds',
      detail:
        'Quality requested changes 3 times, more than Most review rounds per ticket allows (2). Use Try again to let it continue, or Cancel it, or Mark it as done manually.',
      tryAgain:
        'Try again starts no session: the review rounds and failed attempts count from 0 again, and Run now can start the next run.',
      since: `Since ${formatDateTime(at)}`,
    });
  });

  it('offers Run now after Try again', () => {
    expect(RUN_NOW_AFTER_TRY_AGAIN).toBe(
      'The review rounds and failed attempts count from 0 again. Start the next run now, or later from the ticket page.',
    );
  });
});
