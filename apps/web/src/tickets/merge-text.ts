import type {
  NeedsYouItem,
  PullRequestHeadMoved,
  PullRequestReopenFailure,
  PullRequestWatchFailure,
  TicketPullRequest,
  TicketStatus,
} from '@orchestrator/protocol';
import { formatDateTime } from '../github/text';
import { ciProblemReason } from '../runs/ci-text';
import { ciLine, workflowLine } from './review-text';
import { pullRequestFailureText, statusLabel, ticketRef } from './text';

// Pull requests to merge and closed pull requests in the owner's words (02, section 4; owner's
// answers 3 and 4 of step J, lot 3 step J4a), made from the facts the API gives.

type ToMergeItem = Extract<NeedsYouItem, { type: 'pull_request_to_merge' }>;
type ClosedItem = Extract<NeedsYouItem, { type: 'pull_request_closed' }>;

function short(commit: string): string {
  return commit.slice(0, 7);
}

/** "Conflicts with main: GitHub cannot merge it as it is." (owner's answer 4 of step J). */
export function conflictFlagText(base: string): string {
  return `Conflicts with ${base}: GitHub cannot merge it as it is.`;
}

/**
 * The moved head (owner's answer 3 of step J): the sentence, then for `ahead` the commits added
 * (newest first, at most five, then "and N more"), or the approved commit no longer part of the
 * pull request. A comparison not made yet, or failed, shows the sentence alone.
 */
export function headMovedText(
  moved: PullRequestHeadMoved,
  pullRequest: number,
): { sentence: string; added: string[]; more: string | null; notPart: string | null } {
  const commit = short(moved.commit);
  const which =
    moved.after === 'approved'
      ? `${commit}, which Quality approved: it changed on GitHub since Quality's review.`
      : `${commit}, the commit you skipped the review of.`;
  const sentence = `Pull request #${String(pullRequest)}'s head on GitHub is now ${short(moved.head)}, not ${which}`;
  const comparison = moved.comparison;
  if (comparison?.kind === 'ahead') {
    return {
      sentence,
      added: comparison.titles,
      more: comparison.more > 0 ? `and ${String(comparison.more)} more` : null,
      notPart: null,
    };
  }
  if (comparison?.kind === 'not_part') {
    const named =
      moved.after === 'approved'
        ? `${commit}, which Quality approved,`
        : `${commit}, the commit you skipped the review of,`;
    return {
      sentence,
      added: [],
      more: null,
      notPart: `${named} is no longer part of pull request #${String(pullRequest)}: its history was rewritten on GitHub.`,
    };
  }
  return { sentence, added: [], more: null, notPart: null };
}

/**
 * The watch could not read the pull request (owner's note on step J1): the merge is not found
 * while it lasts.
 */
export function watchFailureText(failure: PullRequestWatchFailure): string {
  return `GitHub could not be checked for this pull request at ${formatDateTime(failure.at)} (since ${formatDateTime(failure.since)}): ${ciProblemReason(failure)}. A merge is not found while this lasts; the Orchestrator asks again at each GitHub check.`;
}

/** "Pull request to merge" in "Needs you" (02, section 4; lot 3 step J4a). */
export function toMergeText(item: ToMergeItem): {
  title: string;
  review: string;
  ci: string;
  workflows: string | null;
  merge: string;
} {
  const ref = ticketRef(item.ticket.projectKey, item.ticket.number);
  const review =
    item.review === null
      ? 'No review by Quality is recorded for this work: check the pull request yourself before merging it.'
      : item.review.kind === 'approved'
        ? `Quality approved commit ${short(item.review.commit)} at ${formatDateTime(item.review.at)}.`
        : `Review skipped: you skipped Quality's review at ${formatDateTime(item.review.at)}. Check the pull request yourself before merging it.`;
  const noCiWithWorkflows = item.ci?.result === 'no_ci' && item.workflowFlag === 'changed';
  return {
    title: `Pull request to merge: ${ref} ${item.ticket.title}`,
    review,
    ci:
      item.ci === null
        ? 'No CI result is recorded for this work.'
        : ciLine(item.ci.result, item.ci.commit, item.ci.checkedAgainAt, item.workflowFlag),
    workflows: workflowLine(item.workflowFlag, noCiWithWorkflows),
    merge: `Merge it on GitHub: ${ref} moves to Done by itself when the Orchestrator finds the merge, at its next GitHub check.`,
  };
}

/**
 * "GitHub refused to reopen it: <reason>." (GitHub's words) and, its branch gone, what happens
 * next; a failure that is not GitHub's refusal (not reached, the token, the request limit) says
 * why it was not reopened.
 */
export function reopenFailureText(ref: string, failure: PullRequestReopenFailure): string {
  const refusedByGitHub =
    failure.reason === 'refused' ||
    (failure.reason === 'permission_missing' && failure.permission === null);
  const said = refusedByGitHub
    ? `GitHub refused to reopen it: ${failure.message.trim().replace(/\.$/, '')}.`
    : `Not reopened: ${pullRequestFailureText(ref, failure, null).reason}. Try again later.`;
  return failure.branchGone
    ? `${said} Its branch is gone from GitHub. The next accepted submission opens a new pull request.`
    : said;
}

function unchanged(status: TicketStatus): string {
  return `The ticket is unchanged (${statusLabel[status]}).`;
}

/**
 * The closed item (owner's answers 1 and 4 of step J): closed without merging, with **Reopen pull
 * request** and **Cancel ticket**; merged into another base, with **Cancel ticket** and **Mark as
 * done manually**, since GitHub never reopens a merged pull request.
 */
export function closedItemText(item: ClosedItem): {
  title: string;
  detail: string;
  reopenFailure: string | null;
} {
  const ref = ticketRef(item.ticket.projectKey, item.ticket.number);
  const pull = `Pull request #${String(item.pullRequest.number)}`;
  const at = formatDateTime(item.since);
  if (item.mergedInto !== null) {
    return {
      title: `Pull request merged into ${item.mergedInto} for ${ref}: ${item.ticket.title}`,
      detail: `${pull} was merged into ${item.mergedInto} on GitHub at ${at}, not into the project's default branch, so the work is not done. ${unchanged(item.status)} GitHub never reopens a merged pull request: the next accepted submission opens a new pull request into the default branch. If the work is done this way, mark the ticket as done; if not, cancel it.`,
      reopenFailure: null,
    };
  }
  return {
    title: `Pull request closed without merging for ${ref}: ${item.ticket.title}`,
    detail: `${pull} was closed on GitHub at ${at} without merging. ${unchanged(item.status)}`,
    reopenFailure: item.reopenFailure === null ? null : reopenFailureText(ref, item.reopenFailure),
  };
}

/** Whether a ticket still goes on: neither done nor cancelled. */
function goesOn(status: TicketStatus): boolean {
  return status !== 'done' && status !== 'cancelled';
}

/**
 * The closed state on the ticket page (02, section 6.4; lot 3 step J4b): closed on GitHub, with
 * the closed item's words while the ticket goes on, or closed by the Orchestrator at **Cancel**,
 * which a reopened ticket keeps until its next accepted submission. GitHub's time when it gave one.
 */
export function closedStateText(
  closed: NonNullable<TicketPullRequest['closed']>,
  pullRequest: number,
  ref: string,
  status: TicketStatus,
): string {
  const pull = `Pull request #${String(pullRequest)}`;
  const at = closed.at === null ? '' : ` at ${formatDateTime(closed.at)}`;
  if (closed.by === 'github') {
    const said = `${pull} was closed on GitHub${at} without merging.`;
    return goesOn(status)
      ? `${said} ${unchanged(status)} Reopen it to go on with this pull request, or cancel the ticket.`
      : said;
  }
  const said = `${pull} was closed on GitHub${at} without merging, since ${ref} was cancelled.`;
  return goesOn(status)
    ? `${said} ${ref} was reopened since: the pull request stays closed until the next accepted submission, which reopens it.`
    : said;
}

/**
 * **Cancel**'s close not done yet (lot 3 step J4b): under way, or failed with the reason and when,
 * tried again at each GitHub check (no fixed duration: the interval is a setting).
 */
export function closeWantedText(
  close: NonNullable<TicketPullRequest['close']>,
  pullRequest: number,
  ref: string,
): { sentence: string; where: 'tokens' | 'settings' | null } {
  const pull = `Pull request #${String(pullRequest)}`;
  const cancelled = `${ref} was cancelled at ${formatDateTime(close.since)}`;
  const failure = close.failure;
  if (failure === null) {
    return {
      sentence: `Closing pull request #${String(pullRequest)} on GitHub, since ${cancelled}.`,
      where: null,
    };
  }
  const refusedByGitHub =
    failure.reason === 'refused' ||
    (failure.reason === 'permission_missing' && failure.permission === null);
  const { reason, where } = pullRequestFailureText(ref, failure, null);
  const why = refusedByGitHub
    ? `GitHub refused it: ${failure.message.trim().replace(/\.$/, '')}`
    : reason;
  return {
    sentence: `${pull} not closed on GitHub yet, though ${cancelled}: at ${formatDateTime(failure.at)}, ${why}. The Orchestrator tries again at each GitHub check.`,
    where,
  };
}
