import {
  PULL_REQUEST_PERMISSION_WORDS,
  type PullRequestFailureReason,
  type ReviewPost,
} from '@orchestrator/protocol';
import { formatDateTime } from '../github/text';

// Quality's comment review on GitHub in the owner's words (06, section 4.5; owner's answers 1 to
// 3, lot 3 step H3), for the ticket page's review section and the run page's review card (shown
// from step H4). "Not posted" only when GitHub refused the post or it never left: a post GitHub
// did not answer may still be there, so its note says only what is known.

const STANDS = 'The decision stands in the Orchestrator.';
const POSTED_IF_SEEN = 'If "Quality review" appears on the pull request, it was posted.';

export interface ReviewPostText {
  posted: boolean;
  text: string;
  /** The review on GitHub, when posted. */
  url: string | null;
  /** Where the owner fixes the cause: GitHub's token list, or Settings > GitHub. */
  where: 'tokens' | 'settings' | null;
}

function short(commit: string): string {
  return commit.slice(0, 7);
}

/** A GitHub problem as the end of a sentence, with where the owner fixes it. */
function problem(
  failure: {
    reason: PullRequestFailureReason;
    message: string;
    permission: 'pull_requests' | null;
  },
  quoted: (message: string) => string,
): { words: string; where: ReviewPostText['where'] } {
  switch (failure.reason) {
    case 'permission_missing':
      if (failure.permission !== null) {
        return { words: `the token needs ${PULL_REQUEST_PERMISSION_WORDS}`, where: 'tokens' };
      }
      break;
    case 'unreachable':
      return { words: 'GitHub could not be reached', where: null };
    case 'no_token':
    case 'token_unreadable':
    case 'token_invalid':
      return { words: 'the GitHub token cannot be used', where: 'settings' };
    case 'rate_limited':
      return { words: "GitHub's request limit was reached", where: null };
    case 'unreadable':
      return { words: "GitHub's answer could not be read", where: null };
    case 'refused':
      break;
  }
  return { words: `GitHub refused it${quoted(failure.message)}`, where: null };
}

/** The note of the review's post, with the reviewed commit (the decision's). */
export function reviewPostText(post: ReviewPost, commit: string): ReviewPostText {
  const pull = `pull request #${String(post.pullRequest)}`;
  switch (post.state) {
    case 'posted':
      return { posted: true, text: 'Posted on GitHub', url: post.url, where: null };
    case 'not_posted': {
      const words = `("${post.message}")`;
      const reason =
        post.reason === 'head_moved'
          ? {
              words: `${pull}'s head is now ${short(post.head ?? '')}, and GitHub refused a review of commit ${short(commit)} ${words}`,
              where: null,
            }
          : post.reason === 'pull_request_closed' || post.reason === 'pull_request_merged'
            ? {
                words: `${pull} was ${post.reason === 'pull_request_closed' ? 'closed' : 'merged'} and GitHub refused the review ${words}`,
                where: null,
              }
            : problem({ ...post, reason: post.reason }, (message) => ` ("${message}")`);
      return {
        posted: false,
        text: `Not posted on GitHub: ${reason.words}. ${STANDS}`,
        url: null,
        where: reason.where,
      };
    }
    case 'not_found':
      return {
        posted: false,
        text: `GitHub did not answer the post, and the review was not on ${pull} when checked at ${formatDateTime(post.checkedAt)}. ${STANDS}`,
        url: null,
        where: null,
      };
    case 'not_checked': {
      const why = problem(post, (message) => `: "${message}"`);
      const start = post.afterRestart
        ? `The Orchestrator stopped while posting the review, and ${pull} could not be checked afterwards`
        : `GitHub did not answer the post, and ${pull} could not be checked`;
      return {
        posted: false,
        text: `${start} (${why.words}). ${STANDS} ${POSTED_IF_SEEN}`,
        url: null,
        where: why.where,
      };
    }
  }
}
