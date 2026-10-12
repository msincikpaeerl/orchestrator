import type { ChangeRequest, ReviewDecision, RunCiOutcome } from '@orchestrator/protocol';
import { timestamp } from '../agents/messages.js';

// The `system` comment of a pull request found merged (04, section 2; owner's answer 2, lot 3
// step J1): when GitHub merged it and its head then (the merged head, never the merge commit),
// the run it stopped, what CI said of the merged head, and Quality's review of it. Facts only,
// read in the merge's transaction.

const short = (commit: string) => commit.slice(0, 7);

/** What the ticket's review came to, as the merge found it. */
export type MergeReview =
  /** Quality's approval, applied: the ticket was on **Awaiting merge**. */
  | { kind: 'approved'; commit: string }
  /** The owner's **Skip review** of the work then accepted. */
  | { kind: 'skipped'; commit: string | null }
  /** A decision a review run gave and the merge stopped before it was applied. */
  | { kind: 'not_applied'; decision: ReviewDecision }
  /** A request for changes not answered by an accepted submission yet. */
  | { kind: 'request_standing'; request: ChangeRequest }
  /** No decision on the merged work. */
  | { kind: 'none' };

export interface MergeFacts {
  number: number;
  reference: string;
  /** GitHub's time of the merge. */
  mergedAt: Date;
  /** The pull request's head when it was merged. */
  head: string;
  /** The machine of the active run the merge stopped; null when none was active. */
  stoppedOn: string | null;
  /** The latest CI outcome of the ticket's work; null when none was read. */
  ci: RunCiOutcome | null;
  review: MergeReview;
}

/** What CI said of the merged head. */
function ciLine(ci: RunCiOutcome | null, head: string): string {
  if (ci === null) return 'CI had not passed for this work: no CI result was read for it.';
  const commit = short(ci.commit);
  const accepted =
    ci.acceptedLater?.state ?? (ci.kind === 'passed' || ci.kind === 'no_ci' ? ci.kind : null);
  if (accepted !== null) {
    if (ci.commit !== head) {
      return `The merged head is not the commit CI checked (${commit}): the Orchestrator's CI result does not cover it.`;
    }
    return accepted === 'passed'
      ? 'CI passed for this commit.'
      : 'No CI was found for this commit: nothing was tested on GitHub.';
  }
  return `CI had not passed for this work: ${notPassed(ci)}.`;
}

/** Why the latest CI outcome did not accept the work, in a few words. */
function notPassed(ci: RunCiOutcome): string {
  const commit = short(ci.commit);
  switch (ci.kind) {
    case 'waiting':
      return `CI was still being checked for ${commit}`;
    case 'not_finished':
      return `CI had not finished for ${commit} when CI wait at submission was reached`;
    case 'conflict':
      return `${commit} conflicted with the base branch`;
    case 'cancelled':
      return `the CI runs of ${commit} were cancelled on GitHub`;
    default:
      return `CI failed for ${commit}`;
  }
}

/** Quality's review of the merged head. */
function reviewLine(review: MergeReview, head: string): string {
  switch (review.kind) {
    case 'approved':
      return review.commit === head
        ? 'Quality approved this commit.'
        : `Quality approved ${short(review.commit)}, not the merged head.`;
    case 'skipped':
      return review.commit === null
        ? 'You skipped the review.'
        : `You skipped the review of ${short(review.commit)}.`;
    case 'not_applied': {
      const { decision } = review;
      return decision.kind === 'approved'
        ? `Quality had approved ${short(decision.commit)} just before the merge; that decision was not applied.`
        : `Quality had asked for changes on ${short(decision.commit)} just before the merge; that decision was not applied.`;
    }
    case 'request_standing': {
      const { request } = review;
      const on = request.commit === null ? '' : ` on ${short(request.commit)}`;
      return request.by === 'quality'
        ? `Quality's request for changes${on} was not addressed.`
        : `Your request for changes${on} was not addressed.`;
    }
    case 'none':
      return "It was merged before Quality's review.";
  }
}

/** The comment of a merge that moved the ticket to `done`. */
export function mergeComment(facts: MergeFacts): string {
  return [
    `Pull request #${String(facts.number)} was merged on GitHub at ${timestamp(facts.mergedAt)} (head ${short(facts.head)}).`,
    ...(facts.stoppedOn === null ? [] : [`The run on ${facts.stoppedOn} was stopped.`]),
    ciLine(facts.ci, facts.head),
    reviewLine(facts.review, facts.head),
  ].join(' ');
}

/** The comment of a merge found after **Mark as done manually** (owner's answer 2). */
export function mergedAfterDoneComment(
  facts: Pick<MergeFacts, 'number' | 'reference' | 'mergedAt' | 'head'>,
): string {
  return `Pull request #${String(facts.number)} was merged on GitHub at ${timestamp(facts.mergedAt)} (head ${short(facts.head)}), after you marked ${facts.reference} as done.`;
}

/** The comment of a merge found on a cancelled ticket: it stays cancelled (the cancel race B). */
export function mergedAfterCancelComment(
  facts: Pick<MergeFacts, 'number' | 'reference' | 'mergedAt' | 'head'>,
): string {
  return `Pull request #${String(facts.number)} was merged on GitHub at ${timestamp(facts.mergedAt)} (head ${short(facts.head)}), after ${facts.reference} was cancelled. The ticket stays cancelled: to record it as done, use Reopen, then Mark as done manually.`;
}
