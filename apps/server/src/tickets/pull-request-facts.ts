import {
  HeadComparison,
  MOVED_HEAD_TITLE_MAX_CHARS,
  MOVED_HEAD_TITLES_MAX,
  PullRequestConflict,
  PullRequestWatchFailure,
  maskSecrets,
  type HeadComparisonResult,
  type PullRequestHeadMoved,
  type TicketPullRequest,
} from '@orchestrator/protocol';
import type { Executor } from '../database.js';
import { maskStrings } from '../event-log.js';
import type { GitHubRefusal, GitHubResult } from '../github/answers.js';
import type { CommitComparison } from '../github/compare.js';
import type { PullRequest, PullRequestSummary } from '../github/pull-requests.js';
import { failureOf } from '../runs/ci-wait.js';
import { ticketReview } from '../runs/review-view.js';
import { acceptedCommit, requestAfter } from './changes.js';
import type { ProjectRow } from '../projects/model.js';
import type { TicketRow } from './model.js';

// What a read of the ticket's pull request says beyond its state and head (lot 3 step J3b):
// GitHub's conflict fact, and the comparison of the approved commit with a head that moved after
// the approval (owner's answers 3, 4 and 6 of step J).

/** The stored conflict fact, or null. */
export function storedConflict(ticket: Pick<TicketRow, 'pullRequestConflict'>) {
  return ticket.pullRequestConflict === null
    ? null
    : PullRequestConflict.parse(ticket.pullRequestConflict);
}

/** The stored comparison, or null. */
export function storedComparison(ticket: Pick<TicketRow, 'pullRequestComparison'>) {
  return ticket.pullRequestComparison === null
    ? null
    : HeadComparison.parse(ticket.pullRequestComparison);
}

/**
 * The conflict fact after a read: `mergeable` false sets it for the head read (its `since` kept
 * while the head is the same), true clears it; null (GitHub still computing) and a list's read
 * (no `mergeable`) keep it, unless the head moved, which makes it about another commit.
 */
export function conflictAfter(
  ticket: Pick<TicketRow, 'pullRequestConflict'>,
  pull: PullRequestSummary | PullRequest,
  now: Date,
): PullRequestConflict | null {
  const current = storedConflict(ticket);
  const kept = current !== null && current.head === pull.headSha ? current : null;
  if (!('mergeable' in pull) || pull.mergeable === null) return kept;
  if (pull.mergeable) return null;
  return {
    head: pull.headSha,
    base: pull.baseBranch,
    since: kept?.since ?? now.toISOString(),
  };
}

/** The conflict fact for the stored head only: one of an older head says nothing now. */
export function currentConflict(
  ticket: Pick<TicketRow, 'pullRequestConflict' | 'pullRequestHead'>,
): PullRequestConflict | null {
  const conflict = storedConflict(ticket);
  return conflict !== null && conflict.head === ticket.pullRequestHead ? conflict : null;
}

/** The text **Request changes** is filled in with on a conflict (owner's answer 4 of step J). */
export function conflictRequestText(number: number, base: string): string {
  return `Pull request #${String(number)} conflicts with ${base}. Merge ${base} into the branch with \`git merge origin/${base}\`, resolve the conflicts keeping the approved work, then hand it in again.`;
}

/** GitHub's conflict fact for the open pull request's current head, with **Request changes**' text. */
export function ticketConflict(ticket: TicketRow): TicketPullRequest['conflict'] {
  const conflict = currentConflict(ticket);
  if (
    conflict === null ||
    ticket.pullRequestState !== 'open' ||
    ticket.pullRequestNumber === null
  ) {
    return null;
  }
  return { ...conflict, request: conflictRequestText(ticket.pullRequestNumber, conflict.base) };
}

/**
 * The project's watch failure when its latest check left this ticket's pull request unread (lot 3
 * step J3a); null otherwise.
 */
export function ticketWatchFailure(
  project: Pick<ProjectRow, 'pullRequestWatchFailure'>,
  ticket: Pick<TicketRow, 'pullRequestNumber'>,
): PullRequestWatchFailure | null {
  if (project.pullRequestWatchFailure === null || ticket.pullRequestNumber === null) return null;
  const watch = PullRequestWatchFailure.parse(project.pullRequestWatchFailure);
  return watch.pullRequests.includes(ticket.pullRequestNumber) ? maskStrings(watch) : null;
}

/**
 * A commit's title as plain text: one line, no control character, masked, cut to
 * `MOVED_HEAD_TITLE_MAX_CHARS` characters as seen.
 */
export function plainTitle(title: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are what is removed
  const plain = maskSecrets(title.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim());
  // Cut between characters as they are seen (an accent or an emoji is never split).
  const chars = Array.from(new Intl.Segmenter().segment(plain), (each) => each.segment);
  return chars.length <= MOVED_HEAD_TITLE_MAX_CHARS
    ? plain
    : `${chars.slice(0, MOVED_HEAD_TITLE_MAX_CHARS - 1).join('')}…`;
}

/**
 * GitHub's comparison as kept: `ahead` lists the newest titles (newest first) and how many more;
 * any other status says the approved commit is no longer part of the pull request; a refusal is
 * a failed comparison.
 */
export function comparisonResult(read: GitHubResult<CommitComparison>): HeadComparisonResult {
  if (!read.ok) return failedComparison(read.refusal);
  const { status, commits, totalCommits } = read.value;
  if (status !== 'ahead') return { kind: 'not_part', status };
  const titles = commits
    .slice(-MOVED_HEAD_TITLES_MAX)
    .reverse()
    .map((commit) => plainTitle(commit.title));
  return { kind: 'ahead', titles, more: Math.max(0, totalCommits - titles.length) };
}

export function failedComparison(refusal: GitHubRefusal | 'unreachable'): HeadComparisonResult {
  if (refusal === 'unreachable') {
    return {
      kind: 'failed',
      reason: 'unreachable',
      message: 'GitHub could not be reached, or answered with a server error',
    };
  }
  const { reason, message } = failureOf(refusal);
  return { kind: 'failed', reason, message };
}

/**
 * On **Awaiting merge** with its pull request open: the head GitHub has now, when it is not the
 * commit Quality approved or whose review the owner skipped (the one CI checked), with the stored
 * comparison of those two commits (null until it is made). Null otherwise.
 */
export async function headMoved(
  executor: Executor,
  ticket: TicketRow,
): Promise<PullRequestHeadMoved | null> {
  const head = ticket.pullRequestHead;
  if (ticket.status !== 'awaiting_merge' || ticket.pullRequestState !== 'open' || head === null) {
    return null;
  }
  const { latest } = (await ticketReview(executor, ticket)).review;
  const after = requestAfter(latest);
  if (after === null) return null;
  const commit =
    after === 'approved' && latest?.kind === 'decision'
      ? latest.decision.commit
      : await acceptedCommit(executor, ticket);
  if (commit === null || commit === head) return null;
  const stored = storedComparison(ticket);
  return {
    after,
    commit,
    head,
    comparison: stored?.approved === commit && stored.head === head ? stored.result : null,
  };
}
