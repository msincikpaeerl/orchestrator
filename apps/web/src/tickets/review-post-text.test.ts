import type { ReviewPost } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { formatDateTime } from '../github/text';
import { reviewPostText } from './review-post-text';

// The note of Quality's comment review on GitHub (06, section 4.5; owner's answers 1 to 3, lot 3
// step H3): never a flat "Not posted" for a review GitHub may hold, and always "The decision
// stands in the Orchestrator." when it is not known to be there.

const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';
const HEAD = 'def5678abc1234def5678abc1234def5678abc12';
const AT = '2026-10-10T14:52:00.000Z';
const CHECKED = '2026-10-10T15:10:00.000Z';
const STANDS = 'The decision stands in the Orchestrator.';

const failure = { message: 'Validation Failed', permission: null, fields: [] };

function notPosted(
  reason: Extract<ReviewPost, { state: 'not_posted' }>['reason'],
  more: Partial<Extract<ReviewPost, { state: 'not_posted' }>> = {},
): ReviewPost {
  return { state: 'not_posted', pullRequest: 12, reason, ...failure, head: null, at: AT, ...more };
}

describe('reviewPostText', () => {
  it('posted: a link, nothing to read', () => {
    expect(
      reviewPostText(
        { state: 'posted', pullRequest: 12, reviewId: 7, url: 'https://x/pull/12', at: AT },
        COMMIT,
      ),
    ).toEqual({ posted: true, text: 'Posted on GitHub', url: 'https://x/pull/12', where: null });
  });

  it.each([
    [notPosted('unreachable'), 'GitHub could not be reached', null],
    [notPosted('no_token'), 'the GitHub token cannot be used', 'settings'],
    [notPosted('token_unreadable'), 'the GitHub token cannot be used', 'settings'],
    [notPosted('token_invalid'), 'the GitHub token cannot be used', 'settings'],
    [notPosted('rate_limited'), "GitHub's request limit was reached", null],
    [notPosted('unreadable'), "GitHub's answer could not be read", null],
    [
      notPosted('permission_missing', { permission: 'pull_requests' }),
      'the token needs Pull requests (Read and write)',
      'tokens',
    ],
    [notPosted('permission_missing'), 'GitHub refused it ("Validation Failed")', null],
    [notPosted('refused'), 'GitHub refused it ("Validation Failed")', null],
    [
      notPosted('head_moved', { head: HEAD }),
      'pull request #12\'s head is now def5678, and GitHub refused a review of commit abc1234 ("Validation Failed")',
      null,
    ],
    [
      notPosted('pull_request_closed'),
      'pull request #12 was closed and GitHub refused the review ("Validation Failed")',
      null,
    ],
    [
      notPosted('pull_request_merged'),
      'pull request #12 was merged and GitHub refused the review ("Validation Failed")',
      null,
    ],
  ] as const)('not posted: %#', (post, reason, where) => {
    expect(reviewPostText(post, COMMIT)).toEqual({
      posted: false,
      text: `Not posted on GitHub: ${reason}. ${STANDS}`,
      url: null,
      where,
    });
  });

  it('no answer and not found: never "Not posted", the time of the check', () => {
    const text = reviewPostText(
      { state: 'not_found', pullRequest: 12, checkedAt: CHECKED, at: AT },
      COMMIT,
    ).text;
    expect(text).toBe(
      `GitHub did not answer the post, and the review was not on pull request #12 when checked at ${formatDateTime(CHECKED)}. ${STANDS}`,
    );
    expect(text).not.toMatch(/Not posted/);
  });

  it('no answer and the check failed: how to tell it was posted', () => {
    const post: ReviewPost = {
      state: 'not_checked',
      pullRequest: 12,
      afterRestart: false,
      reason: 'unreachable',
      ...failure,
      at: AT,
    };
    expect(reviewPostText(post, COMMIT).text).toBe(
      `GitHub did not answer the post, and pull request #12 could not be checked (GitHub could not be reached). ${STANDS} If "Quality review" appears on the pull request, it was posted.`,
    );
    expect(reviewPostText({ ...post, afterRestart: true, reason: 'refused' }, COMMIT).text).toBe(
      `The Orchestrator stopped while posting the review, and pull request #12 could not be checked afterwards (GitHub refused it: "Validation Failed"). ${STANDS} If "Quality review" appears on the pull request, it was posted.`,
    );
  });
});
