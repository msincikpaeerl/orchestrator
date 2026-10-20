import type {
  TicketChangeRequest,
  TicketReviewLatest,
  TicketStatus,
  TicketStop,
} from '@orchestrator/protocol';
import { formatDateTime } from '../github/text';

// Changes after a review in the owner's words (02, sections 4 and 6.4; owner's answers 2, 6 and
// 7, lot 3 step I, and 2 to 4, step I2), made from the facts the API gives: the line in To do
// while a request stands, the review section after the owner's request on Awaiting merge, the
// Request changes dialog, and the stop with **Try again**.

/**
 * The line in To do while a request stands. Quality's request made before **Try again** or
 * **Reopen** (its round above the ticket's review rounds, which count from 0 again) has no round.
 */
export function todoRequestText(
  change: TicketChangeRequest | null,
  reviewRounds: number,
): string | null {
  if (change === null || !change.standing) return null;
  const { request } = change;
  if (request.by === 'owner') return 'Run now starts a run that addresses your request.';
  return request.round > reviewRounds
    ? "Run now starts a run that addresses Quality's points."
    : `Run now starts a run that addresses Quality's points (round ${String(request.round)} of at most ${String(change.limit)}).`;
}

/** Under the approval or the skip, while the owner's request on Awaiting merge stands. */
export function requestedAfterText(change: TicketChangeRequest | null): string | null {
  if (change === null || !change.standing || change.request.by !== 'owner') return null;
  const { after, at } = change.request;
  if (after === null) return null;
  return after === 'approved'
    ? `You requested changes after this approval, at ${formatDateTime(at)}.`
    : `You requested changes after skipping the review, at ${formatDateTime(at)}.`;
}

/** The Request changes dialog's text: on Awaiting merge, what the request comes after. */
export function requestChangesText(
  status: TicketStatus,
  latest: TicketReviewLatest | null,
): string {
  if (status !== 'awaiting_merge') {
    return 'The ticket goes back to To do with your comment. Its branch and commits are kept, and the next run continues from them with your comment in its instructions. This does not count as a failed attempt.';
  }
  return awaitingMergeRequestText(
    latest?.kind === 'decision'
      ? { kind: 'approved', commit: latest.decision.commit }
      : latest?.kind === 'skipped'
        ? { kind: 'skipped' }
        : null,
  );
}

/**
 * The Request changes dialog's sentence for a request that contradicts an acceptance criterion
 * (04, section 2; owner's answer 14, lot 4 step A): the criteria stay as written until the owner
 * edits them, which **Edit** allows once the ticket is back in To do. Help > Tickets says the same.
 */
export function contradictingCriterionText(ref: string): string {
  return `If your request contradicts one of the acceptance criteria, edit that criterion too: once ${ref} is back in To do, use Edit on its page. Until then, the agent does what your request asks and says so when it reports on that criterion.`;
}

/**
 * The dialog's hold box (owner's new answer 2, lot 4 step A; 02, section 6.4): unchecked, the fix
 * starts by itself; checked, the ticket is held until Run now.
 */
export function holdBoxText(ref: string): { label: string; hint: string } {
  return {
    label: `Hold ${ref} so I can edit its acceptance criteria first`,
    hint: `The scheduler then does not start the fix until you use Run now on ${ref}.`,
  };
}

/** What **Request changes** does on **Awaiting merge**, naming the approval or the skip. */
export function awaitingMergeRequestText(
  review: { kind: 'approved'; commit: string } | { kind: 'skipped' } | null,
): string {
  const after =
    review?.kind === 'approved'
      ? `Quality approved commit ${review.commit.slice(0, 7)}. `
      : review?.kind === 'skipped'
        ? 'You skipped the review. '
        : '';
  return `${after}The ticket goes back to To do with your comment, and its next run addresses it; the pull request stays open.`;
}

/** The stop, the same on the ticket page and in "Needs you" (owner's answer 2, step I2). */
export function stopText(stop: Pick<TicketStop, 'cause' | 'count' | 'limit' | 'at'>): {
  title: string;
  detail: string;
  tryAgain: string;
  since: string;
} {
  const review = stop.cause === 'review_rounds';
  return {
    title: review ? 'Stopped after too many review rounds' : 'Stopped after repeated failures',
    detail: `${
      review
        ? `Quality requested changes ${String(stop.count)} times, more than Most review rounds per ticket allows (${String(stop.limit)}).`
        : `It failed ${stop.count === 1 ? 'once' : `${String(stop.count)} times`}, ${stop.count > stop.limit ? 'more than' : 'as many as'} Failed attempts before asking you allows (${String(stop.limit)}).`
    } Use Try again to let it continue, or Cancel it, or Mark it as done manually.`,
    tryAgain:
      'Try again starts no session: the review rounds and failed attempts count from 0 again, and Run now can start the next run.',
    since: `Since ${formatDateTime(stop.at)}`,
  };
}

/** The confirmation offering **Run now** after **Try again** (owner's answer 3, step I2). */
export const RUN_NOW_AFTER_TRY_AGAIN =
  'The review rounds and failed attempts count from 0 again. Start the next run now, or later from the ticket page.';
